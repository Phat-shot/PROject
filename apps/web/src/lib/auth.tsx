import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { User } from '@projekttool/shared';
import { api } from './api';

interface AuthState {
  user: User | null;
  orgName: string;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (u: User) => void;
}

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

const Ctx = createContext<AuthState>({ user: null, orgName: '', loading: true, login: async () => {}, logout: async () => {}, setUser: () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [orgName, setOrgName] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    applyTheme(initialTheme());
    api.get<{ user: User; orgName: string }>('/auth/me').then((r) => { setUser(r.user); setOrgName(r.orgName); applyTheme(r.user.settings?.theme); }).catch(() => setUser(null)).finally(() => setLoading(false));
  }, []);
  const login = async (email: string, password: string) => {
    const r = await api.post<{ user: User; orgName: string }>('/auth/login', { email, password });
    setUser(r.user);
    setOrgName(r.orgName);
    applyTheme(r.user.settings?.theme);
  };
  const logout = async () => {
    await api.post('/auth/logout');
    setUser(null);
  };
  return <Ctx.Provider value={{ user, orgName, loading, login, logout, setUser }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
