import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { User } from '@projekttool/shared';
import { api } from './api';

interface AuthState {
  user: User | null;
  orgName: string;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState>({ user: null, orgName: '', loading: true, login: async () => {}, logout: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [orgName, setOrgName] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    api.get<{ user: User; orgName: string }>('/auth/me').then((r) => { setUser(r.user); setOrgName(r.orgName); }).catch(() => setUser(null)).finally(() => setLoading(false));
  }, []);
  const login = async (email: string, password: string) => {
    const r = await api.post<{ user: User; orgName: string }>('/auth/login', { email, password });
    setUser(r.user);
    setOrgName(r.orgName);
  };
  const logout = async () => {
    await api.post('/auth/logout');
    setUser(null);
  };
  return <Ctx.Provider value={{ user, orgName, loading, login, logout }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
