import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { OrgSettings, User } from '@projekttool/shared';
import { api, UNAUTHORIZED } from './api';

interface AuthState {
  user: User | null;
  orgName: string;
  orgSettings: OrgSettings;
  /** Zeiterfassung mandantenweit aktiv */
  timeTracking: boolean;
  loading: boolean;
  /** Die Sitzung ist abgelaufen (HTTP 401 während der Arbeit); die Anmeldeseite zeigt den Hinweis. */
  sessionExpired: boolean;
  /** Benutzer und Mandanten-Einstellungen neu laden (nach dem Speichern in der Verwaltung) */
  refresh: () => Promise<void>;
  /** Löst mit { mfaRequired, challenge } auf, wenn ein zweiter Faktor nötig ist */
  login: (email: string, password: string) => Promise<{ mfaRequired?: boolean; challenge?: string } | void>;
  loginTotp: (challenge: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (u: User) => void;
}

const RETURN_KEY = 'pt_return';
/** Rücksprung-URL nach erneuter Anmeldung merken bzw. lesen (sessionStorage, nur dieser Tab). */
export function rememberReturnUrl(url: string) { try { sessionStorage.setItem(RETURN_KEY, url); } catch { /* ignore */ } }
export function takeReturnUrl(): string | null { try { const v = sessionStorage.getItem(RETURN_KEY); sessionStorage.removeItem(RETURN_KEY); return v; } catch { return null; } }

/** Theme am Dokument setzen: hell, dunkel oder Systemeinstellung. */
export function applyTheme(theme: 'light' | 'dark' | 'system' | undefined) {
  const dark = theme === 'dark' || (theme !== 'light' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try { if (theme) localStorage.setItem('pt_theme', theme); } catch { /* ignore */ }
}

/** Zuletzt gewähltes Theme vor dem Laden des Benutzers anwenden, damit die Seite nicht hell aufblitzt. */
function initialTheme(): 'light' | 'dark' | 'system' {
  try { const v = localStorage.getItem('pt_theme'); if (v === 'light' || v === 'dark' || v === 'system') return v; } catch { /* ignore */ }
  return 'system';
}

const Ctx = createContext<AuthState>({ user: null, orgName: '', orgSettings: {}, timeTracking: true, loading: true, sessionExpired: false, refresh: async () => {}, login: async () => {}, loginTotp: async () => {}, logout: async () => {}, setUser: () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [orgName, setOrgName] = useState('');
  const [orgSettings, setOrgSettings] = useState<OrgSettings>({});
  const [loading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);
  useEffect(() => {
    applyTheme(initialTheme());
    api.get<{ user: User; orgName: string; orgSettings?: OrgSettings }>('/auth/me').then((r) => { setUser(r.user); setOrgName(r.orgName); setOrgSettings(r.orgSettings ?? {}); applyTheme(r.user.settings?.theme); }).catch(() => setUser(null)).finally(() => setLoading(false));
  }, []);
  // Sitzung abgelaufen: Rücksprung merken, abmelden, Anmeldeseite mit Hinweis (App zeigt sie ohne Benutzer)
  useEffect(() => {
    const h = () => {
      setUser((u) => {
        if (u) { rememberReturnUrl(`${window.location.pathname}${window.location.search}`); setSessionExpired(true); }
        return null;
      });
    };
    window.addEventListener(UNAUTHORIZED, h);
    return () => window.removeEventListener(UNAUTHORIZED, h);
  }, []);
  const apply = (r: { user: User; orgName: string; orgSettings?: OrgSettings }) => { setUser(r.user); setOrgName(r.orgName); setOrgSettings(r.orgSettings ?? {}); applyTheme(r.user.settings?.theme); setSessionExpired(false); };
  const login = async (email: string, password: string) => {
    const r = await api.post<{ user?: User; orgName?: string; orgSettings?: OrgSettings; mfaRequired?: boolean; challenge?: string }>('/auth/login', { email, password });
    if (r.mfaRequired) return { mfaRequired: true, challenge: r.challenge };
    apply(r as { user: User; orgName: string; orgSettings?: OrgSettings });
  };
  const loginTotp = async (challenge: string, code: string) => {
    apply(await api.post<{ user: User; orgName: string; orgSettings?: OrgSettings }>('/auth/login/totp', { challenge, code }));
  };
  const logout = async () => {
    await api.post('/auth/logout');
    setSessionExpired(false);
    setUser(null);
  };
  const refresh = async () => { try { apply(await api.get<{ user: User; orgName: string; orgSettings?: OrgSettings }>('/auth/me')); } catch { /* bleibt beim alten Stand */ } };
  return <Ctx.Provider value={{ user, orgName, orgSettings, timeTracking: orgSettings.timeTracking !== false, loading, sessionExpired, refresh, login, loginTotp, logout, setUser }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
