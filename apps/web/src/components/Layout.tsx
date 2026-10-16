import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import type { Project } from '@projekttool/shared';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  useEffect(() => {
    api.get<{ projects: Project[] }>('/projects').then((r) => setProjects(r.projects.filter((p) => p.status === 'active'))).catch(() => undefined);
  }, []);
  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">Projekttool<small>Alpha · Konzept B</small></div>
        <NavLink to="/meine-aufgaben">Meine Aufgaben</NavLink>
        <NavLink to="/projekte" end>Projekte</NavLink>
        <div className="section">Aktive Projekte</div>
        <div className="sub">
          {projects.map((p) => (
            <NavLink key={p.id} to={`/projekte/${p.id}`}>
              <span className="badge">{p.key}</span> {p.name}
            </NavLink>
          ))}
        </div>
        <div className="section">Einstellungen</div>
        <NavLink to="/mail-konten">Mail-Konten</NavLink>
        {user?.globalRole === 'org_admin' && <NavLink to="/verwaltung">Verwaltung</NavLink>}
        <div className="footer">
          <div>{user?.name}</div>
          <div className="small">{user?.email}</div>
          <button onClick={() => void logout()}>Abmelden</button>
        </div>
      </nav>
      <div className="main">{children}</div>
    </div>
  );
}

export function TopBar({ title, children, tabs }: { title: ReactNode; children?: ReactNode; tabs?: { to: string; label: string; end?: boolean }[] }) {
  return (
    <div className="topbar">
      <h1>{title}</h1>
      {tabs && (
        <div className="tabs">
          {tabs.map((t) => (
            <NavLink key={t.to} to={t.to} end={t.end}>
              {t.label}
            </NavLink>
          ))}
        </div>
      )}
      <SearchBox />
      {children}
    </div>
  );
}

interface SearchResult {
  tasks: { id: string; title: string; projectId: string; projectKey: string }[];
  pages: { id: string; title: string; projectId: string; projectKey: string; status: string }[];
  mails: { id: string; subject: string; fromAddr: string; viewId: string; projectId: string }[];
}

function SearchBox() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<SearchResult | null>(null);
  const nav = useNavigate();
  useEffect(() => {
    if (q.trim().length < 2) { setRes(null); return; }
    const h = setTimeout(() => api.get<SearchResult>(`/search?q=${encodeURIComponent(q)}`).then(setRes).catch(() => setRes(null)), 250);
    return () => clearTimeout(h);
  }, [q]);
  const go = (to: string) => { setQ(''); setRes(null); nav(to); };
  return (
    <div className="search-box">
      <input type="text" placeholder="Suchen in Aufgaben, Seiten, Mails …" value={q} onChange={(e) => setQ(e.target.value)} />
      {res && (
        <div className="search-results">
          {res.tasks.length > 0 && <div className="group">Aufgaben</div>}
          {res.tasks.map((t) => <div key={t.id} className="item" onClick={() => go(`/projekte/${t.projectId}?task=${t.id}`)}><span className="badge">{t.projectKey}</span> {t.title}</div>)}
          {res.pages.length > 0 && <div className="group">Seiten</div>}
          {res.pages.map((p) => <div key={p.id} className="item" onClick={() => go(`/projekte/${p.projectId}/doku/${p.id}`)}><span className="badge">{p.projectKey}</span> {p.title}</div>)}
          {res.mails.length > 0 && <div className="group">Mails</div>}
          {res.mails.map((m) => <div key={m.id} className="item" onClick={() => go(`/projekte/${m.projectId}/mail/${m.viewId}/${m.id}`)}>{m.subject} <span className="muted small">· {m.fromAddr}</span></div>)}
          {res.tasks.length + res.pages.length + res.mails.length === 0 && <div className="item muted">Keine Treffer</div>}
        </div>
      )}
    </div>
  );
}
