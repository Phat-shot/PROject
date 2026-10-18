import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { requireProject, requireTask } from '../rights.js';
import { touchTask } from '../tasks/service.js';

function mapEntry(r: any) {
  return { id: r.id, projectId: r.project_id, taskId: r.task_id, taskTitle: r.task_title ?? null, userId: r.user_id, userName: r.user_name ?? null, date: typeof r.date === 'string' ? r.date.slice(0, 10) : new Date(r.date).toISOString().slice(0, 10), minutes: r.minutes, note: r.note, createdAt: r.created_at };
}

/** Zeiterfassung: optionales Modul je Projekt. Buchungen je Arbeitspaket oder frei, Auswertung je Person, Teilprojekt, Arbeitspaket. */
export async function timeRoutes(app: FastifyInstance) {
  const db = app.db;

  async function ensureEnabled(projectId: string) {
    const p = await db.one(`select time_tracking_enabled from projects where id = $1`, [projectId]);
    if (!p.time_tracking_enabled) throw badRequest('Zeiterfassung ist in diesem Projekt nicht aktiviert');
  }

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string; userId?: string } }>('/projects/:id/time', async (req) => {
    const user = requireUser(req);
    const m = await requireProject(db, user, req.params.id);
    const { from, to } = req.query;
    // Mitglieder sehen eigene Buchungen, PL alle
    const userFilter = m.role === 'pl' ? req.query.userId ?? null : user.id;
    const rows = await db.query(
      `select e.*, t.title as task_title, u.name as user_name from time_entries e left join tasks t on t.id = e.task_id join users u on u.id = e.user_id
       where e.project_id = $1 and ($2::date is null or e.date >= $2) and ($3::date is null or e.date <= $3) and ($4::uuid is null or e.user_id = $4)
       order by e.date desc, e.created_at desc limit 1000`,
      [req.params.id, from ?? null, to ?? null, userFilter]
    );
    const byUser = await db.query(
      `select u.id as user_id, u.name, sum(e.minutes)::int as minutes from time_entries e join users u on u.id = e.user_id where e.project_id = $1 ${m.role === 'pl' ? '' : 'and e.user_id = $2'} group by u.id, u.name order by minutes desc`,
      m.role === 'pl' ? [req.params.id] : [req.params.id, user.id]
    );
    const bySub = await db.query(
      `select coalesce(s.name, 'Ohne Teilprojekt') as name, sum(e.minutes)::int as minutes, sum(coalesce(t.estimate_minutes, 0))::int as estimate
       from time_entries e left join tasks t on t.id = e.task_id left join subprojects s on s.id = t.subproject_id where e.project_id = $1 group by s.name, s.position order by s.position nulls last`,
      [req.params.id]
    );
    const total = await db.one(`select coalesce(sum(minutes), 0)::int as minutes from time_entries where project_id = $1`, [req.params.id]);
    const estimate = await db.one(`select coalesce(sum(estimate_minutes), 0)::int as minutes from tasks where project_id = $1 and archived_at is null`, [req.params.id]);
    const project = await db.one(`select budget_hours, time_tracking_enabled from projects where id = $1`, [req.params.id]);
    return {
      enabled: project.time_tracking_enabled,
      entries: rows.rows.map(mapEntry),
      byUser: byUser.rows.map((r: any) => ({ userId: r.user_id, name: r.name, minutes: r.minutes })),
      bySubproject: bySub.rows.map((r: any) => ({ name: r.name, minutes: r.minutes, estimateMinutes: r.estimate })),
      totalMinutes: m.role === 'pl' ? total.minutes : null,
      estimateMinutes: estimate.minutes,
      budgetHours: project.budget_hours ? Number(project.budget_hours) : null
    };
  });

  app.post<{ Params: { id: string }; Body: { taskId?: string | null; date?: string; minutes: number; note?: string } }>('/projects/:id/time', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'member');
    await ensureEnabled(req.params.id);
    const b = req.body ?? ({} as any);
    const minutes = Number(b.minutes);
    if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 1440) throw badRequest('Minuten zwischen 1 und 1440');
    if (b.taskId) {
      const t = await db.maybeOne(`select id from tasks where id = $1 and project_id = $2`, [b.taskId, req.params.id]);
      if (!t) throw badRequest('Arbeitspaket gehört nicht zum Projekt');
    }
    const r = await db.one(
      `insert into time_entries (project_id, task_id, user_id, date, minutes, note) values ($1,$2,$3,$4,$5,$6) returning *`,
      [req.params.id, b.taskId ?? null, user.id, b.date ?? new Date().toISOString().slice(0, 10), minutes, b.note?.trim() || null]
    );
    if (b.taskId) await touchTask(db, b.taskId);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'time.book', objectType: 'time_entry', objectId: r.id, details: { taskId: b.taskId ?? null, minutes } });
    const full = await db.one(`select e.*, t.title as task_title, u.name as user_name from time_entries e left join tasks t on t.id = e.task_id join users u on u.id = e.user_id where e.id = $1`, [r.id]);
    return { entry: mapEntry(full) };
  });

  app.delete<{ Params: { eid: string } }>('/time/:eid', async (req) => {
    const user = requireUser(req);
    const e = await db.maybeOne(`select * from time_entries where id = $1`, [req.params.eid]);
    if (!e) throw notFound('Buchung nicht gefunden');
    const m = await requireProject(db, user, e.project_id, 'member');
    if (e.user_id !== user.id && m.role !== 'pl') throw forbidden('Nur eigene Buchungen oder als PL');
    await db.query(`delete from time_entries where id = $1`, [e.id]);
    await audit(db, { orgId: user.orgId, projectId: e.project_id, userId: user.id, action: 'time.delete', objectType: 'time_entry', objectId: e.id, details: { minutes: e.minutes, of: e.user_id } });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/tasks/:id/time', async (req) => {
    const user = requireUser(req);
    await requireTask(db, user, req.params.id);
    const rows = await db.query(`select e.*, u.name as user_name from time_entries e join users u on u.id = e.user_id where e.task_id = $1 order by e.date desc, e.created_at desc`, [req.params.id]);
    return { entries: rows.rows.map(mapEntry), totalMinutes: rows.rows.reduce((a: number, r: any) => a + r.minutes, 0) };
  });

  // Meine Woche über alle Projekte
  app.get<{ Querystring: { from?: string; to?: string } }>('/my/time', async (req) => {
    const user = requireUser(req);
    const to = req.query.to ?? new Date().toISOString().slice(0, 10);
    const from = req.query.from ?? new Date(Date.now() - 6 * 86400_000).toISOString().slice(0, 10);
    const rows = await db.query(
      `select e.*, t.title as task_title, p.key as project_key from time_entries e left join tasks t on t.id = e.task_id join projects p on p.id = e.project_id
       where e.user_id = $1 and e.date >= $2 and e.date <= $3 order by e.date desc, e.created_at desc`,
      [user.id, from, to]
    );
    return { from, to, entries: rows.rows.map((r: any) => ({ ...mapEntry(r), projectKey: r.project_key })), totalMinutes: rows.rows.reduce((a: number, r: any) => a + r.minutes, 0) };
  });
}
