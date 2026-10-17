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
      scopes: useImap ? ['offline_access', 'openid', 'email', 'https://outlook.office.com/IMAP.AccessAsUser.All', 'https://outlook.office.com/SMTP.Send'] : ['offline_access', 'openid', 'email', 'User.Read', 'Mail.ReadWrite', 'Mail.Send'],
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
      scopes: ['openid', 'email', 'https://mail.google.com/'],
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

export function authorizeUrl(p: OAuthProviderCfg, state: string): string {
  const q = new URLSearchParams({ client_id: p.clientId, response_type: 'code', redirect_uri: redirectUri(p.key), scope: p.scopes.join(' '), state, ...(p.extraAuthParams ?? {}) });
  return `${p.authorizeUrl}?${q.toString()}`;
}

export interface TokenSet { accessToken: string; refreshToken: string | null; expiresAt: Date }

export async function exchangeCode(p: OAuthProviderCfg, code: string, fetchFn: typeof fetch = fetch): Promise<TokenSet> {
  return tokenRequest(p, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(p.key) }, fetchFn);
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
export interface OidcCfg { issuer: string; clientId: string; clientSecret: string; label: string; autoCreate: boolean; scopes: string[] }
export function oidcConfig(env = process.env): OidcCfg | null {
  if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET) return null;
  return { issuer: env.OIDC_ISSUER.replace(/\/$/, ''), clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET, label: env.OIDC_LABEL || 'Single Sign-on', autoCreate: env.OIDC_AUTO_CREATE === 'true', scopes: (env.OIDC_SCOPES || 'openid email profile').split(/\s+/) };
}
let discoveryCache: { issuer: string; doc: any; at: number } | null = null;
export async function oidcDiscovery(cfg: OidcCfg, fetchFn: typeof fetch = fetch): Promise<{ authorization_endpoint: string; token_endpoint: string; userinfo_endpoint: string }> {
  if (discoveryCache && discoveryCache.issuer === cfg.issuer && Date.now() - discoveryCache.at < 3600_000) return discoveryCache.doc;
  const r = await fetchFn(`${cfg.issuer}/.well-known/openid-configuration`);
  if (!r.ok) throw new Error(`OIDC-Discovery fehlgeschlagen: ${r.status}`);
  const doc: any = await r.json();
  discoveryCache = { issuer: cfg.issuer, doc, at: Date.now() };
  return doc;
}
