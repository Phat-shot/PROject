import type { FastifyInstance } from 'fastify';
import { createSession, hashPassword, mapUser, setSessionCookie } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, forbidden } from '../errors.js';

/**
 * Ersteinrichtung: Solange kein Benutzer existiert, legt diese Route Mandant und Org-Admin an.
 * Danach ist sie gesperrt (403). Kein Login nötig, weil es noch keinen gibt.
 */
export async function setupRoutes(app: FastifyInstance) {
  const needsSetup = async () => !(await app.db.maybeOne(`select 1 from users limit 1`));

  // demo: Demodaten vorhanden (Login-Seite zeigt dann die Demo-Zugänge)
  app.get('/setup/status', async () => ({ needsSetup: await needsSetup(), demo: Boolean(await app.db.maybeOne(`select 1 from users where email = 'pl@demo.local' limit 1`)) }));

  app.post<{ Body: { orgName: string; name: string; email: string; password: string } }>('/setup', async (req, reply) => {
    if (!(await needsSetup())) throw forbidden('Ersteinrichtung ist abgeschlossen');
    const b = req.body ?? ({} as any);
    if (!b.orgName?.trim() || !b.name?.trim() || !b.email?.trim() || !b.password) throw badRequest('Firma, Name, E-Mail und Passwort erforderlich');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) throw badRequest('Gültige E-Mail erforderlich');
    if (b.password.length < 10) throw badRequest('Passwort mit mindestens 10 Zeichen');
    const org = await app.db.one(`insert into orgs (name) values ($1) returning id`, [b.orgName.trim()]);
    const user = await app.db.one(
      `insert into users (org_id, email, name, password_hash, global_role) values ($1, $2, $3, $4, 'org_admin') returning *`,
      [org.id, b.email.trim().toLowerCase(), b.name.trim(), hashPassword(b.password)]
    );
    await audit(app.db, { orgId: org.id, userId: user.id, action: 'setup.complete', objectType: 'org', objectId: org.id, details: { orgName: b.orgName.trim(), admin: user.email } });
    const token = await createSession(app.db, user.id);
    setSessionCookie(reply, token);
    return { user: mapUser(user) };
  });
}
