import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { requireUser } from '../auth.js';
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
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';

  const build = (name: string, events: { uid: string; title: string; start: string; end: string; desc?: string; url?: string }[]) => {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PROject//Kalender//DE', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${esc(name)}`, 'METHOD:PUBLISH'];
    for (const e of events) {
      lines.push('BEGIN:VEVENT', `UID:${e.uid}@project`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${dt(e.start)}`, `DTEND;VALUE=DATE:${dt(nextDay(e.end))}`, `SUMMARY:${esc(e.title)}`);
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
      ? `t.project_id = $3 and t.archived_at is null and t.due_date is not null and ${visible}`
      : `t.archived_at is null and t.due_date is not null and exists (select 1 from projects p where p.id = t.project_id and p.status = 'active') and ${visible}`;
    const tasks = await loadTasks(db, cond, projectId ? [userRow.org_id, userRow.id, projectId] : [userRow.org_id, userRow.id]);
    const keys = new Map((await db.query(`select id, key, name from projects where org_id = $1`, [userRow.org_id])).rows.map((r: any) => [r.id, r]));
    const ms = await db.query(
      `select m.*, p.key from milestones m join projects p on p.id = m.project_id where p.org_id = $1 ${projectId ? 'and m.project_id = $3' : "and p.status = 'active'"} and (exists (select 1 from project_members pm where pm.project_id = p.id and pm.user_id = $2) or p.visibility = 'org')`,
      projectId ? [userRow.org_id, userRow.id, projectId] : [userRow.org_id, userRow.id]
    );
    const base = publicBase();
    const events = [
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
  app.get<{ Params: { token: string; pid: string } }>('/ics/:token/projekt/:pid.ics', async (req, reply) => {
    const u = await userByToken(req.params.token);
    if (!u) return reply.status(404).send('Abo ungültig');
    reply.header('content-type', 'text/calendar; charset=utf-8');
    return reply.send(await feed(u, req.params.pid));
  });
}
