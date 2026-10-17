import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import { requireProject, visibleSubprojectSql } from '../rights.js';
import { badRequest } from '../errors.js';
import { dateStr } from '../tasks/service.js';

const LEVEL_LABEL: Record<number, string> = { 0: 'keine', 1: 'Teilprojekt', 2: 'Projektleitung', 3: 'Eskalationskontakt' };
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const day = (v: unknown) => (v ? dateStr(v as any) : null);
const weekKey = (d: Date) => { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const day = x.getUTCDay() || 7; x.setUTCDate(x.getUTCDate() + 4 - day); const y0 = new Date(Date.UTC(x.getUTCFullYear(), 0, 1)); return `${x.getUTCFullYear()}-W${String(Math.ceil(((x.getTime() - y0.getTime()) / 86400_000 + 1) / 7)).padStart(2, '0')}`; };
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * Auswertungen (W9) je Projekt und über Projekte: Durchsatz je Woche (angelegt, erledigt), Durchlaufzeit, Verzug nach
 * Alter, Eskalationen je Zeitraum, gebuchte Zeit je Woche. Zeitraum über from/to (Standard: letzte 12 Wochen).
 * „Erledigt am“ ist der letzte Änderungszeitpunkt eines erledigten Arbeitspakets (kein eigener Zeitstempel).
 */
export async function analyticsRoutes(app: FastifyInstance) {
  const db = app.db;
  const range = (q: { from?: string; to?: string }) => {
    const to = q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? q.to : isoDate(new Date());
    const from = q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : isoDate(new Date(new Date(to + 'T00:00:00Z').getTime() - 12 * 7 * 86400_000));
    if (from > to) throw badRequest('Zeitraum: von liegt nach bis');
    return { from, to };
  };
  const weeks = (from: string, to: string) => { const out: string[] = []; const d = new Date(from + 'T00:00:00Z'); const end = new Date(to + 'T00:00:00Z'); while (d <= end) { const k = weekKey(d); if (out[out.length - 1] !== k) out.push(k); d.setUTCDate(d.getUTCDate() + 1); } return out; };

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>('/projects/:id/analytics', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id);
    const { from, to } = range(req.query);
    const pid = req.params.id;
    const today = isoDate(new Date());
    const tasks = await db.query(
      `select t.id, t.title, t.created_at, t.updated_at, t.due_date, t.priority, t.blocked, t.escalation_level, c.is_done as done, s.name as subproject, u.name as responsible
       from tasks t join board_columns c on c.id = t.column_id left join subprojects s on s.id = t.subproject_id left join users u on u.id = t.responsible_user_id
       where t.project_id = $1 and t.deleted_at is null and t.archived_at is null and ${visibleSubprojectSql(2)}`, [pid, user.id]);
    const rows = tasks.rows as any[];
    const wk = weeks(from, to);
    const series = Object.fromEntries(wk.map((w) => [w, { week: w, created: 0, done: 0, escalations: 0, minutes: 0 }]));
    const inRange = (ts: string | Date) => { const d = isoDate(new Date(ts)); return d >= from && d <= to; };
    const cycle: { title: string; days: number; subproject: string | null }[] = [];
    for (const t of rows) {
      if (inRange(t.created_at)) series[weekKey(new Date(t.created_at))] && series[weekKey(new Date(t.created_at))].created++;
      if (t.done && inRange(t.updated_at)) {
        const k = weekKey(new Date(t.updated_at)); if (series[k]) series[k].done++;
        cycle.push({ title: t.title, days: Math.max(0, Math.round((new Date(t.updated_at).getTime() - new Date(t.created_at).getTime()) / 86400_000)), subproject: t.subproject });
      }
    }
    const esc = await db.query(`select created_at, object_id, details from audit_log where project_id = $1 and action = 'escalation.raise' and created_at >= $2::date and created_at < ($3::date + interval '1 day') order by created_at desc`, [pid, from, to]);
    for (const e of esc.rows as any[]) { const k = weekKey(new Date(e.created_at)); if (series[k]) series[k].escalations++; }
    const escByLevel: Record<string, number> = {};
    for (const e of esc.rows as any[]) { const l = String((e.details ?? {}).level ?? (e.details ?? {}).targetLevel ?? '?'); escByLevel[l] = (escByLevel[l] ?? 0) + 1; }
    const time = await db.query(`select date, minutes from time_entries where project_id = $1 and date >= $2 and date <= $3`, [pid, from, to]).catch(() => ({ rows: [] as any[] }));
    for (const e of time.rows as any[]) { const k = weekKey(new Date(day(e.date) + 'T00:00:00Z')); if (series[k]) series[k].minutes += e.minutes; }
    const open = rows.filter((t) => !t.done);
    const overdue = open.filter((t) => day(t.due_date) && day(t.due_date)! < today).map((t) => ({ id: t.id, title: t.title, dueDate: day(t.due_date)!, days: Math.round((new Date(today).getTime() - new Date(day(t.due_date)!).getTime()) / 86400_000), responsible: t.responsible, subproject: t.subproject, priority: t.priority, escalationLevel: t.escalation_level })).sort((a, b) => b.days - a.days);
    const aging = { d1_7: overdue.filter((o) => o.days <= 7).length, d8_30: overdue.filter((o) => o.days > 7 && o.days <= 30).length, d31: overdue.filter((o) => o.days > 30).length };
    const bySub = new Map<string, { name: string; open: number; done: number; overdue: number; cycleDays: number[] }>();
    for (const t of rows) { const k = t.subproject ?? 'Ohne Teilprojekt'; const b = bySub.get(k) ?? { name: k, open: 0, done: 0, overdue: 0, cycleDays: [] }; if (t.done) b.done++; else { b.open++; if (day(t.due_date) && day(t.due_date)! < today) b.overdue++; } bySub.set(k, b); }
    for (const c of cycle) bySub.get(c.subproject ?? 'Ohne Teilprojekt')?.cycleDays.push(c.days);
    return {
      from, to,
      weeks: wk.map((w) => series[w]),
      throughput: { created: wk.reduce((a, w) => a + series[w].created, 0), done: wk.reduce((a, w) => a + series[w].done, 0) },
      cycleTime: { count: cycle.length, medianDays: median(cycle.map((c) => c.days)), avgDays: cycle.length ? Math.round((cycle.reduce((a, c) => a + c.days, 0) / cycle.length) * 10) / 10 : null, slowest: [...cycle].sort((a, b) => b.days - a.days).slice(0, 5) },
      overdue: { total: overdue.length, aging, list: overdue.slice(0, 50) },
      escalations: { total: esc.rows.length, byLevel: Object.entries(escByLevel).map(([l, n]) => ({ level: Number(l), label: LEVEL_LABEL[Number(l)] ?? l, count: n })), current: rows.filter((t) => !t.done && t.escalation_level > 0).map((t) => ({ id: t.id, title: t.title, level: t.escalation_level, label: LEVEL_LABEL[t.escalation_level] ?? String(t.escalation_level) })) },
      blocked: open.filter((t) => t.blocked).length,
      bySubproject: [...bySub.values()].map((b) => ({ name: b.name, open: b.open, done: b.done, overdue: b.overdue, medianCycleDays: median(b.cycleDays) })),
      minutes: wk.reduce((a, w) => a + series[w].minutes, 0)
    };
  });

  // Zeiten über alle Projekte: Minuten je Projekt und Person im Zeitraum (nur Projekte, in denen man Mitglied ist; PL sieht alle Personen, sonst nur sich)
  app.get<{ Querystring: { from?: string; to?: string } }>('/portfolio/time', async (req) => {
    const user = requireUser(req);
    const { from, to } = range(req.query);
    const rows = await db.query(
      `select p.id as project_id, p.key, p.name as project, u.id as user_id, u.name, sum(e.minutes)::int as minutes
       from time_entries e join projects p on p.id = e.project_id join users u on u.id = e.user_id join project_members m on m.project_id = p.id and m.user_id = $1
       where e.date >= $2 and e.date <= $3 and (m.role = 'pl' or e.user_id = $1 or $4) group by p.id, p.key, p.name, u.id, u.name order by p.key, minutes desc`,
      [user.id, from, to, user.globalRole === 'org_admin']);
    type Person = { userId: string; name: string; minutes: number };
    type ProjRow = { projectId: string; key: string; name: string; minutes: number; people: Person[] };
    const projects = new Map<string, ProjRow>();
    for (const r of rows.rows as any[]) { const p: ProjRow = projects.get(r.project_id) ?? { projectId: r.project_id, key: r.key, name: r.project, minutes: 0, people: [] }; p.minutes += r.minutes; p.people.push({ userId: r.user_id, name: r.name, minutes: r.minutes }); projects.set(r.project_id, p); }
    const people = new Map<string, { userId: string; name: string; minutes: number }>();
    for (const r of rows.rows as any[]) { const x = people.get(r.user_id) ?? { userId: r.user_id, name: r.name, minutes: 0 }; x.minutes += r.minutes; people.set(r.user_id, x); }
    return { from, to, projects: [...projects.values()], people: [...people.values()].sort((a, b) => b.minutes - a.minutes), total: rows.rows.reduce((a: number, r: any) => a + r.minutes, 0) };
  });
}
