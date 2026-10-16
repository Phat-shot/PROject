import type { FastifyInstance } from 'fastify';
import { hashPassword, mapUser, requireUser } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';

export async function userRoutes(app: FastifyInstance) {
  // Alle Benutzer des Mandanten (für Einladungen, Zuweisungen).
  app.get('/users', async (req) => {
    const user = requireUser(req);
    const rows = await app.db.query(`select * from users where org_id = $1 and active order by name`, [user.orgId]);
    return { users: rows.rows.map(mapUser) };
  });

  app.post<{ Body: { email: string; name: string; password: string; globalRole?: string } }>('/users', async (req) => {
    const user = requireUser(req);
    if (user.globalRole !== 'org_admin') throw forbidden('Nur Org-Admin');
    const { email, name, password, globalRole = 'user' } = req.body ?? ({} as any);
    if (!email || !name || !password) throw badRequest('E-Mail, Name und Passwort erforderlich');
    if (!['org_admin', 'project_creator', 'user'].includes(globalRole)) throw badRequest('Ungültige Rolle');
    const row = await app.db.one(
      `insert into users (org_id, email, name, password_hash, global_role) values ($1, $2, $3, $4, $5) returning *`,
      [user.orgId, email.toLowerCase(), name, hashPassword(password), globalRole]
    );
    await audit(app.db, { orgId: user.orgId, userId: user.id, action: 'user.create', objectType: 'user', objectId: row.id, details: { email, globalRole } });
    return { user: mapUser(row) };
  });

  // W10: Benutzer deaktivieren
  app.post<{ Params: { id: string } }>('/users/:id/deactivate', async (req) => {
    const user = requireUser(req);
    if (user.globalRole !== 'org_admin') throw forbidden('Nur Org-Admin');
    const target = await app.db.maybeOne(`select * from users where id = $1 and org_id = $2`, [req.params.id, user.orgId]);
    if (!target) throw notFound('Benutzer nicht gefunden');
    const plOf = await app.db.query(
      `select p.key from project_members m join projects p on p.id = m.project_id
       where m.user_id = $1 and m.role = 'pl' and not m.is_deputy and p.status = 'active'`,
      [target.id]
    );
    if (plOf.rows.length) throw badRequest(`Benutzer ist PL in: ${plOf.rows.map((r: any) => r.key).join(', ')}. Erst neuen PL setzen.`);
    await app.db.query(`update users set active = false where id = $1`, [target.id]);
    await app.db.query(`delete from sessions where user_id = $1`, [target.id]);
    // Persönliche Konten trennen: Ansichten verschwinden, Kopien in Aufgaben bleiben.
    await app.db.query(`delete from mail_accounts where owner_user_id = $1 and type = 'personal'`, [target.id]);
    // Ausdrückliche Zuständigkeiten fallen zurück auf die Ebene darüber.
    const tasks = await app.db.query(`update tasks set responsible_user_id = null where responsible_user_id = $1 returning id, project_id, title`, [target.id]);
    await app.db.query(`update subprojects set responsible_user_id = null where responsible_user_id = $1`, [target.id]);
    await app.db.query(`update checklist_items set responsible_user_id = null where responsible_user_id = $1`, [target.id]);
    await audit(app.db, {
      orgId: user.orgId, userId: user.id, action: 'user.deactivate', objectType: 'user', objectId: target.id,
      details: { releasedTasks: tasks.rows.map((t: any) => t.id) }
    });
    return { ok: true, releasedTasks: tasks.rows };
  });

  app.get<{ Querystring: { projectId?: string } }>('/audit', async (req) => {
    const user = requireUser(req);
    const { projectId } = req.query;
    if (projectId) {
      const m = await app.db.maybeOne(`select role from project_members where project_id = $1 and user_id = $2`, [projectId, user.id]);
      if (!m) throw forbidden();
      const own = m.role !== 'pl';
      const rows = await app.db.query(
        `select a.*, u.name as user_name from audit_log a left join users u on u.id = a.user_id
         where a.project_id = $1 ${own ? 'and a.user_id = $3' : ''} order by a.created_at desc limit $2`,
        own ? [projectId, 200, user.id] : [projectId, 200]
      );
      return { entries: rows.rows.map(mapAudit) };
    }
    if (user.globalRole !== 'org_admin') throw forbidden('Nur Org-Admin');
    const rows = await app.db.query(
      `select a.*, u.name as user_name from audit_log a left join users u on u.id = a.user_id
       where a.org_id = $1 order by a.created_at desc limit 1000`,
      [user.orgId]
    );
    await audit(app.db, { orgId: user.orgId, userId: user.id, action: 'audit.export', objectType: 'audit', details: { count: rows.rows.length } });
    return { entries: rows.rows.map(mapAudit) };
  });
}

function mapAudit(r: any) {
  return {
    id: r.id,
    projectId: r.project_id,
    userId: r.user_id,
    userName: r.user_name ?? null,
    action: r.action,
    objectType: r.object_type,
    objectId: r.object_id,
    details: r.details ?? {},
    createdAt: r.created_at
  };
}
