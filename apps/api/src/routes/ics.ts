import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { requireUser } from '../auth.js';
import { visibleSubprojectSql } from '../rights.js';
import { dateStr, loadTasks } from '../tasks/service.js';
import { publicBase } from '../docs/share.js';

/**
 * Kalender-Abo (ICS) ohne Login über ein persönliches Token: alle Projekte oder ein Projekt.
 * Deadlines und Meilensteine als Ganztagstermine, Arbeitspakete mit Start als Zeitraum.
 */
export async function icsRoutes(app: FastifyInstance) {
  const db = app.db;
  const feedUrls = (token: string) => ({ all: `${publicBase()}/api/ics/${token}/alle.ics`, project: (pid: string) => `${publicBase()}/api/ics/${token}/projekt/${pid}.ics` });

  app.get('/me/ics-token', async (req) => {
    const user = requireUser(req);
    const r = await db.one(`select ics_token from users where id = $1`, [user.id]);
    return { token: r.ics_token, urls: r.ics_token ? feedUrls(r.ics_token) : null };
  });
  // Neu erzeugen (oder erstmalig anlegen): alte Abos verlieren den Zugriff
  app.post('/me/ics-token', async (req) => {
    const user = requireUser(req);
    const token = randomBytes(24).toString('base64url');
    await db.query(`update users set ics_token = $2 where id = $1`, [user.id, token]);
    return { token, urls: feedUrls(token) };
  });

  const userByToken = async (token: string) => db.maybeOne(`select * from users where ics_token = $1 and active`, [token]);
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);
  const dt = (iso: string) => iso.replace(/-/g, '');
  const nextDay = (iso: string) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
  const localDay = (d: any) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';

  const build = (name: string, events: { uid: string; title: string; start: string; end: string; desc?: string; url?: string; timed?: boolean; location?: string | null }[]) => {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PROject//Kalender//DE', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${esc(name)}`, 'METHOD:PUBLISH'];
    for (const e of events) {
      if (e.timed) lines.push('BEGIN:VEVENT', `UID:${e.uid}@project`, `DTSTAMP:${stamp}`, `DTSTART:${e.start}`, `DTEND:${e.end}`, `SUMMARY:${esc(e.title)}`);
      else lines.push('BEGIN:VEVENT', `UID:${e.uid}@project`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${dt(e.start)}`, `DTEND;VALUE=DATE:${dt(nextDay(e.end))}`, `SUMMARY:${esc(e.title)}`);
      if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
      if (e.desc) lines.push(`DESCRIPTION:${esc(e.desc)}`);
      if (e.url) lines.push(`URL:${e.url}`);
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.join('\r\n') + '\r\n';
  };

  const feed = async (userRow: any, projectId: string | null) => {
    const visible = `exists (select 1 from projects p where p.id = t.project_id and p.org_id = $1 and (exists (select 1 from project_members pm where pm.project_id = p.id and pm.user_id = $2) or p.visibility = 'org'))`;
    const cond = projectId
      ? `t.project_id = $3 and t.archived_at is null and t.deleted_at is null and t.due_date is not null and ${visible} and ${visibleSubprojectSql(2)}`
      : `t.archived_at is null and t.deleted_at is null and t.due_date is not null and exists (select 1 from projects p where p.id = t.project_id and p.status = 'active') and ${visible} and ${visibleSubprojectSql(2)}`;
    const tasks = await loadTasks(db, cond, projectId ? [userRow.org_id, userRow.id, projectId] : [userRow.org_id, userRow.id]);
    const keys = new Map((await db.query(`select id, key, name from projects where org_id = $1`, [userRow.org_id])).rows.map((r: any) => [r.id, r]));
    const ms = await db.query(
      `select m.*, p.key from milestones m join projects p on p.id = m.project_id where p.org_id = $1 ${projectId ? 'and m.project_id = $3' : "and p.status = 'active'"} and (exists (select 1 from project_members pm where pm.project_id = p.id and pm.user_id = $2) or p.visibility = 'org') and ${visibleSubprojectSql(2, 'm')}`,
      projectId ? [userRow.org_id, userRow.id, projectId] : [userRow.org_id, userRow.id]
    );
    const meetings = await db.query(
      `select m.*, p.key from meetings m join projects p on p.id = m.project_id where p.org_id = $1 ${projectId ? 'and m.project_id = $3' : "and p.status = 'active'"} and exists (select 1 from project_members pm where pm.project_id = p.id and pm.user_id = $2)`,
      projectId ? [userRow.org_id, userRow.id, projectId] : [userRow.org_id, userRow.id]
    );
    const tstamp = (d: any) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const base = publicBase();
    // Belegungen (Konzept 10.7): eigene Belegungen und Abwesenheiten im Gesamt-Feed, die Belegungen des Projekts im Projekt-Feed
    const bookings = await db.query(
      projectId
        ? `select b.*, r.name as resource_name, u.name as user_name, p.key from resource_bookings b left join resources r on r.id = b.resource_id left join users u on u.id = b.user_id join projects p on p.id = b.project_id where b.project_id = $3 and b.ends_at > now() - interval '30 days' and exists (select 1 from project_members pm where pm.project_id = p.id and pm.user_id = $2) and p.org_id = $1`
        : `select b.*, r.name as resource_name, u.name as user_name, p.key from resource_bookings b left join resources r on r.id = b.resource_id left join users u on u.id = b.user_id left join projects p on p.id = b.project_id where b.org_id = $1 and b.user_id = $2 and b.ends_at > now() - interval '30 days'`,
      projectId ? [userRow.org_id, userRow.id, projectId] : [userRow.org_id, userRow.id]);
    const bookingEvent = (b: any) => ({ uid: `booking-${b.id}`, title: `${b.tentative ? '(vorläufig) ' : ''}${b.key ? `${b.key} ` : ''}${b.project_id ? `${b.resource_name ?? b.user_name ?? ''}${b.title ? `: ${b.title}` : ''}` : b.user_id ? `Abwesend${b.title && b.title !== 'Abwesenheit' ? `: ${b.title}` : ''}` : `Sperrzeit ${b.resource_name ?? ''}`}`, ...(b.all_day ? { start: localDay(b.starts_at), end: localDay(new Date(new Date(b.ends_at).getTime() - 1)) } : { start: tstamp(b.starts_at), end: tstamp(b.ends_at), timed: true }), url: b.project_id ? `${base}/kalender?ansicht=belegung&datum=${new Date(b.starts_at).toISOString().slice(0, 10)}` : undefined });
    const events = [
      ...bookings.rows.map(bookingEvent),
      ...meetings.rows.map((m: any) => ({ uid: `meeting-${m.id}`, title: `${m.tentative ? '(vorläufig) ' : ''}${m.key} ${m.title}`, start: tstamp(m.starts_at), end: tstamp(m.ends_at), timed: true, location: m.location, desc: m.description ?? undefined, url: `${base}/projekte/${m.project_id}/besprechungen` })),
      ...tasks.filter((t) => !t.done).map((t) => { const k = keys.get(t.projectId); return { uid: `task-${t.id}`, title: `${k?.key ?? ''}-${t.number} ${t.title}`, start: t.startDate ?? t.dueDate!, end: t.dueDate!, desc: `${k?.name ?? ''} · zuständig ${t.responsible.name ?? t.responsible.email ?? '–'}`, url: `${base}/projekte/${t.projectId}/board?task=${t.id}` }; }),
      ...ms.rows.map((m: any) => ({ uid: `ms-${m.id}`, title: `◆ ${m.key} ${m.name}`, start: dateStr(m.date)!, end: dateStr(m.date)!, url: `${base}/projekte/${m.project_id}/plan` }))
    ];
    const name = projectId ? `PROject ${keys.get(projectId)?.key ?? ''}` : 'PROject – alle Projekte';
    return build(name, events);
  };

  app.get<{ Params: { token: string } }>('/ics/:token/alle.ics', async (req, reply) => {
    const u = await userByToken(req.params.token);
    if (!u) return reply.status(404).send('Abo ungültig');
    reply.header('content-type', 'text/calendar; charset=utf-8');
    return reply.send(await feed(u, null));
  });
  // Feed einer Ressource (maskiert: Fremde sehen nur „belegt“ bzw. „vorläufig belegt“)
  app.get<{ Params: { token: string; rid: string } }>('/ics/:token/ressource/:rid.ics', async (req, reply) => {
    const u = await userByToken(req.params.token);
    if (!u) return reply.status(404).send('Abo ungültig');
    const r = await db.maybeOne(`select * from resources where id = $1 and org_id = $2`, [req.params.rid, u.org_id]);
    if (!r) return reply.status(404).send('Ressource unbekannt');
    if (r.project_id && !(await db.maybeOne(`select 1 from project_members where project_id = $1 and user_id = $2`, [r.project_id, u.id]))) return reply.status(404).send('Ressource unbekannt');
    const rows = await db.query(`select b.*, p.key, exists (select 1 from project_members pm where pm.project_id = b.project_id and pm.user_id = $2) as visible from resource_bookings b left join projects p on p.id = b.project_id where b.resource_id = $1 and b.ends_at > now() - interval '30 days' order by b.starts_at`, [r.id, u.id]);
    const tstamp = (d: any) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const events = rows.rows.map((b: any) => ({ uid: `booking-${b.id}`, title: `${b.tentative ? '(vorläufig) ' : ''}${!b.project_id ? 'Sperrzeit' : b.visible ? `${b.key} ${b.title ?? 'Belegung'}` : 'belegt'}`, ...(b.all_day ? { start: localDay(b.starts_at), end: localDay(new Date(new Date(b.ends_at).getTime() - 1)) } : { start: tstamp(b.starts_at), end: tstamp(b.ends_at), timed: true }) }));
    reply.header('content-type', 'text/calendar; charset=utf-8');
    return reply.send(build(`PROject ${r.name}`, events));
  });
  app.get<{ Params: { token: string; pid: string } }>('/ics/:token/projekt/:pid.ics', async (req, reply) => {
    const u = await userByToken(req.params.token);
    if (!u) return reply.status(404).send('Abo ungültig');
    reply.header('content-type', 'text/calendar; charset=utf-8');
    return reply.send(await feed(u, req.params.pid));
  });
}
