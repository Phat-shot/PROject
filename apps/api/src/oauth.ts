import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { publicBase } from './docs/share.js';

/**
 * OAuth2-Anbieter für Mail-Konten (Authorization-Code mit Refresh-Token) und OIDC-Anmeldung.
 * Konfiguration über Umgebungsvariablen; ohne Werte sind die Knöpfe in der Oberfläche ausgeblendet.
 */
export type OAuthProviderKey = 'microsoft' | 'google';

export interface OAuthProviderCfg {
  key: OAuthProviderKey;
  label: string;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Liefert die Mail-Adresse des verbundenen Kontos */
  userinfo: (accessToken: string, fetchFn: typeof fetch) => Promise<{ email: string; name: string | null }>;
  /** Welcher Mail-Adapter das Konto bedient */
  mailProvider: 'graph' | 'imap';
  imap?: { host: string; port: number; smtpHost: string; smtpPort: number };
  extraAuthParams?: Record<string, string>;
}

export function oauthProviders(env = process.env): OAuthProviderCfg[] {
  const out: OAuthProviderCfg[] = [];
  if (env.OAUTH_MS_CLIENT_ID && env.OAUTH_MS_CLIENT_SECRET) {
    const tenant = env.OAUTH_MS_TENANT || 'common';
    const useImap = env.OAUTH_MS_MODE === 'imap';
    out.push({
      key: 'microsoft', label: 'Microsoft 365', clientId: env.OAUTH_MS_CLIENT_ID, clientSecret: env.OAUTH_MS_CLIENT_SECRET,
      authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`, tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      scopes: useImap ? ['offline_access', 'openid', 'email', 'https://outlook.office.com/IMAP.AccessAsUser.All', 'https://outlook.office.com/SMTP.Send'] : ['offline_access', 'openid', 'email', 'User.Read', 'Mail.ReadWrite', 'Mail.Send', 'Calendars.ReadWrite'],
      userinfo: async (token, f) => {
        const r = await f('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName', { headers: { authorization: `Bearer ${token}` } });
        if (!r.ok) throw new Error(`Graph /me: ${r.status}`);
        const j: any = await r.json();
        return { email: String(j.mail ?? j.userPrincipalName).toLowerCase(), name: j.displayName ?? null };
      },
      mailProvider: useImap ? 'imap' : 'graph',
      imap: { host: 'outlook.office365.com', port: 993, smtpHost: 'smtp.office365.com', smtpPort: 587 },
      extraAuthParams: { prompt: 'select_account' }
    });
  }
  if (env.OAUTH_GOOGLE_CLIENT_ID && env.OAUTH_GOOGLE_CLIENT_SECRET) {
    out.push({
      key: 'google', label: 'Google Workspace', clientId: env.OAUTH_GOOGLE_CLIENT_ID, clientSecret: env.OAUTH_GOOGLE_CLIENT_SECRET,
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['openid', 'email', 'https://mail.google.com/', 'https://www.googleapis.com/auth/calendar.events'],
      userinfo: async (token, f) => {
        const r = await f('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${token}` } });
        if (!r.ok) throw new Error(`Google userinfo: ${r.status}`);
        const j: any = await r.json();
        return { email: String(j.email).toLowerCase(), name: j.name ?? null };
      },
      mailProvider: 'imap',
      imap: { host: 'imap.gmail.com', port: 993, smtpHost: 'smtp.gmail.com', smtpPort: 587 },
      extraAuthParams: { access_type: 'offline', prompt: 'consent' }
    });
  }
  return out;
}

export const redirectUri = (key: string) => `${publicBase()}/api/oauth/callback/${key}`;
/** Nur relative Pfade als Ziel nach der Anmeldung (kein Open Redirect). */
export const publicRedirect = (next: string | undefined) => (next && /^\/(?!\/)/.test(next) ? next : '/');

/** PKCE (S256): Verifier bleibt im State auf dem Server, der Anbieter bekommt nur die Challenge */
export const pkceVerifier = () => randomBytes(32).toString('base64url');
export const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export function authorizeUrl(p: OAuthProviderCfg, state: string, verifier: string): string {
  const q = new URLSearchParams({ client_id: p.clientId, response_type: 'code', redirect_uri: redirectUri(p.key), scope: p.scopes.join(' '), state, code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256', ...(p.extraAuthParams ?? {}) });
  return `${p.authorizeUrl}?${q.toString()}`;
}

export interface TokenSet { accessToken: string; refreshToken: string | null; expiresAt: Date }

export async function exchangeCode(p: OAuthProviderCfg, code: string, verifier: string, fetchFn: typeof fetch = fetch): Promise<TokenSet> {
  return tokenRequest(p, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(p.key), code_verifier: verifier }, fetchFn);
}
export async function refreshTokens(p: OAuthProviderCfg, refreshToken: string, fetchFn: typeof fetch = fetch): Promise<TokenSet> {
  const t = await tokenRequest(p, { grant_type: 'refresh_token', refresh_token: refreshToken }, fetchFn);
  return { ...t, refreshToken: t.refreshToken ?? refreshToken };
}
async function tokenRequest(p: OAuthProviderCfg, params: Record<string, string>, fetchFn: typeof fetch): Promise<TokenSet> {
  const body = new URLSearchParams({ client_id: p.clientId, client_secret: p.clientSecret, ...params });
  const r = await fetchFn(p.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Token-Anfrage fehlgeschlagen: ${j.error_description ?? j.error ?? r.status}`);
  return { accessToken: j.access_token, refreshToken: j.refresh_token ?? null, expiresAt: new Date(Date.now() + (Number(j.expires_in) || 3600) * 1000) };
}

/** OIDC-Anmeldung (Keycloak, Entra ID, Authentik …) über Discovery; Benutzer werden per E-Mail zugeordnet. */
/** trustEmail: IdP liefert nur geprüfte Adressen, aber kein email_verified (z. B. Entra ID mit einem Tenant) */
export interface OidcCfg { issuer: string; clientId: string; clientSecret: string; label: string; autoCreate: boolean; trustEmail: boolean; scopes: string[]; groupsClaim: string; /** Org für automatisch angelegte Benutzer (OIDC_ORG_ID); leer = nur bei genau einer Org */ orgId: string | null }
export function oidcConfig(env = process.env): OidcCfg | null {
  if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET) return null;
  return { issuer: env.OIDC_ISSUER.replace(/\/$/, ''), clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET, label: env.OIDC_LABEL || 'Single Sign-on', autoCreate: env.OIDC_AUTO_CREATE === 'true', trustEmail: env.OIDC_TRUST_EMAIL === 'true', scopes: (env.OIDC_SCOPES || 'openid email profile').split(/\s+/), groupsClaim: env.OIDC_GROUPS_CLAIM || 'groups', orgId: env.OIDC_ORG_ID?.trim() || null };
}
export interface OidcDiscovery { issuer: string; authorization_endpoint: string; token_endpoint: string; userinfo_endpoint: string; jwks_uri: string }
let discoveryCache: { issuer: string; doc: OidcDiscovery; at: number } | null = null;
/** Discovery-Dokument; der dort genannte issuer muss OIDC_ISSUER entsprechen (sonst gilt ein fremdes Dokument als Anbieter). */
export async function oidcDiscovery(cfg: OidcCfg, fetchFn: typeof fetch = fetch): Promise<OidcDiscovery> {
  if (discoveryCache && discoveryCache.issuer === cfg.issuer && Date.now() - discoveryCache.at < 3600_000) return discoveryCache.doc;
  const r = await fetchFn(`${cfg.issuer}/.well-known/openid-configuration`);
  if (!r.ok) throw new Error(`OIDC-Discovery fehlgeschlagen: ${r.status}`);
  const doc: any = await r.json();
  if (typeof doc?.issuer !== 'string' || doc.issuer.replace(/\/$/, '') !== cfg.issuer) throw new Error(`OIDC-Discovery: issuer „${String(doc?.issuer ?? '')}“ passt nicht zu OIDC_ISSUER`);
  for (const k of ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint', 'jwks_uri']) if (typeof doc[k] !== 'string' || !/^https?:\/\//.test(doc[k])) throw new Error(`OIDC-Discovery: ${k} fehlt`);
  discoveryCache = { issuer: cfg.issuer, doc, at: Date.now() };
  return doc;
}

/** Nur für Tests: Discovery- und JWKS-Cache leeren. */
export function resetOidcCaches(): void { discoveryCache = null; jwksCache = null; }

/** Nonce für das ID-Token: beim Start erzeugt, im State (Server) und damit am Cookie des startenden Browsers gebunden. */
export const oidcNonce = () => randomBytes(24).toString('base64url');

const b64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
let jwksCache: { uri: string; keys: Map<string, { key: KeyObject; alg?: string; kty: string }>; at: number } | null = null;
async function loadJwks(uri: string, fetchFn: typeof fetch, force = false): Promise<Map<string, { key: KeyObject; alg?: string; kty: string }>> {
  if (!force && jwksCache && jwksCache.uri === uri && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const r = await fetchFn(uri);
  if (!r.ok) throw new Error(`OIDC-JWKS nicht abrufbar: ${r.status}`);
  const j: any = await r.json();
  const keys = new Map<string, { key: KeyObject; alg?: string; kty: string }>();
  for (const k of Array.isArray(j?.keys) ? j.keys : []) {
    if (k?.use && k.use !== 'sig') continue;
    if (k?.kty !== 'RSA' && k?.kty !== 'EC') continue;
    try { keys.set(String(k.kid ?? ''), { key: createPublicKey({ key: k, format: 'jwk' }), alg: k.alg, kty: k.kty }); } catch { /* unbrauchbarer Schlüssel */ }
  }
  jwksCache = { uri, keys, at: Date.now() };
  return keys;
}

export interface IdTokenClaims { sub: string; iss: string; aud: string | string[]; exp: number; nonce?: string; email?: string; email_verified?: boolean | string; name?: string; preferred_username?: string; [k: string]: unknown }

/**
 * ID-Token prüfen (OIDC Core 3.1.3.7): Signatur über die JWKS der Discovery (RS256 oder ES256), iss = Issuer, aud enthält
 * die Client-ID (bei mehreren Audiences azp = Client-ID), exp in der Zukunft, nonce = beim Start erzeugter Wert.
 */
export async function verifyIdToken(cfg: OidcCfg, disc: OidcDiscovery, idToken: string, expectedNonce: string, fetchFn: typeof fetch = fetch, now = Date.now()): Promise<IdTokenClaims> {
  const parts = String(idToken ?? '').split('.');
  if (parts.length !== 3) throw new Error('ID-Token: kein JWT');
  let header: any, claims: any;
  try { header = JSON.parse(b64url(parts[0]).toString('utf8')); claims = JSON.parse(b64url(parts[1]).toString('utf8')); } catch { throw new Error('ID-Token: nicht lesbar'); }
  const alg = String(header?.alg ?? '');
  if (alg !== 'RS256' && alg !== 'ES256') throw new Error(`ID-Token: Algorithmus ${alg || '(leer)'} nicht erlaubt (RS256, ES256)`);
  const kid = String(header?.kid ?? '');
  let keys = await loadJwks(disc.jwks_uri, fetchFn);
  let entry = keys.get(kid) ?? (keys.size === 1 && !kid ? [...keys.values()][0] : undefined);
  if (!entry) { keys = await loadJwks(disc.jwks_uri, fetchFn, true); entry = keys.get(kid) ?? (keys.size === 1 && !kid ? [...keys.values()][0] : undefined); }
  if (!entry) throw new Error('ID-Token: Signaturschlüssel unbekannt');
  if ((alg === 'RS256' && entry.kty !== 'RSA') || (alg === 'ES256' && entry.kty !== 'EC')) throw new Error('ID-Token: Schlüsseltyp passt nicht zum Algorithmus');
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const ok = alg === 'RS256'
    ? cryptoVerify('sha256', data, entry.key, b64url(parts[2]))
    : cryptoVerify('sha256', data, { key: entry.key, dsaEncoding: 'ieee-p1363' }, b64url(parts[2]));
  if (!ok) throw new Error('ID-Token: Signatur ungültig');
  if (String(claims?.iss ?? '').replace(/\/$/, '') !== cfg.issuer) throw new Error('ID-Token: Aussteller passt nicht');
  const aud: string[] = Array.isArray(claims?.aud) ? claims.aud.map(String) : [String(claims?.aud ?? '')];
  if (!aud.includes(cfg.clientId)) throw new Error('ID-Token: nicht für diesen Client ausgestellt');
  if (aud.length > 1 && String(claims?.azp ?? '') !== cfg.clientId) throw new Error('ID-Token: azp passt nicht');
  if (!Number.isFinite(Number(claims?.exp)) || Number(claims.exp) * 1000 <= now - 60_000) throw new Error('ID-Token: abgelaufen');
  const nonce = String(claims?.nonce ?? ''); const exp = String(expectedNonce ?? '');
  if (!nonce || nonce.length !== exp.length || !timingSafeEqual(Buffer.from(nonce), Buffer.from(exp))) throw new Error('ID-Token: nonce passt nicht');
  if (!claims?.sub) throw new Error('ID-Token: sub fehlt');
  return claims as IdTokenClaims;
}
