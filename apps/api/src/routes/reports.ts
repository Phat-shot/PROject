import type { FastifyInstance } from 'fastify';
import type { ReportBlock, ReportPeriod, User } from '@projekttool/shared';
import { DEFAULT_REPORT_BLOCKS } from '@projekttool/shared';
import { requireUser } from '../auth.js';
import { badRequest } from '../errors.js';
import { requireProject } from '../rights.js';
import { assistAgent } from '../ai/policy.js';
import { audit } from '../audit.js';
import { normalizeBlocks, renderPortfolioReport, renderReportBlocks, d10, type BlockContext } from '../docs/reportBlocks.js';
import { reportingOf } from '../docs/report.js';
import { htmlToPdf } from '../docs/pdfHtml.js';
import { styleFor } from '../docs/layout.js';
import type { PdfStyle } from '../docs/pdf.js';

const PERIODS: ReportPeriod[] = ['since_last', 'week', 'month', 'quarter', 'days'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface PreviewParams { blocks?: ReportBlock[]; textSource?: 'rules' | 'ai'; graphic?: boolean; today?: string; agentId?: string | null }
interface PortfolioParams { projectIds?: string[]; period?: ReportPeriod; days?: number; graphic?: boolean; textSource?: 'rules' | 'ai'; blocks?: ReportBlock[]; today?: string; limit?: number }

/** Query-Parameter (GET …/preview.pdf): blocks und projectIds als JSON, Booleans als true/false. */
function fromQuery(q: Record<string, string | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...q };
  for (const k of ['blocks', 'projectIds']) {
    if (typeof q[k] === 'string') { try { out[k] = JSON.parse(q[k]!); } catch { throw badRequest(`${k}: JSON erwartet`); } }
  }
  if (typeof q.graphic === 'string') out.graphic = q.graphic !== 'false';
  if (typeof q.days === 'string') out.days = Number(q.days);
  if (typeof q.limit === 'string') out.limit = Number(q.limit);
  return out;
}

function todayOf(v: unknown): string {
  if (v == null || v === '') return new Date().toISOString().slice(0, 10);
  if (typeof v !== 'string' || !DATE.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) throw badRequest('today: YYYY-MM-DD');
  return v;
}

const pdfName = (title: string) => `${title.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80)}.pdf`;

/**
 * Berichte: Vorschau des blockbasierten Management-Reports eines Projekts (HTML oder PDF, ohne Seite anzulegen) und der
 * Portfolio-Report über alle sichtbaren aktiven Projekte. KI-Block nur, wenn die Person den Agenten nutzen darf
 * (assist.report), sonst regelbasierter Text mit Hinweis. Der eigentliche Lauf bleibt POST /projects/:id/reporting/run.
 */
export async function reportRoutes(app: FastifyInstance) {
  const db = app.db;

  async function projectPreview(user: User, projectId: string, b: PreviewParams): Promise<{ html: string; title: string; project: any; textSource: 'rules' | 'ai' }> {
    await requireProject(db, user, projectId, 'reader');
    const pr = await db.one(`select id, key, name, reporting from projects where id = $1`, [projectId]);
    const pol = reportingOf(pr.reporting);
    const blocks = normalizeBlocks(b.blocks) ?? pol.blocks ?? DEFAULT_REPORT_BLOCKS;
    if (!blocks.length) throw badRequest('Mindestens ein Block');
    const textSource = b.textSource === 'ai' || b.textSource === 'rules' ? b.textSource : pol.textSource ?? 'rules';
    const graphic = typeof b.graphic === 'boolean' ? b.graphic : pol.graphic !== false;
    const today = todayOf(b.today);
    const ctx: BlockContext = { today, lastRunOn: pol.lastRunOn, graphic, textSource, user, fetchFn: app.fetchFn };
    if (textSource === 'ai' && blocks.some((x) => x.type === 'ai_summary')) {
      try { ctx.cfg = (await assistAgent(db, user, projectId, 'assist.report', b.agentId || null)).cfg; } catch (e: any) { ctx.cfg = null; ctx.aiUnavailable = String(e?.message ?? e); }
    }
    const r = await renderReportBlocks(db, projectId, blocks, ctx);
    return { html: r.html, title: `Management-Report ${pr.key} ${d10(today)}`, project: pr, textSource: r.textSource };
  }

  app.post<{ Params: { id: string }; Body: PreviewParams }>('/projects/:id/reporting/preview', async (req) => {
    const user = requireUser(req);
    const r = await projectPreview(user, req.params.id, req.body ?? {});
    return { html: r.html, title: r.title, textSource: r.textSource };
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string | undefined> }>('/projects/:id/reporting/preview.pdf', async (req, reply) => {
    const user = requireUser(req);
    const r = await projectPreview(user, req.params.id, fromQuery(req.query ?? {}) as PreviewParams);
    const pdf = await htmlToPdf(db, `<h1>${r.title}</h1>${r.html}`, { title: r.title, project: r.project.name, projectId: r.project.id, version: 0, status: 'draft', author: user.name, date: new Date() }, await styleFor(db, r.project.id));
    return reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${pdfName(r.title)}"`).send(pdf);
  });

  /** Sichtbare aktive Projekte (Mitglied oder org-weit sichtbar), optional eingeschränkt auf projectIds. */
  async function portfolio(user: User, b: PortfolioParams) {
    const ids = Array.isArray(b.projectIds) ? b.projectIds.map(String) : null;
    if (ids?.some((x) => !/^[0-9a-f-]{36}$/i.test(x))) throw badRequest('projectIds: UUIDs erwartet');
    const rows = await db.query(
      `select p.id, p.key, p.name, p.health, p.reporting->>'lastRunOn' as last_run_on from projects p left join project_members m on m.project_id = p.id and m.user_id = $1
       where p.org_id = $2 and p.status = 'active' and p.kind = 'project' and (m.user_id is not null or p.visibility = 'org') and ($3::uuid[] is null or p.id = any($3)) order by p.name`,
      [user.id, user.orgId, ids]);
    // Mitgliedschaft über Gruppen und org-weite Sichtbarkeit prüft requireProject; nur Projekte behalten, die die Person lesen darf
    const visible: any[] = [];
    for (const r of rows.rows) { try { await requireProject(db, user, r.id, 'reader'); visible.push(r); } catch { /* nicht lesbar */ } }
    if (b.period !== undefined && !PERIODS.includes(b.period)) throw badRequest('period: since_last, week, month, quarter oder days');
    const today = todayOf(b.today);
    const r = await renderPortfolioReport(db, visible.map((x) => ({ id: x.id, key: x.key, name: x.name, health: x.health, lastRunOn: x.last_run_on })), { today, period: b.period ?? 'month', days: b.days, graphic: b.graphic !== false, blocks: normalizeBlocks(b.blocks), limit: b.limit });
    await audit(db, { orgId: user.orgId, projectId: null, userId: user.id, action: 'report.portfolio', objectType: 'portfolio', objectId: null, details: { projects: visible.length, period: b.period ?? 'month', blocks: (b.blocks ?? []).map((x) => x.type) } });
    return { ...r, title: `Portfolio-Report ${d10(today)}`, projects: visible.map((x) => ({ id: x.id, key: x.key, name: x.name })) };
  }

  app.post<{ Body: PortfolioParams }>('/portfolio/report', async (req) => {
    const user = requireUser(req);
    const r = await portfolio(user, req.body ?? {});
    return { html: r.html, title: r.title, projects: r.projects };
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/portfolio/report.pdf', async (req, reply) => {
    const user = requireUser(req);
    const r = await portfolio(user, fromQuery(req.query ?? {}) as PortfolioParams);
    const o = await db.one(`select name, settings from orgs where id = $1`, [user.orgId]);
    const style: PdfStyle = { company: o.settings?.company ?? o.name, accentColor: o.settings?.accentColor, footerText: o.settings?.footerText };
    const pdf = await htmlToPdf(db, `<h1>${r.title}</h1>${r.html}`, { title: r.title, project: 'Portfolio', version: 0, status: 'final', author: user.name, date: new Date() }, style);
    return reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${pdfName(r.title)}"`).send(pdf);
  });
}
