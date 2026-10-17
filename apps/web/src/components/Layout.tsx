import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import type { Notification, Project } from '@projekttool/shared';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { Tour, tourDone } from './Tour';
import { useAiStatus } from '../lib/useAi';

/** Öffnet die Seitenleiste auf schmalen Bildschirmen (Hamburger in der Kopfzeile). */
const MenuCtx = createContext<() => void>(() => undefined);

/**
 * Seitenleiste: Dashboard, Postfach, „Projekte“ (standardmäßig ausgeklappt) mit Gesamtsicht aller Arbeitspakete
 * und allen aktiven Projekten. Das gewählte Projekt zeigt darunter seine Bereiche (Übersicht, Arbeitspakete,
 * Postfach, Doku, Einstellungen nur für PL). Darunter die Benutzer-Einstellungen und die Verwaltung.
 * Unter 900 px liegt die Leiste als Overlay über der Seite und öffnet sich über das Menü-Symbol in der Kopfzeile.
 */
export function Layout({ children }: { children: ReactNode }) {
  const { user, orgName, logout } = useAuth();
  const loc = useLocation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [open, setOpen] = useState(true);
  const [menu, setMenu] = useState(false);
  const [tour, setTour] = useState(false);
  const [version, setVersion] = useState('');
  const ai = useAiStatus();
  useEffect(() => { api.get<{ version?: string }>('/health').then((r) => setVersion(r.version ?? '')).catch(() => undefined); }, []);
  useEffect(() => { if (user && !tourDone(user.id)) setTour(true); }, [user?.id]);
  const currentId = loc.pathname.match(/^\/projekte\/([0-9a-f-]{36})/)?.[1] ?? null;
  const load = () => api.get<{ projects: Project[] }>('/projects').then((r) => setProjects(r.projects.filter((p) => p.status === 'active'))).catch(() => undefined);
  useEffect(() => { void load(); }, []);
  // Liste auffrischen, wenn ein unbekanntes Projekt geöffnet wird (z. B. direkt nach dem Anlegen) oder die Projektübersicht aufgerufen wird
  useEffect(() => {
    if (loc.pathname === '/projekte' || (currentId && !projects.some((p) => p.id === currentId))) void load();
    setMenu(false);
  }, [loc.pathname]);
  useEffect(() => { if (currentId) setOpen(true); }, [currentId]);
  const isActive = (p: string, end = false) => (end ? loc.pathname === p : loc.pathname === p || loc.pathname.startsWith(p + '/'));
  return (
    <div className="app">
      {menu && <div className="sidebar-backdrop" onClick={() => setMenu(false)} />}
      <nav className={`sidebar ${menu ? 'open' : ''}`}>
        <div className="brand">PROject<small>{orgName}</small><button className="close-menu" title="Menü schließen" onClick={() => setMenu(false)}>✕</button></div>
        <NavLink to="/dashboard" data-tour="dashboard">Dashboard</NavLink>
        <NavLink to="/postfach" data-tour="postfach">Postfach</NavLink>
        <NavLink to="/kalender" data-tour="kalender">Kalender</NavLink>
        <NavLink to="/portfolio" data-tour="portfolio">Portfolio</NavLink>
        <div className={`navrow ${isActive('/projekte', true) ? 'active' : ''}`}>
          <NavLink to="/projekte" end data-tour="projekte">Projekte</NavLink>
          <button className="caret" title={open ? 'Einklappen' : 'Ausklappen'} onClick={() => setOpen(!open)}>{open ? '▾' : '▸'}</button>
        </div>
        {open && (
          <div className="sub">
            <NavLink to="/projekte/aufgaben" data-tour="alle-ap" className="proj-link">Alle Arbeitspakete</NavLink>
            {projects.map((p) => {
              const base = `/projekte/${p.id}`;
              const sel = currentId === p.id;
              return (
                <div key={p.id} className={`proj ${sel ? 'open' : ''}`}>
                  <NavLink to={base} className={() => (sel ? 'proj-link sel' : 'proj-link')} data-tour={p.id === projects[0]?.id ? 'projekt' : undefined}>
                    <span className="badge">{p.key}</span><span className="ell">{p.name}</span>
                  </NavLink>
                  {sel && (
                    <div className="sub2">
                      <NavLink to={base} end data-tour="p-uebersicht">Übersicht</NavLink>
                      <NavLink to={`${base}/board`} data-tour="p-aufgaben" className={() => (['board', 'plan', 'kalender', 'besprechungen', 'zeiten', 'auswertung'].some((s) => isActive(`${base}/${s}`)) ? 'active' : '')}>Arbeitspakete</NavLink>
                      <NavLink to={`${base}/mail`} data-tour="p-postfach">Postfach</NavLink>
                      <NavLink to={`${base}/doku`} data-tour="p-doku">Doku</NavLink>
                      <NavLink to={`${base}/raid`} data-tour="p-raid">Risiken</NavLink>
                      {ai?.enabled && <NavLink to={`${base}/ki`} data-tour="p-ki">KI</NavLink>}
                      {p.myRole === 'pl' && <NavLink to={`${base}/einstellungen`} data-tour="p-einstellungen" className={() => (isActive(`${base}/einstellungen`) || isActive(`${base}/audit`) ? 'active' : '')}>Einstellungen</NavLink>}
                    </div>
                  )}
                </div>
              );
            })}
            {projects.length === 0 && <div className="muted small" style={{ padding: '4px 22px' }}>Keine aktiven Projekte.</div>}
          </div>
        )}
        <div className="section">Einstellungen</div>
        <NavLink to="/einstellungen/benutzer" data-tour="benutzer">Benutzereinstellungen</NavLink>
        <NavLink to="/einstellungen/konfiguration" data-tour="mailkonten">Konfiguration</NavLink>
        {user?.globalRole === 'org_admin' && <NavLink to="/verwaltung" data-tour="verwaltung">Verwaltung</NavLink>}
        <div className="footer">
          <div>{user?.name}</div>
          <div className="small">{user?.email}</div>
          <div className="row"><button onClick={() => void logout()}>Abmelden</button><button onClick={() => setTour(true)} title="Interaktives Tutorial starten">Tutorial</button>{version && <span className="small" title="Build-Version" style={{ marginLeft: 'auto', opacity: 0.6 }}>{version}</span>}</div>
        </div>
      </nav>
      <MenuCtx.Provider value={() => setMenu(true)}>
        <div className="main">{children}</div>
      </MenuCtx.Provider>
      {tour && user && <Tour userId={user.id} isAdmin={user.globalRole === 'org_admin'} projects={projects} onDone={() => setTour(false)} />}
    </div>
  );
}

export function TopBar({ title, children, tabs }: { title: ReactNode; children?: ReactNode; tabs?: { to: string; label: string; end?: boolean }[] }) {
  const openMenu = useContext(MenuCtx);
  return (
    <div className="topbar">
      <button className="menu-btn" title="Menü" aria-label="Menü öffnen" onClick={openMenu}>☰</button>
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
      <Bell />
      {children}
    </div>
  );
}

function Bell() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ notifications: Notification[]; unread: number }>({ notifications: [], unread: 0 });
  const nav = useNavigate();
  const load = () => api.get<{ notifications: Notification[]; unread: number }>('/notifications').then(setData).catch(() => undefined);
  useEffect(() => { void load(); const h = setInterval(load, 60_000); return () => clearInterval(h); }, []);
  const go = async (n: Notification) => {
    await api.post('/notifications/read', { ids: [n.id] });
    setOpen(false);
    await load();
    if (n.link) nav(n.link);
  };
  return (
    <div className="bell" style={{ position: 'relative' }}>
      <button className="btn" title="Benachrichtigungen" aria-label="Benachrichtigungen" onClick={() => setOpen(!open)}>🔔{data.unread > 0 && <span className="dot">{data.unread}</span>}</button>
      {open && (
        <div className="notif-panel">
          <div className="row between" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}><strong>Benachrichtigungen</strong>{data.unread > 0 && <button className="btn sm link" onClick={() => void api.post('/notifications/read', { all: true }).then(load)}>Alle gelesen</button>}</div>
          {data.notifications.length === 0 && <div className="empty" style={{ margin: 12 }}>Keine Benachrichtigungen.</div>}
          {data.notifications.map((n) => <div key={n.id} className={`notif ${n.readAt ? '' : 'unread'}`} onClick={() => void go(n)}><div className="t">{n.title}</div>{n.body && <div className="b">{n.body}</div>}<div className="b">{new Date(n.createdAt).toLocaleString('de-DE')}</div></div>)}
        </div>
      )}
    </div>
  );
}

interface SearchResult {
  tasks: { id: string; title: string; number?: number; projectId: string; projectKey: string }[];
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
      <input type="text" placeholder="Suchen … (auch Kennung wie WEB-12)" value={q} onChange={(e) => setQ(e.target.value)} />
      {res && (
        <div className="search-results">
          {res.tasks.length > 0 && <div className="group">Arbeitspakete</div>}
          {res.tasks.map((t) => <div key={t.id} className="item" onClick={() => go(`/projekte/${t.projectId}/board?task=${t.id}`)}><span className="tkey">{t.projectKey}{t.number ? `-${t.number}` : ''}</span> {t.title}</div>)}
          {res.pages.length > 0 && <div className="group">Seiten</div>}
          {res.pages.map((p) => <div key={p.id} className="item" onClick={() => go(`/projekte/${p.projectId}/doku/${p.id}`)}><span className="badge">{p.projectKey}</span> {p.title}</div>)}
          {res.mails.length > 0 && <div className="group">Mails</div>}
          {res.mails.map((m) => <div key={m.id} className="item" onClick={() => go(`/projekte/${m.projectId}/mail/m/${m.id}`)}>{m.subject} <span className="muted small">· {m.fromAddr}</span></div>)}
          {res.tasks.length + res.pages.length + res.mails.length === 0 && <div className="item muted">Keine Treffer</div>}
        </div>
      )}
    </div>
  );
}
