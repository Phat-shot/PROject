import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import { visibleSubprojectSql } from '../rights.js';
import { getMembership, getViewRights } from '../rights.js';

export async function searchRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string } }>('/search', async (req) => {
    const user = requireUser(req);
    const q = (req.query.q ?? '').trim();
    if (q.length < 2) return { tasks: [], pages: [], mails: [] };
    const like = `%${q}%`;
    // Kennung „WEB-12“ (auch ohne Kürzel: „#12“ oder „12“ trifft alle Projekte)
    const key = q.match(/^([A-Za-z0-9-]+?)-(\d+)$/) ?? q.match(/^#?(\d+)$/);
    const keyCond = key ? (key.length === 3 ? `or (upper(p.key) = upper($3) and t.number = $4)` : `or t.number = $3`) : '';
    const keyParams = key ? (key.length === 3 ? [key[1], Number(key[2])] : [Number(key[1])]) : [];
    const tasks = await app.db.query(
      `select t.id, t.title, t.number, t.project_id, p.key as project_key from tasks t join projects p on p.id = t.project_id
       where t.project_id in (select project_id from project_members where user_id = $1) and t.deleted_at is null and (t.title ilike $2 or t.description ilike $2 ${keyCond}) and ${visibleSubprojectSql(1)} order by t.updated_at desc limit 20`,
      [user.id, like, ...keyParams]
    );
    const pages = await app.db.query(
      `select d.id, d.title, d.project_id, d.status, p.key as project_key from doc_pages d join projects p on p.id = d.project_id
       where d.project_id in (select project_id from project_members where user_id = $1) and d.deleted_at is null and (d.title ilike $2 or d.content_md ilike $2) order by d.updated_at desc limit 20`,
      [user.id, like]
    );
    const views = await app.db.query(`select id, project_id from mail_views where project_id in (select project_id from project_members where user_id = $1)`, [user.id]);
    const readable: string[] = [];
    for (const v of views.rows) {
      const r = await getViewRights(app.db, v.id, user, await getMembership(app.db, v.project_id, user.id));
      if (r.canRead) readable.push(v.id);
    }
    let mails: any[] = [];
    if (readable.length) {
      const res = await app.db.query(
        `select distinct m.id, m.subject, m.from_addr, m.date, x.view_id, v.project_id from mails m join mail_view_matches x on x.mail_id = m.id join mail_views v on v.id = x.view_id
         where x.view_id = any($1::uuid[]) and (m.subject ilike $2 or m.text_body ilike $2 or m.from_addr ilike $2) order by m.date desc limit 20`,
        [readable, like]
      );
      mails = res.rows;
    }
    return {
      tasks: tasks.rows.map((t: any) => ({ id: t.id, title: t.title, number: t.number, projectId: t.project_id, projectKey: t.project_key })),
      pages: pages.rows.map((p: any) => ({ id: p.id, title: p.title, projectId: p.project_id, projectKey: p.project_key, status: p.status })),
      mails: mails.map((m) => ({ id: m.id, subject: m.subject, fromAddr: m.from_addr, date: m.date, viewId: m.view_id, projectId: m.project_id }))
    };
  });
}
