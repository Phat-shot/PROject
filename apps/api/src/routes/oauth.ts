import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { createSession, requireUser, setSessionCookie } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { authorizeUrl, exchangeCode, oauthProviders, oidcConfig, oidcDiscovery, pkceChallenge, pkceVerifier, publicRedirect, redirectUri } from '../oauth.js';
import { requireProject, syncProjectGroups } from '../rights.js';
import { publicBase } from '../docs/share.js';
import { seal } from '../secrets.js';
import { bind, orgAccount } from '../mail/accounts.js';
import type { AccountRow } from '../mail/types.js';

interface MailPurpose { kind: 'mail'; verifier?: string; provider: string; /** Verwalter des neuen Kontos (type bleibt eine Version als Alias) */ type: 'personal' | 'project' | 'org'; /** zentrales Postfach (Organisation, mehrere Projekte): keine org-Bindung, für alle Projekte wählbar */ central?: boolean; projectId: string | null; name: string | null }
interface OidcPurpose { kind: 'oidc'; next: string; verifier?: string }

/** Der State gilt nur im Browser, der den Ablauf gestartet hat (sonst Konto- bzw. Login-Unterschiebung per Link) */
const STATE_COOKIE = 'pt_oauth';

/**
 * OAuth2-Anbindung von Mail-Konten (Microsoft 365, Google) und OIDC-Anmeldung.
 * Der State liegt in oauth_states (10 Minuten gültig) und trägt den Zweck: welches Konto angelegt werden soll bzw. Login.
 * Zusätzlich steht er in einem httpOnly-Cookie des startenden Browsers; der Code wird per PKCE an den Start gebunden.
 */
export async function oauthRoutes(app: FastifyInstance) {
  const db = app.db;
  const newState = async (reply: FastifyReply, userId: string | null, purpose: MailPurpose | OidcPurpose) => {
    const state = randomBytes(24).toString('base64url');
    await db.query(`delete from oauth_states where expires_at < now()`);
    await db.query(`insert into oauth_states (state, user_id, purpose, expires_at) values ($1, $2, $3, now() + interval '10 minutes')`, [state, userId, JSON.stringify(purpose)]);
    reply.setCookie(STATE_COOKIE, state, { path: '/api', httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 600 });
    return state;
  };
  const takeState = async (req: FastifyRequest, reply: FastifyReply) => {
    const state = (req.query as { state?: string }).state;
    const bound = req.cookies?.[STATE_COOKIE];
    reply.clearCookie(STATE_COOKIE, { path: '/api' });
    if (!state || !bound || bound !== state) return null;
    const r = await db.maybeOne(`delete from oauth_states where state = $1 and expires_at > now() returning *`, [state]);
    return r ? { userId: r.user_id as string | null, purpose: r.purpose as MailPurpose | OidcPurpose } : null;
  };
  const failTo = (path: string, msg: string) => `${publicBase()}${path}${path.includes('?') ? '&' : '?'}oauthError=${encodeURIComponent(msg)}`;

  // Konfigurierte Anbieter (für die Knöpfe in der Oberfläche)
  app.get('/oauth/providers', async () => ({ providers: oauthProviders().map((p) => ({ key: p.key, label: p.label, mailProvider: p.mailProvider })) }));

  // Start: prüft Rechte wie beim manuellen Anlegen, merkt den Zweck und leitet zum Anbieter
  app.get<{ Querystring: { provider: string; type?: string; managedBy?: string; kind?: string; projectId?: string; name?: string } }>('/oauth/start', async (req, reply) => {
    const user = requireUser(req);
    const p = oauthProviders().find((x) => x.key === req.query.provider);
    if (!p) throw notFound('OAuth2-Anbieter nicht konfiguriert');
    const type = (req.query.managedBy === 'me' ? 'personal' : req.query.managedBy ?? req.query.type ?? 'personal') as MailPurpose['type'];
    let projectId: string | null = null;
    if (type === 'project') {
      if (!req.query.projectId) throw badRequest('projectId erforderlich');
      await requireProject(db, user, req.query.projectId, 'pl');
      projectId = req.query.projectId;
    }
    const central = req.query.kind === 'central';
    if (type === 'org') {
      if (user.globalRole !== 'org_admin') throw forbidden('Konten der Organisation legt der Org-Admin an');
      if (!central && (await orgAccount(db, user.orgId))) throw badRequest('Es gibt bereits ein Org-Postfach');
    } else if (type !== 'personal' && type !== 'project') throw badRequest('managedBy: me, project oder org');
    const verifier = pkceVerifier();
    const state = await newState(reply, user.id, { kind: 'mail', provider: p.key, type, central, projectId, name: req.query.name?.trim() || null, verifier });
    return reply.redirect(authorizeUrl(p, state, verifier));
  });

  // Rückruf vom Anbieter: Code tauschen, Adresse lesen, Konto anlegen oder Token eines bestehenden Kontos erneuern
  app.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>('/oauth/callback/:provider', async (req, reply) => {
    // Zurück dorthin, wo das Konto gepflegt wird: eigene Konten, Verwaltung › Mail oder Projekt › Einstellungen › Mail
    let back = '/einstellungen/mail';
    const p = oauthProviders().find((x) => x.key === req.params.provider);
    if (!p) throw notFound('OAuth2-Anbieter nicht konfiguriert');
    const st = await takeState(req, reply);
    if (st?.purpose.kind === 'mail') back = st.purpose.type === 'project' && st.purpose.projectId ? `/projekte/${st.purpose.projectId}/einstellungen/mail` : st.purpose.type === 'org' ? '/verwaltung/mail' : '/einstellungen/mail';
    if (!st || st.purpose.kind !== 'mail' || !st.userId || req.user?.id !== st.userId) return reply.redirect(failTo(back, 'Anmeldung abgelaufen oder ungültig, bitte erneut verbinden'));
    if (req.query.error || !req.query.code) return reply.redirect(failTo(back, req.query.error_description ?? req.query.error ?? 'Vom Anbieter abgelehnt'));
    const purpose = st.purpose;
    const user = await db.maybeOne(`select * from users where id = $1 and active`, [st.userId]);
    if (!user) return reply.redirect(failTo(back, 'Benutzer nicht gefunden'));
    try {
      const tokens = await exchangeCode(p, req.query.code, purpose.verifier ?? '', app.fetchFn);
      if (!tokens.refreshToken) return reply.redirect(failTo(back, 'Der Anbieter hat kein Refresh-Token geliefert (Zustimmung erneut erteilen)'));
      const info = await p.userinfo(tokens.accessToken, app.fetchFn);
      const existing = await db.maybeOne(`select * from mail_accounts where org_id = $1 and lower(address) = $2 and oauth_provider = $3 and coalesce(managed_project_id::text, '') = $4 and coalesce(managed_user_id::text, '') = $5`,
        [user.org_id, info.email, p.key, purpose.projectId ?? '', purpose.type === 'personal' ? user.id : '']);
      let accountId: string;
      if (existing) {
        await db.query(`update mail_accounts set oauth_access_token = $2, oauth_refresh_token = $3, oauth_expires_at = $4, sync_error = null where id = $1`, [existing.id, seal(tokens.accessToken), seal(tokens.refreshToken), tokens.expiresAt]);
        accountId = existing.id;
      } else {
        const r = await db.one(
          `insert into mail_accounts (org_id, type, owner_user_id, project_id, managed_user_id, managed_project_id, name, address, provider, oauth_provider, oauth_access_token, oauth_refresh_token, oauth_expires_at, imap_host, imap_port, imap_user, imap_secure, smtp_host, smtp_port, smtp_user, smtp_secure)
           values ($1,$2,$3,$4,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) returning *`,
          [user.org_id, purpose.type, purpose.type === 'personal' ? user.id : null, purpose.projectId, purpose.name ?? info.name ?? info.email, info.email, p.mailProvider, p.key, seal(tokens.accessToken), seal(tokens.refreshToken), tokens.expiresAt,
            p.mailProvider === 'imap' ? p.imap!.host : null, p.mailProvider === 'imap' ? p.imap!.port : null, p.mailProvider === 'imap' ? info.email : null, true,
            p.mailProvider === 'imap' ? p.imap!.smtpHost : null, p.mailProvider === 'imap' ? p.imap!.smtpPort : null, p.mailProvider === 'imap' ? info.email : null, false]
        );
        accountId = r.id;
        // Erste Bindung nach Art: persönlich, Projektpostfach (Standard, wenn das erste), Org-Postfach; zentrales Postfach bleibt ohne Bindung und ist für alle Projekte wählbar
        if (purpose.central) await db.query(`update mail_accounts set offered_to_all = true where id = $1`, [r.id]);
        else await bind(db, r as AccountRow, purpose.type === 'personal' ? 'personal' : purpose.type === 'project' ? 'project' : 'org', { userId: user.id, projectId: purpose.projectId }, user.id);
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
    const verifier = pkceVerifier();
    const state = await newState(reply, null, { kind: 'oidc', next: publicRedirect(req.query.next), verifier });
    const q = new URLSearchParams({ client_id: cfg.clientId, response_type: 'code', redirect_uri: `${publicBase()}/api/auth/oidc/callback`, scope: cfg.scopes.join(' '), state, code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256' });
    return reply.redirect(`${disc.authorization_endpoint}?${q.toString()}`);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>('/auth/oidc/callback', async (req, reply) => {
    const cfg = oidcConfig();
    if (!cfg) throw notFound('Single Sign-on ist nicht konfiguriert');
    const st = await takeState(req, reply);
    if (!st || st.purpose.kind !== 'oidc') return reply.redirect(failTo('/login', 'Anmeldung abgelaufen, bitte erneut versuchen'));
    if (req.query.error || !req.query.code) return reply.redirect(failTo('/login', req.query.error_description ?? req.query.error ?? 'Vom Identitätsanbieter abgelehnt'));
    try {
      const disc = await oidcDiscovery(cfg, app.fetchFn);
      const body = new URLSearchParams({ grant_type: 'authorization_code', code: req.query.code, redirect_uri: `${publicBase()}/api/auth/oidc/callback`, client_id: cfg.clientId, client_secret: cfg.clientSecret, code_verifier: st.purpose.verifier ?? '' });
      const tr = await app.fetchFn(disc.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
      const tj: any = await tr.json().catch(() => ({}));
      if (!tr.ok || !tj.access_token) throw new Error(tj.error_description ?? tj.error ?? `Token ${tr.status}`);
      const ur = await app.fetchFn(disc.userinfo_endpoint, { headers: { authorization: `Bearer ${tj.access_token}` } });
      const u: any = await ur.json().catch(() => ({}));
      if (!ur.ok || !u.sub) throw new Error(`Userinfo ${ur.status}`);
      // Zuordnung und Anlage per E-Mail nur mit geprüfter Adresse (sonst übernimmt, wer beim IdP eine fremde Adresse einträgt, das Konto)
      const emailVerified = u.email_verified === true || u.email_verified === 'true' || cfg.trustEmail;
      const email = emailVerified ? String(u.email ?? '').toLowerCase() : '';
      let row = await db.maybeOne(`select * from users where oidc_subject = $1 and active`, [String(u.sub)]);
      if (!row && email) {
        row = await db.maybeOne(`select * from users where lower(email) = $1 and active and (oidc_subject is null or oidc_subject = $2)`, [email, String(u.sub)]);
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
        if (changes.length) {
          // Gruppen als Projektmitglied folgen (Regel M)
          await syncProjectGroups(db, { userId: row.id });
          await audit(db, { orgId: row.org_id, userId: row.id, action: 'user.groups_synced', objectType: 'user', objectId: row.id, details: { changes } });
        }
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
