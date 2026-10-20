import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ReportingPolicy } from '@projekttool/shared';
import { DEFAULT_REPORTING as SHARED_DEFAULT_REPORTING } from '@projekttool/shared';
import type { Db } from '../db.js';
import type { MailService } from '../mail/service.js';
import { audit } from '../audit.js';
import { notifyMany } from '../notify.js';
import { loadTasks, resolveProjectLead } from '../tasks/service.js';
import { evaluateProject, LEVEL_LABEL } from '../tasks/escalation.js';
import { htmlToMd, sanitizeHtml } from './html.js';
import { htmlToPdf } from './pdfHtml.js';
import { folderName, layoutFor, loadTemplate, templateHtml, uploadDir } from './layout.js';
import { projectAccount } from '../mail/accounts.js';

/**
 * Reporting (Regel vor KI): Im eingestellten Rhythmus erzeugt der Worker aus der Vorlage eine Doku-Seite,
 * ergänzt sie um Kennzahlen aus dem Projekt und versendet sie als PDF über das Projektkonto an den
 * Empfängerkreis. Modus „proposal“: Seite bleibt Entwurf, PL wird benachrichtigt und versendet nach Prüfung.
 */
export const DEFAULT_REPORTING: ReportingPolicy = SHARED_DEFAULT_REPORTING;

export function reportingOf(raw: any): ReportingPolicy {
  const p = { ...DEFAULT_REPORTING, ...(raw ?? {}) };
  if (!Array.isArray(p.recipients)) p.recipients = [];
  if (!['weekly', 'biweekly', 'monthly'].includes(p.interval)) p.interval = 'weekly';
  if (!['proposal', 'direct'].includes(p.mode)) p.mode = 'proposal';
  return p;
}

/** ISO-Wochentag (1 = Montag … 7 = Sonntag) */
function isoWeekday(date: string): number {
  const d = new Date(date + 'T00:00:00Z').getUTCDay();
  return d === 0 ? 7 : d;
}

export function isoWeek(date: string): { week: number; year: number } {
  const d = new Date(date + 'T00:00:00Z');
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return { week: Math.ceil(((d.getTime() - yearStart) / 86400_000 + 1) / 7), year: d.getUTCFullYear() };
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86400_000);
}

/** Fällig heute? Einmal pro Tag, wöchentlich/zweiwöchentlich am Wochentag, monatlich am Tag (Monatsende wird abgefangen). */
export function isReportDue(p: ReportingPolicy, today: string): boolean {
  if (!p.enabled || p.lastRunOn === today) return false;
  if (p.interval === 'monthly') {
    const d = new Date(today + 'T00:00:00Z');
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    return d.getUTCDate() === Math.min(p.dayOfMonth, lastDay);
  }
  if (isoWeekday(today) !== p.weekday) return false;
  if (p.interval === 'biweekly' && p.lastRunOn && daysBetween(p.lastRunOn, today) < 13) return false;
  return true;
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** Kennzahlen-Block aus dem Regelwerk: Fortschritt, Verzug, Blockaden, Eskalationen, Meilensteine. */
export async function reportFactsHtml(db: Db, projectId: string, today: string, since: string | null): Promise<string> {
  const tasks = await loadTasks(db, `t.project_id = $1 and t.archived_at is null`, [projectId]);
  const open = tasks.filter((t) => !t.done);
  const overdue = open.filter((t) => t.dueDate && t.dueDate < today).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
  const blocked = open.filter((t) => t.blocked);
  const doneSince = since ? (await db.query(`select title from tasks t join board_columns c on c.id = t.column_id where t.project_id = $1 and c.is_done and t.updated_at >= $2::date order by t.updated_at desc limit 15`, [projectId, since])).rows : [];
  const milestones = await db.query(`select name, date from milestones where project_id = $1 and date >= $2 order by date limit 5`, [projectId, today]);
  const escalations = await evaluateProject(db, projectId, today).catch(() => []);
  const time = await db.maybeOne(`select coalesce(sum(minutes),0)::int as m from time_entries where project_id = $1 ${since ? 'and date >= $2::date' : ''}`, since ? [projectId, since] : [projectId]).catch(() => null);
  const pct = tasks.length ? Math.round(((tasks.length - open.length) / tasks.length) * 100) : 0;
  const li = (xs: string[]) => (xs.length ? `<ul>${xs.map((x) => `<li>${x}</li>`).join('')}</ul>` : '<p>–</p>');
  return `<h2>Kennzahlen (automatisch, Stand ${esc(new Date(today + 'T00:00:00Z').toLocaleDateString('de-DE'))})</h2>
<table><tbody>
<tr><td>Arbeitspakete gesamt / offen / erledigt</td><td>${tasks.length} / ${open.length} / ${tasks.length - open.length} (${pct} %)</td></tr>
<tr><td>Überfällig</td><td>${overdue.length}</td></tr>
<tr><td>Blockiert</td><td>${blocked.length}</td></tr>
<tr><td>Eskalationen</td><td>${escalations.filter((e) => e.targetLevel > 0).length}</td></tr>
${time ? `<tr><td>Gebuchte Zeit${since ? ' seit letztem Bericht' : ''}</td><td>${Math.floor(time.m / 60)}:${String(time.m % 60).padStart(2, '0')} h</td></tr>` : ''}
</tbody></table>
<h3>Erledigt${since ? ' seit letztem Bericht' : ''}</h3>${li(doneSince.map((r: any) => esc(r.title)))}
<h3>Überfällig</h3>${li(overdue.slice(0, 10).map((t) => `${esc(t.title)} (fällig ${esc(t.dueDate)}, ${esc(t.responsible.name ?? t.responsible.email ?? '–')})`))}
<h3>Blockiert</h3>${li(blocked.map((t) => `${esc(t.title)}${t.blockedReason ? `: ${esc(t.blockedReason)}` : ''}`))}
<h3>Eskalationen</h3>${li(escalations.filter((e) => e.targetLevel > 0).map((e) => `${esc(e.title)} – ${esc(LEVEL_LABEL[e.targetLevel])} (${esc(e.reason)})`))}
<h3>Nächste Meilensteine</h3>${li(milestones.rows.map((m: any) => `${esc(String(m.date).slice(0, 10))} – ${esc(m.name)}`))}`;
}

export interface ReportResult { pageId: string; title: string; sent: boolean; to: string[]; status: 'final' | 'draft'; error?: string }

/** Bericht erzeugen (und je nach Modus versenden). userId = auslösender Benutzer bei manuellem Lauf, sonst PL. */
export async function createReport(db: Db, mail: MailService, projectId: string, opts: { today?: string; userId?: string | null; manual?: boolean } = {}): Promise<ReportResult> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const pr = await db.one(`select * from projects where id = $1`, [projectId]);
  const p = reportingOf(pr.reporting);
  const lead = await resolveProjectLead(db, projectId);
  const actor = opts.userId ?? lead.userId ?? null;
  const tpl = await loadTemplate(db, p.templateKey, pr.org_id);
  const { week, year } = isoWeek(today);
  const title = `${tpl?.name ?? 'Statusbericht'} ${pr.key} KW ${String(week).padStart(2, '0')}/${year}`;
  let parent = p.parentPageId ? await db.maybeOne(`select id, folder_id from doc_pages where id = $1 and project_id = $2`, [p.parentPageId, projectId]) : null;
  const folder = parent?.folder_id ?? (await db.maybeOne(`select id from doc_folders where project_id = $1 and lower(name) like 'bericht%' order by position limit 1`, [projectId]))?.id ?? (await db.maybeOne(`select id from doc_folders where project_id = $1 order by position limit 1`, [projectId]))?.id ?? null;
  const html = sanitizeHtml(`${tpl ? templateHtml(tpl) : '<h1>Statusbericht</h1>'}${await reportFactsHtml(db, projectId, today, p.lastRunOn)}`);
  const direct = p.mode === 'direct';
  const page = await db.one(
    `insert into doc_pages (project_id, folder_id, parent_page_id, title, content_md, content_html, template_key, settings, status, finalized_at, created_by, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) returning *`,
    [projectId, folder, parent?.id ?? null, title, htmlToMd(html), html, p.templateKey, JSON.stringify({ kind: null, recipients: p.recipients, report: { generatedOn: today, mode: p.mode } }), direct ? 'final' : 'draft', direct ? new Date() : null, actor]
  );
  await db.query(`insert into doc_page_versions (page_id, version, title, content_md, content_html, status, saved_by) values ($1,1,$2,$3,$4,$5,$6)`, [page.id, title, page.content_md, html, page.status, actor]);
  await db.query(`update projects set reporting = $2 where id = $1`, [projectId, JSON.stringify({ ...p, lastRunOn: today, lastPageId: page.id })]);
  await audit(db, { orgId: pr.org_id, projectId, userId: opts.manual ? actor : null, action: 'report.create', objectType: 'doc_page', objectId: page.id, details: { title, mode: p.mode, recipients: p.recipients, manual: Boolean(opts.manual) } });
  const pls = (await db.query(`select user_id from project_members where project_id = $1 and role = 'pl'`, [projectId])).rows.map((r: any) => r.user_id);
  const link = `/projekte/${projectId}/doku/${page.id}`;
  if (!direct) {
    await notifyMany(db, pls, { projectId, type: 'report.review', title: `Bericht zur Prüfung: ${title}`, body: p.recipients.length ? `Nach Prüfung „Final setzen“ und an ${p.recipients.join(', ')} senden.` : 'Kein Empfängerkreis hinterlegt.', link, ref: { type: 'page', id: page.id }, dedupeKey: `report:${page.id}` });
    return { pageId: page.id, title, sent: false, to: p.recipients, status: 'draft' };
  }
  const account = await projectAccount(db, projectId);
  if (!account || p.recipients.length === 0) {
    const error = !account ? 'Kein Projektkonto für den Versand' : 'Kein Empfängerkreis hinterlegt';
    await notifyMany(db, pls, { projectId, type: 'report.failed', title: `Bericht erzeugt, nicht versendet: ${title}`, body: error, link, ref: { type: 'page', id: page.id }, dedupeKey: `reportfail:${page.id}` });
    return { pageId: page.id, title, sent: false, to: p.recipients, status: 'final', error };
  }
  try {
    const pdf = await htmlToPdf(db, html, { title, project: pr.name, version: 1, status: 'final', author: lead.name ?? 'Projektleitung', date: new Date(), folder: await folderName(db, folder) }, await layoutFor(db, page.id));
    const filename = `${title.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80)}_v1.pdf`;
    const r = await mail.sendFromAccount(account, {
      to: p.recipients, subject: title,
      text: `Guten Tag,\n\nanbei der aktuelle Bericht „${title}“ aus dem Projekt „${pr.name}“ als PDF.\n\nMit freundlichen Grüßen\n${lead.name ?? 'Projektleitung'}`,
      userId: actor ?? lead.userId!, projectId, attachments: [{ filename, content: pdf, contentType: 'application/pdf' }]
    });
    await mkdir(uploadDir, { recursive: true });
    const storage = path.join(uploadDir, `${randomUUID()}.pdf`);
    await writeFile(storage, pdf);
    await db.query(`insert into attachments (project_id, page_id, filename, mime, size, storage_path, uploaded_by) values ($1,$2,$3,'application/pdf',$4,$5,$6)`, [projectId, page.id, filename, pdf.length, storage, actor]);
    await audit(db, { orgId: pr.org_id, projectId, userId: opts.manual ? actor : null, action: 'report.sent', objectType: 'doc_page', objectId: page.id, details: { to: p.recipients, messageId: r.messageId, pdf: filename } });
    await notifyMany(db, pls, { projectId, type: 'report.sent', title: `Bericht versendet: ${title}`, body: `An ${p.recipients.join(', ')}`, link, ref: { type: 'page', id: page.id }, dedupeKey: `reportsent:${page.id}` });
    return { pageId: page.id, title, sent: true, to: p.recipients, status: 'final' };
  } catch (e: any) {
    const error = String(e?.message ?? e);
    await notifyMany(db, pls, { projectId, type: 'report.failed', title: `Berichtsversand fehlgeschlagen: ${title}`, body: error, link, ref: { type: 'page', id: page.id }, dedupeKey: `reportfail:${page.id}` });
    await audit(db, { orgId: pr.org_id, projectId, userId: null, action: 'report.failed', objectType: 'doc_page', objectId: page.id, details: { error } });
    return { pageId: page.id, title, sent: false, to: p.recipients, status: 'final', error };
  }
}

/** Täglicher Lauf: alle aktiven Projekte mit fälligem Reporting. */
export async function runReports(db: Db, mail: MailService, today = new Date().toISOString().slice(0, 10)): Promise<ReportResult[]> {
  const rows = await db.query(`select id, reporting from projects where status = 'active' and reporting->>'enabled' = 'true'`);
  const out: ReportResult[] = [];
  for (const r of rows.rows) {
    if (!isReportDue(reportingOf(r.reporting), today)) continue;
    try { out.push(await createReport(db, mail, r.id, { today })); } catch (e) { console.error('[reporting]', r.id, e); }
  }
  return out;
}
