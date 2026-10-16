import type { FastifyInstance } from 'fastify';
import { createSession, mapUser, requireUser, SESSION_COOKIE, setSessionCookie, verifyPassword } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, unauthorized } from '../errors.js';

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: { email: string; password: string } }>('/auth/login', async (req, reply) => {
    const { email, password } = req.body ?? ({} as any);
    if (!email || !password) throw badRequest('E-Mail und Passwort erforderlich');
    const row = await app.db.maybeOne(`select * from users where lower(email) = lower($1) and active`, [email]);
    if (!row || !verifyPassword(password, row.password_hash)) throw unauthorized('E-Mail oder Passwort falsch');
    const token = await createSession(app.db, row.id);
    setSessionCookie(reply, token);
    await audit(app.db, { orgId: row.org_id, userId: row.id, action: 'login', objectType: 'user', objectId: row.id });
    const org = await app.db.one(`select name, settings from orgs where id = $1`, [row.org_id]);
    return { user: mapUser(row), orgName: org.name, orgSettings: org.settings ?? {} };
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await app.db.query(`delete from sessions where token = $1`, [token]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    const user = requireUser(req);
    const org = await app.db.one(`select name, settings from orgs where id = $1`, [user.orgId]);
    return { user, orgName: org.name, orgSettings: org.settings ?? {} };
  });
}
