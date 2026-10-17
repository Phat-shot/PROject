import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { createSession, requireUser, setSessionCookie } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { authorizeUrl, exchangeCode, oauthProviders, oidcConfig, oidcDiscovery, publicRedirect, redirectUri } from '../oauth.js';
import { requireProject } from '../rights.js';
import { publicBase } from '../docs/share.js';
import { seal } from '../secrets.js';

interface MailPurpose { kind: 'mail'; provider: string; type: 'personal' | 'project' | 'org'; projectId: string | null; name: string | null }
interface OidcPurpose { kind: 'oidc'; next: string }

/**
 * OAuth2-Anbindung von Mail-Konten (Microsoft 365, Google) und OIDC-Anmeldung.
 * Der State liegt in oauth_states (10 Minuten gültig) und trägt den Zweck: welches Konto angelegt werden soll bzw. Login.
 */
export async function oauthRoutes(app: FastifyInstance) {
  const db = app.db;
  const newState = async (userId: string | null, purpose: MailPurpose | OidcPurpose) => {
    const state = randomBytes(24).toString('base64url');
    await db.query(`delete from oauth_states where expires_at < now()`);
    await db.query(`insert into oauth_states (state, user_id, purpose, expires_at) values ($1, $2, $3, now() + interval '10 minutes')`, [state, userId, JSON.stringify(purpose)]);
    return state;
  };
  const takeState = async (state: string | undefined) => {
    if (!state) return null;
    const r = await db.maybeOne(`delete from oauth_states where state = $1 and expires_at > now() returning *`, [state]);
    return r ? { userId: r.user_id as string | null, purpose: r.purpose as MailPurpose | OidcPurpose } : null;
  };
  const failTo = (path: string, msg: string) => `${publicBase()}${path}${path.includes('?') ? '&' : '?'}oauthError=${encodeURIComponent(msg)}`;

  // Konfigurierte Anbieter (für die Knöpfe in der Oberfläche)
  app.get('/oauth/providers', async () => ({ providers: oauthProviders().map((p) => ({ key: p.key, label: p.label, mailProvider: p.mailProvider })) }));

  // Start: prüft Rechte wie beim manuellen Anlegen, merkt den Zweck und leitet zum Anbieter
  app.get<{ Querystring: { provider: string; type?: string; projectId?: string; name?: string } }>('/oauth/start', async (req, reply) => {
    const user = requireUser(req);
    const p = oauthProviders().find((x) => x.key === req.query.provider);
    if (!p) throw notFound('OAuth2-Anbieter nicht konfiguriert');
    const type = (req.query.type ?? 'personal') as MailPurpose['type'];
    let projectId: string | null = null;
    if (type === 'project') {
      if (!req.query.projectId) throw badRequest('projectId erforderlich');
      await requireProject(db, user, req.query.projectId, 'pl');
      projectId = req.query.projectId;
    } else if (type === 'org') {
      if (user.globalRole !== 'org_admin') throw forbidden('Org-Postfach legt der Org-Admin an');
      if (await db.maybeOne(`select 1 from mail_accounts where org_id = $1 and type = 'org'`, [user.orgId])) throw badRequest('Es gibt bereits ein Org-Postfach');
    } else if (type !== 'personal') throw badRequest('Typ personal, project oder org');
    const state = await newState(user.id, { kind: 'mail', provider: p.key, type, projectId, name: req.query.name?.trim() || null });
    return reply.redirect(authorizeUrl(p, state));
  });

  // Rückruf vom Anbieter: Code tauschen, Adresse lesen, Konto anlegen oder Token eines bestehenden Kontos erneuern
  app.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>('/oauth/callback/:provider', async (req, reply) => {
    const back = '/einstellungen/konfiguration';
    const p = oauthProviders().find((x) => x.key === req.params.provider);
    if (!p) throw notFound('OAuth2-Anbieter nicht konfiguriert');
    const st = await takeState(req.query.state);
    if (!st || st.purpose.kind !== 'mail' || !st.userId) return reply.redirect(failTo(back, 'Anmeldung abgelaufen oder ungültig, bitte erneut verbinden'));
    if (req.query.error || !req.query.code) return reply.redirect(failTo(back, req.query.error_description ?? req.query.error ?? 'Vom Anbieter abgelehnt'));
    const purpose = st.purpose;
    const user = await db.maybeOne(`select * from users where id = $1 and active`, [st.userId]);
    if (!user) return reply.redirect(failTo(back, 'Benutzer nicht gefunden'));
    try {
      const tokens = await exchangeCode(p, req.query.code, app.fetchFn);
      if (!tokens.refreshToken) return reply.redirect(failTo(back, 'Der Anbieter hat kein Refresh-Token geliefert (Zustimmung erneut erteilen)'));
      const info = await p.userinfo(tokens.accessToken, app.fetchFn);
      const existing = await db.maybeOne(`select * from mail_accounts where org_id = $1 and lower(address) = $2 and oauth_provider = $3 and type = $4 and coalesce(project_id::text, '') = $5 and coalesce(owner_user_id::text, '') = $6`,
        [user.org_id, info.email, p.key, purpose.type, purpose.projectId ?? '', purpose.type === 'personal' ? user.id : '']);
      let accountId: string;
      if (existing) {
        await db.query(`update mail_accounts set oauth_access_token = $2, oauth_refresh_token = $3, oauth_expires_at = $4, sync_error = null where id = $1`, [existing.id, seal(tokens.accessToken), seal(tokens.refreshToken), tokens.expiresAt]);
        accountId = existing.id;
      } else {
        const r = await db.one(
          `insert into mail_accounts (org_id, type, owner_user_id, project_id, name, address, provider, oauth_provider, oauth_access_token, oauth_refresh_token, oauth_expires_at, imap_host, imap_port, imap_user, imap_secure, smtp_host, smtp_port, smtp_user, smtp_secure)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) returning id, address`,
          [user.org_id, purpose.type, purpose.type === 'personal' ? user.id : null, purpose.projectId, purpose.name ?? info.name ?? info.email, info.email, p.mailProvider, p.key, seal(tokens.accessToken), seal(tokens.refreshToken), tokens.expiresAt,
            p.mailProvider === 'imap' ? p.imap!.host : null, p.mailProvider === 'imap' ? p.imap!.port : null, p.mailProvider === 'imap' ? info.email : null, true,
            p.mailProvider === 'imap' ? p.imap!.smtpHost : null, p.mailProvider === 'imap' ? p.imap!.smtpPort : null, p.mailProvider === 'imap' ? info.email : null, false]
        );
        accountId = r.id;
        if (purpose.projectId) await db.query(`update projects set mail_address = coalesce(mail_address, $2) where id = $1`, [purpose.projectId, r.address]);
      }
      await audit(db, { orgId: user.org_id, projectId: purpose.projectId, userId: user.id, action: existing ? 'mail_account.reconnect' : 'mail_account.create', objectType: 'mail_account', objectId: accountId, details: { type: purpose.type, address: info.email, provider: p.mailProvider, oauth: p.key } });
      return reply.redirect(`${publicBase()}${back}?connected=${encodeURIComponent(info.email)}`);
    } catch (e: any) {
      return reply.redirect(failTo(back, String(e?.message ?? e).slice(0, 200)));
    }
  });

  // OIDC-Anmeldung: Discovery, Authorization-Code, Benutzer per oidc_subject oder E-Mail zuordnen
  app.get<{ Querystring: { next?: string } }>('/auth/oidc/start', async (req, reply) => {
    const cfg = oidcConfig();
    if (!cfg) throw notFound('Single Sign-on ist nicht konfiguriert');
    const disc = await oidcDiscovery(cfg, app.fetchFn);
    const state = await newState(null, { kind: 'oidc', next: publicRedirect(req.query.next) });
    const q = new URLSearchParams({ client_id: cfg.clientId, response_type: 'code', redirect_uri: `${publicBase()}/api/auth/oidc/callback`, scope: cfg.scopes.join(' '), state });
    return reply.redirect(`${disc.authorization_endpoint}?${q.toString()}`);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>('/auth/oidc/callback', async (req, reply) => {
    const cfg = oidcConfig();
    if (!cfg) throw notFound('Single Sign-on ist nicht konfiguriert');
    const st = await takeState(req.query.state);
    if (!st || st.purpose.kind !== 'oidc') return reply.redirect(failTo('/login', 'Anmeldung abgelaufen, bitte erneut versuchen'));
    if (req.query.error || !req.query.code) return reply.redirect(failTo('/login', req.query.error_description ?? req.query.error ?? 'Vom Identitätsanbieter abgelehnt'));
    try {
      const disc = await oidcDiscovery(cfg, app.fetchFn);
      const body = new URLSearchParams({ grant_type: 'authorization_code', code: req.query.code, redirect_uri: `${publicBase()}/api/auth/oidc/callback`, client_id: cfg.clientId, client_secret: cfg.clientSecret });
      const tr = await app.fetchFn(disc.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
      const tj: any = await tr.json().catch(() => ({}));
      if (!tr.ok || !tj.access_token) throw new Error(tj.error_description ?? tj.error ?? `Token ${tr.status}`);
      const ur = await app.fetchFn(disc.userinfo_endpoint, { headers: { authorization: `Bearer ${tj.access_token}` } });
      const u: any = await ur.json().catch(() => ({}));
      if (!ur.ok || !u.sub) throw new Error(`Userinfo ${ur.status}`);
      const email = String(u.email ?? '').toLowerCase();
      let row = await db.maybeOne(`select * from users where oidc_subject = $1 and active`, [String(u.sub)]);
      if (!row && email) {
        row = await db.maybeOne(`select * from users where lower(email) = $1 and active`, [email]);
        if (row) await db.query(`update users set oidc_subject = $2 where id = $1 and oidc_subject is null`, [row.id, String(u.sub)]);
      }
      if (!row && cfg.autoCreate && email) {
        const org = await db.maybeOne(`select id from orgs order by created_at limit 1`);
        if (!org) throw new Error('Keine Organisation eingerichtet');
        row = await db.one(`insert into users (org_id, email, name, password_hash, global_role, oidc_subject) values ($1, $2, $3, '', 'user', $4) returning *`, [org.id, email, String(u.name ?? u.preferred_username ?? email), String(u.sub)]);
        await audit(db, { orgId: org.id, userId: row.id, action: 'user.create', objectType: 'user', objectId: row.id, details: { email, via: 'oidc' } });
      }
      if (!row) return reply.redirect(failTo('/login', `Kein Benutzer für ${email || u.sub}. Die Verwaltung muss das Konto zuerst anlegen.`));
      // Provisionierung aus Claims: Name nachziehen, Gruppen mit IdP-Namen abgleichen (nur Gruppen, die eine Zuordnung tragen)
      const claimName = String(u.name ?? '').trim();
      if (claimName && claimName !== row.name) await db.query(`update users set name = $2 where id = $1`, [row.id, claimName]);
      const rawGroups = u[cfg.groupsClaim];
      if (Array.isArray(rawGroups)) {
        const mine = new Set(rawGroups.map((g: unknown) => String(g).toLowerCase()));
        const mapped = await db.query(`select id, idp_name from groups where org_id = $1 and idp_name is not null`, [row.org_id]);
        const changes: { group: string; action: 'add' | 'remove' }[] = [];
        for (const g of mapped.rows as any[]) {
          const should = mine.has(String(g.idp_name).toLowerCase());
          const is = await db.maybeOne(`select 1 from group_members where group_id = $1 and user_id = $2`, [g.id, row.id]);
          if (should && !is) { await db.query(`insert into group_members (group_id, user_id) values ($1,$2) on conflict do nothing`, [g.id, row.id]); changes.push({ group: g.idp_name, action: 'add' }); }
          if (!should && is) { await db.query(`delete from group_members where group_id = $1 and user_id = $2`, [g.id, row.id]); changes.push({ group: g.idp_name, action: 'remove' }); }
        }
        if (changes.length) await audit(db, { orgId: row.org_id, userId: row.id, action: 'user.groups_synced', objectType: 'user', objectId: row.id, details: { changes } });
      }
      const token = await createSession(db, row.id);
      setSessionCookie(reply, token);
      await audit(db, { orgId: row.org_id, userId: row.id, action: 'login', objectType: 'user', objectId: row.id, details: { oidc: true } });
      return reply.redirect(`${publicBase()}${st.purpose.next}`);
    } catch (e: any) {
      return reply.redirect(failTo('/login', String(e?.message ?? e).slice(0, 200)));
    }
  });

  // Aktueller Stand für die Oberfläche (nach SSO-Weiterleitung)
  app.get('/auth/oidc/info', async () => { const cfg = oidcConfig(); return { oidc: cfg ? { label: cfg.label, redirectUri: `${publicBase()}/api/auth/oidc/callback` } : null, mailRedirects: oauthProviders().map((p) => ({ key: p.key, redirectUri: redirectUri(p.key) })) }; });
}
