import type { FastifyInstance } from 'fastify';
import type { ProjectTemplate, ProjectTemplateSpec, ProjectHealth } from '@projekttool/shared';
import { requireUser } from '../auth.js';
import { requireProject } from '../rights.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { dateStr } from '../tasks/service.js';

const COLORS = ['green', 'yellow', 'red'];

export function healthOf(raw: any): ProjectHealth {
  const h = raw ?? {};
  return { color: COLORS.includes(h.color) ? h.color : null, note: h.note ?? null, updatedAt: h.updatedAt ?? null, updatedBy: h.updatedBy ?? null };
}

/** Ampel aus Kennzahlen: rot bei Blockaden/Eskalation ab Stufe 2 oder viel Verzug, gelb bei Verzug oder Konflikten, sonst grün. */
export function computedColor(s: { open: number; overdue: number; blocked: number; escalated: number; dueWeek: number }): 'green' | 'yellow' | 'red' {
  if (s.blocked > 0 || s.escalated > 0 || (s.open > 0 && s.overdue / s.open >= 0.25)) return 'red';
  if (s.overdue > 0) return 'yellow';
  return 'green';
}

const mapTemplate = (r: any): ProjectTemplate => ({ id: r.id, name: r.name, description: r.description ?? null, spec: r.spec ?? {}, createdAt: r.created_at });
const addDays = (iso: string, n: number) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const diffDays = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400_000);

export async function portfolioRoutes(app: FastifyInstance) {
  const db = app.db;

  // ---- Portfolio: alle sichtbaren aktiven Projekte mit Kennzahlen, Ampel und Auslastung
  app.get('/portfolio', async (req) => {
    const user = requireUser(req);
    const today = new Date().toISOString().slice(0, 10);
    const week = addDays(today, 7);
    const rows = await db.query(
      `select p.*, coalesce(m.role, 'reader') as my_role,
         (select u.name from project_members pm join users u on u.id = pm.user_id where pm.project_id = p.id and pm.role = 'pl' order by pm.is_deputy, pm.created_at limit 1) as lead_name,
         (select count(*) from tasks t join board_columns c on c.id = t.column_id where t.project_id = p.id and t.archived_at is null and not c.is_done)::int as open_count,
         (select count(*) from tasks t join board_columns c on c.id = t.column_id where t.project_id = p.id and t.archived_at is null and c.is_done)::int as done_count,
         (select count(*) from tasks t join board_columns c on c.id = t.column_id where t.project_id = p.id and t.archived_at is null and not c.is_done and t.due_date < $3)::int as overdue_count,
         (select count(*) from tasks t join board_columns c on c.id = t.column_id where t.project_id = p.id and t.archived_at is null and not c.is_done and t.due_date >= $3 and t.due_date <= $4)::int as due_week,
         (select count(*) from tasks t join board_columns c on c.id = t.column_id where t.project_id = p.id and t.archived_at is null and not c.is_done and t.blocked)::int as blocked_count,
         (select count(*) from tasks t join board_columns c on c.id = t.column_id where t.project_id = p.id and t.archived_at is null and not c.is_done and t.escalation_level >= 2)::int as escalated_count,
         (select count(*) from raid_items r where r.project_id = p.id and r.kind = 'risk' and r.status <> 'closed' and coalesce(r.probability * r.impact, 0) >= 15)::int as red_risks,
         (select ms.name from milestones ms where ms.project_id = p.id and ms.date >= $3 order by ms.date limit 1) as next_ms_name,
         (select ms.date from milestones ms where ms.project_id = p.id and ms.date >= $3 order by ms.date limit 1) as next_ms_date,
         (select coalesce(sum(minutes), 0) from time_entries e where e.project_id = p.id)::int as logged_minutes,
         (select max(a.created_at) from audit_log a where a.project_id = p.id) as last_activity
       from projects p left join project_members m on m.project_id = p.id and m.user_id = $1
       where p.org_id = $2 and p.status = 'active' and (m.user_id is not null or p.visibility = 'org') order by p.name`,
      [user.id, user.orgId, today, week]
    );
    const projects = rows.rows.map((r: any) => {
      const stats = { open: r.open_count, done: r.done_count, overdue: r.overdue_count, dueWeek: r.due_week, blocked: r.blocked_count, escalated: r.escalated_count, redRisks: r.red_risks };
      return {
        id: r.id, key: r.key, name: r.name, description: r.description, myRole: r.my_role, leadName: r.lead_name ?? null, stats,
        computed: computedColor(stats), health: healthOf(r.health),
        nextMilestone: r.next_ms_name ? { name: r.next_ms_name, date: dateStr(r.next_ms_date) } : null,
        budgetHours: r.budget_hours == null ? null : Number(r.budget_hours), loggedMinutes: r.logged_minutes, timeTrackingEnabled: Boolean(r.time_tracking_enabled),
        lastActivity: r.last_activity ?? null
      };
    });
    const ids = projects.map((p) => p.id);
    const load = ids.length ? await db.query(
      `select u.id, u.name, p.key, count(*)::int as open, count(*) filter (where t.due_date < $2)::int as overdue
       from tasks t join board_columns c on c.id = t.column_id join projects p on p.id = t.project_id join users u on u.id = t.responsible_user_id
       where t.project_id = any($1) and t.archived_at is null and not c.is_done group by u.id, u.name, p.key order by u.name, p.key`,
      [ids, today]
    ) : { rows: [] as any[] };
    const workload = new Map<string, { userId: string; name: string; open: number; overdue: number; perProject: { key: string; open: number }[] }>();
    for (const r of load.rows) {
      const w = workload.get(r.id) ?? { userId: r.id, name: r.name, open: 0, overdue: 0, perProject: [] as { key: string; open: number }[] };
      w.open += r.open; w.overdue += r.overdue; w.perProject.push({ key: r.key, open: r.open });
      workload.set(r.id, w);
    }
    return { projects, workload: [...workload.values()].sort((a, b) => b.open - a.open) };
  });

  // Ampel setzen (PL)
  app.put<{ Params: { id: string }; Body: { color: 'green' | 'yellow' | 'red' | null; note?: string | null } }>('/projects/:id/health', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'pl');
    const b = req.body ?? ({} as any);
    if (b.color != null && !COLORS.includes(b.color)) throw badRequest('Ampel: green, yellow, red oder null');
    const health: ProjectHealth = { color: b.color ?? null, note: b.note?.trim() || null, updatedAt: new Date().toISOString(), updatedBy: user.name };
    await db.query(`update projects set health = $2 where id = $1`, [req.params.id, JSON.stringify(health)]);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'project.health', objectType: 'project', objectId: req.params.id, details: health as any });
    return { health };
  });

  // ---- Projektvorlagen
  app.get('/project-templates', async (req) => {
    const user = requireUser(req);
    const rows = await db.query(`select * from project_templates where org_id = $1 order by name`, [user.orgId]);
    return { templates: rows.rows.map(mapTemplate) };
  });

  /** Vorlage aus einem bestehenden Projekt: Spalten, Labels, Teilprojekte (relativ zum frühesten Datum), Ordner, Meilensteine, Regeln. */
  app.post<{ Params: { id: string }; Body: { name: string; description?: string } }>('/project-templates/from-project/:id', async (req) => {
    const user = requireUser(req);
    const m = await requireProject(db, user, req.params.id);
    if (m.role !== 'pl' && user.globalRole !== 'org_admin') throw forbidden('Nur PL oder Org-Admin');
    const b = req.body ?? ({} as any);
    if (!b.name?.trim()) throw badRequest('Name erforderlich');
    const p = await db.one(`select * from projects where id = $1`, [req.params.id]);
    const cols = await db.query(`select name, kind, wip_limit from board_columns where project_id = $1 order by position`, [p.id]);
    const labels = await db.query(`select name, color from labels where project_id = $1 order by position, name`, [p.id]);
    const subs = await db.query(`select name, start_date, end_date from subprojects where project_id = $1 order by position`, [p.id]);
    const folders = await db.query(`select name from doc_folders where project_id = $1 and parent_id is null order by position, name`, [p.id]);
    const ms = await db.query(`select name, date from milestones where project_id = $1 order by date`, [p.id]);
    const dates = [...subs.rows.flatMap((s: any) => [dateStr(s.start_date), dateStr(s.end_date)]), ...ms.rows.map((x: any) => dateStr(x.date))].filter(Boolean) as string[];
    const base = dates.length ? dates.reduce((a, c) => (a < c ? a : c)) : null;
    const off = (d: string | null) => (d && base ? diffDays(base, d) : null);
    const spec: ProjectTemplateSpec = {
      columns: cols.rows.map((c: any) => ({ name: c.name, kind: c.kind, wipLimit: c.wip_limit ?? null })),
      labels: labels.rows.map((l: any) => ({ name: l.name, color: l.color })),
      subprojects: subs.rows.map((s: any) => ({ name: s.name, startOffsetDays: off(dateStr(s.start_date)), endOffsetDays: off(dateStr(s.end_date)) })),
      folders: folders.rows.map((f: any) => f.name),
      milestones: ms.rows.map((x: any) => ({ name: x.name, offsetDays: off(dateStr(x.date)) ?? 0 })),
      escalation: p.escalation ?? {}, reminders: p.reminders ?? {}, timeTrackingEnabled: Boolean(p.time_tracking_enabled)
    };
    const r = await db.one(`insert into project_templates (org_id, name, description, spec, created_by) values ($1,$2,$3,$4,$5) returning *`, [user.orgId, b.name.trim(), b.description?.trim() || null, JSON.stringify(spec), user.id]);
    await audit(db, { orgId: user.orgId, projectId: p.id, userId: user.id, action: 'template.create', objectType: 'project_template', objectId: r.id, details: { name: r.name, fromProject: p.key } });
    return { template: mapTemplate(r) };
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; description?: string | null; spec?: ProjectTemplateSpec } }>('/project-templates/:id', async (req) => {
    const user = requireUser(req);
    if (user.globalRole !== 'org_admin') throw forbidden('Nur Org-Admin');
    const b = req.body ?? {};
    const r = await db.maybeOne(`update project_templates set name = coalesce($3, name), description = case when $4 then $5 else description end, spec = coalesce($6::jsonb, spec) where id = $1 and org_id = $2 returning *`,
      [req.params.id, user.orgId, b.name?.trim() || null, 'description' in b, b.description ?? null, b.spec ? JSON.stringify(b.spec) : null]);
    if (!r) throw notFound('Vorlage nicht gefunden');
    return { template: mapTemplate(r) };
  });
  app.delete<{ Params: { id: string } }>('/project-templates/:id', async (req) => {
    const user = requireUser(req);
    if (user.globalRole !== 'org_admin') throw forbidden('Nur Org-Admin');
    await db.query(`delete from project_templates where id = $1 and org_id = $2`, [req.params.id, user.orgId]);
    return { ok: true };
  });
}

/** Vorlage auf ein frisch angelegtes Projekt anwenden (ersetzt Standardspalten und -ordner). */
export async function applyTemplate(db: FastifyInstance['db'], projectId: string, spec: ProjectTemplateSpec, startDate: string) {
  if (spec.columns?.length) {
    await db.query(`delete from board_columns where project_id = $1`, [projectId]);
    for (const [i, c] of spec.columns.entries()) await db.query(`insert into board_columns (project_id, name, position, is_done, kind, wip_limit) values ($1,$2,$3,$4,$5,$6)`, [projectId, c.name, i, c.kind === 'done', c.kind, c.wipLimit ?? null]);
  }
  for (const [i, l] of (spec.labels ?? []).entries()) await db.query(`insert into labels (project_id, name, color, position) values ($1,$2,$3,$4)`, [projectId, l.name, l.color, i]);
  for (const [i, s] of (spec.subprojects ?? []).entries()) await db.query(`insert into subprojects (project_id, name, start_date, end_date, position) values ($1,$2,$3,$4,$5)`, [projectId, s.name, s.startOffsetDays == null ? null : addDays(startDate, s.startOffsetDays), s.endOffsetDays == null ? null : addDays(startDate, s.endOffsetDays), i]);
  if (spec.folders?.length) {
    await db.query(`delete from doc_folders where project_id = $1`, [projectId]);
    for (const [i, name] of spec.folders.entries()) await db.query(`insert into doc_folders (project_id, name, position) values ($1,$2,$3)`, [projectId, name, i]);
  }
  for (const m of spec.milestones ?? []) await db.query(`insert into milestones (project_id, name, date) values ($1,$2,$3)`, [projectId, m.name, addDays(startDate, m.offsetDays)]);
  await db.query(`update projects set escalation = coalesce($2::jsonb, escalation), reminders = coalesce($3::jsonb, reminders), time_tracking_enabled = coalesce($4, time_tracking_enabled) where id = $1`,
    [projectId, spec.escalation ? JSON.stringify(spec.escalation) : null, spec.reminders ? JSON.stringify(spec.reminders) : null, spec.timeTrackingEnabled ?? null]);
}
