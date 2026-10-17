import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { createSession, hashPassword, mapUser, requireUser, SESSION_COOKIE, setSessionCookie, verifyPassword } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, notFound, unauthorized } from '../errors.js';
import { publicBase } from '../docs/share.js';
import { verifyTotp } from '../totp.js';

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: { email: string; password: string } }>('/auth/login', async (req, reply) => {
    const { email, password } = req.body ?? ({} as any);
    if (!email || !password) throw badRequest('E-Mail und Passwort erforderlich');
    const row = await app.db.maybeOne(`select * from users where lower(email) = lower($1) and active`, [email]);
    if (!row || row.kind === 'agent' || !verifyPassword(password, row.password_hash)) throw unauthorized('E-Mail oder Passwort falsch');
    // Zweiter Faktor: Passwort stimmt, Code folgt in einem zweiten Schritt (Challenge 5 Minuten gültig)
    if (row.totp_enabled && row.totp_secret) {
      const challenge = randomBytes(24).toString('base64url');
      await app.db.query(`delete from login_challenges where expires_at < now()`);
      await app.db.query(`insert into login_challenges (token, user_id, expires_at) values ($1, $2, now() + interval '5 minutes')`, [challenge, row.id]);
      return { mfaRequired: true, challenge };
    }
    const token = await createSession(app.db, row.id);
    setSessionCookie(reply, token);
    await audit(app.db, { orgId: row.org_id, userId: row.id, action: 'login', objectType: 'user', objectId: row.id });
    const org = await app.db.one(`select name, settings from orgs where id = $1`, [row.org_id]);
    return { user: mapUser(row), orgName: org.name, orgSettings: org.settings ?? {} };
  });

  app.post<{ Body: { challenge: string; code: string } }>('/auth/login/totp', async (req, reply) => {
    const { challenge, code } = req.body ?? ({} as any);
    const c = challenge ? await app.db.maybeOne(`select c.*, u.totp_secret, u.org_id from login_challenges c join users u on u.id = c.user_id where c.token = $1 and c.expires_at > now() and u.active`, [challenge]) : null;
    if (!c) throw unauthorized('Anmeldung abgelaufen, bitte neu anmelden');
    if (!verifyTotp(c.totp_secret, String(code ?? ''))) throw unauthorized('Code falsch');
    await app.db.query(`delete from login_challenges where token = $1`, [challenge]);
    const row = await app.db.one(`select * from users where id = $1`, [c.user_id]);
    const token = await createSession(app.db, row.id);
    setSessionCookie(reply, token);
    await audit(app.db, { orgId: row.org_id, userId: row.id, action: 'login', objectType: 'user', objectId: row.id, details: { mfa: true } });
    const org = await app.db.one(`select name, settings from orgs where id = $1`, [row.org_id]);
    return { user: mapUser(row), orgName: org.name, orgSettings: org.settings ?? {} };
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await app.db.query(`delete from sessions where token = $1`, [token]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // Passwort vergessen: Link per Mail über das Org-Postfach. Antwort verrät nicht, ob die Adresse existiert;
  // nur das Fehlen eines Org-Postfachs (Mandantenebene) wird gemeldet.
  app.post<{ Body: { email: string } }>('/auth/forgot', async (req) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Gültige E-Mail erforderlich');
    const row = await app.db.maybeOne(`select * from users where lower(email) = $1 and active`, [email]);
    if (!row) return { ok: true, sent: true };
    const account = await app.db.maybeOne(`select * from mail_accounts where org_id = $1 and type = 'org' order by created_at limit 1`, [row.org_id]);
    if (!account) return { ok: true, sent: false, error: 'Kein Org-Postfach angebunden. Bitte den Org-Admin um ein neues Passwort.' };
    // Ältere offene Tokens verfallen, höchstens einer gilt
    await app.db.query(`update password_resets set used_at = now() where user_id = $1 and used_at is null`, [row.id]);
    const token = randomBytes(32).toString('hex');
    await app.db.query(`insert into password_resets (token, user_id, expires_at) values ($1, $2, now() + interval '2 hours')`, [token, row.id]);
    const org = await app.db.one(`select name from orgs where id = $1`, [row.org_id]);
    const link = `${publicBase()}/passwort/${token}`;
    try {
      await app.mail.sendFromAccount(account, {
        to: [row.email], subject: `Passwort zurücksetzen – PROject (${org.name})`,
        text: `Guten Tag ${row.name},\n\nüber diesen Link legen Sie ein neues Passwort fest (2 Stunden gültig):\n${link}\n\nFalls Sie das nicht angefordert haben, ignorieren Sie diese Mail.\n\n${org.name}`,
        userId: row.id
      });
    } catch (e: any) {
      return { ok: true, sent: false, error: `Versand fehlgeschlagen: ${String(e?.message ?? e)}` };
    }
    await audit(app.db, { orgId: row.org_id, userId: row.id, action: 'user.password_reset_requested', objectType: 'user', objectId: row.id });
    return { ok: true, sent: true };
  });

  const openReset = (token: string) => app.db.maybeOne(`select r.*, u.email, u.name, u.org_id from password_resets r join users u on u.id = r.user_id where r.token = $1 and r.used_at is null and r.expires_at > now() and u.active`, [token]);
  app.get<{ Params: { token: string } }>('/auth/reset/:token', async (req) => {
    const r = await openReset(req.params.token);
    if (!r) throw notFound('Link ungültig oder abgelaufen');
    return { email: r.email, name: r.name };
  });
  app.post<{ Params: { token: string }; Body: { password: string } }>('/auth/reset/:token', async (req, reply) => {
    const r = await openReset(req.params.token);
    if (!r) throw notFound('Link ungültig oder abgelaufen');
    const password = String(req.body?.password ?? '');
    if (password.length < 10) throw badRequest('Passwort mit mindestens 10 Zeichen');
    await app.db.query(`update users set password_hash = $2 where id = $1`, [r.user_id, hashPassword(password)]);
    await app.db.query(`update password_resets set used_at = now() where token = $1`, [req.params.token]);
    await app.db.query(`delete from sessions where user_id = $1`, [r.user_id]);
    await audit(app.db, { orgId: r.org_id, userId: r.user_id, action: 'user.password_reset', objectType: 'user', objectId: r.user_id });
    const token = await createSession(app.db, r.user_id);
    setSessionCookie(reply, token);
    const row = await app.db.one(`select * from users where id = $1`, [r.user_id]);
    const org = await app.db.one(`select name, settings from orgs where id = $1`, [row.org_id]);
    return { user: mapUser(row), orgName: org.name, orgSettings: org.settings ?? {} };
  });

  app.get('/auth/me', async (req) => {
    const user = requireUser(req);
    const org = await app.db.one(`select name, settings from orgs where id = $1`, [user.orgId]);
    return { user, orgName: org.name, orgSettings: org.settings ?? {} };
  });
}
