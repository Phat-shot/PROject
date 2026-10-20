import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import type { Notification, NotifyEvent, Project, Question } from '@projekttool/shared';
import { NOTIFY_EVENTS } from '@projekttool/shared';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { Tour, tourDone } from './Tour';
import { useAiStatus } from '../lib/useAi';
import { useChatUnread } from '../lib/useChatUnread';
import { useMailUnread } from '../lib/useMailUnread';
import { useIsMobile } from '../lib/useMedia';
import { Messenger, MessengerCtx } from './Messenger';
import { eventLabel, useOpenNotification } from './Notifications';
import { useOpenChat } from './Messenger';

/** Öffnet die Seitenleiste auf schmalen Bildschirmen (Hamburger in der Kopfzeile). */
const MenuCtx = createContext<() => void>(() => undefined);

const MAX_PINNED = 5;
const AREAS_AP = ['board', 'plan', 'kalender', 'besprechungen', 'zeiten', 'auswertung'];
function readFlag(key: string): boolean { try { return localStorage.getItem(key) === '1'; } catch { return false; } }
function writeFlag(key: string, v: boolean) { try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* ignore */ } }

/**
 * Seitenleiste: „PROject“ öffnet das Dashboard. Darunter bis zu fünf angeheftete Projekte (Benutzereinstellung,
 * ohne Auswahl die ersten fünf), „Alle Projekte“ klappt die übrigen untereinander aus. Das gewählte Projekt zeigt seine
 * Bereiche (Arbeitspakete, Postfach, Doku, Risiken, KI, Einstellungen für PL). Danach die globalen Bereiche Postfach,
 * Kalender, Workflows und Chat, dann Einstellungen und Verwaltung.
 * Chat am Desktop: Knopf unten rechts und Leisteneintrag öffnen den Messenger als Overlay; mobil die Seite /chat.
 * Unter 900 px liegt die Leiste als Overlay über der Seite und öffnet sich über das Menü-Symbol in der Kopfzeile.
 */
export function Layout({ children }: { children: ReactNode }) {
  const { user, orgName, logout, setUser } = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  const mobile = useIsMobile();
  const [projects, setProjects] = useState<Project[]>([]);
  const [showAll, setShowAllState] = useState(() => readFlag('pt_all_projects'));
  const setShowAll = (v: boolean) => { setShowAllState(v); writeFlag('pt_all_projects', v); };
  const [menu, setMenu] = useState(false);
  const [tour, setTour] = useState(false);
  const [version, setVersion] = useState('');
  const [chat, setChat] = useState<{ open: boolean; channelId: string | null; threadId: string | null; msgId: string | null }>({ open: false, channelId: null, threadId: null, msgId: null });
  const ai = useAiStatus();
  const unread = useChatUnread();
  const mailUnread = useMailUnread();
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
  useEffect(() => { if (loc.pathname.startsWith('/chat')) setChat((c) => ({ ...c, open: false })); }, [loc.pathname]);

  const saved = user?.settings?.pinnedProjects;
  const pinnedIds = (saved ?? projects.slice(0, MAX_PINNED).map((p) => p.id)).filter((id) => projects.some((p) => p.id === id)).slice(0, MAX_PINNED);
  const pinned = pinnedIds.map((id) => projects.find((p) => p.id === id)!);
  const others = projects.filter((p) => !pinnedIds.includes(p.id));
  const current = currentId && !pinnedIds.includes(currentId) && !showAll ? projects.find((p) => p.id === currentId) ?? null : null;
  const togglePin = async (id: string) => {
    const next = pinnedIds.includes(id) ? pinnedIds.filter((x) => x !== id) : [...pinnedIds, id].slice(0, MAX_PINNED);
    const r = await api.patch<{ user: NonNullable<typeof user> }>('/me', { settings: { pinnedProjects: next } });
    setUser(r.user);
  };
  const openChat = (channelId?: string | null, threadId?: string | null, msgId?: string | null) => {
    if (mobile) { nav(`/chat${channelId ? `/${channelId}` : ''}${threadId ? `?thread=${threadId}${msgId ? `&msg=${msgId}` : ''}` : ''}`); return; }
    setMenu(false);
    setChat((c) => ({ open: true, channelId: channelId === undefined ? c.channelId : channelId, threadId: threadId ?? null, msgId: msgId ?? null }));
  };
  const isActive = (p: string) => loc.pathname === p || loc.pathname.startsWith(p + '/');
  const projectNav = (p: Project, pin: boolean, tourId?: string) => {
    const base = `/projekte/${p.id}`;
    const sel = currentId === p.id;
    return (
      <div key={p.id} className={`proj ${sel ? 'open' : ''}`}>
        <div className="proj-row">
          <NavLink to={`${base}/board`} className={() => (sel ? 'proj-link sel' : 'proj-link')} data-tour={tourId}>
            <span className="badge">{p.key}</span><span className="ell">{p.name}</span>
          </NavLink>
          <button className={`pin ${pin ? 'on' : ''}`} disabled={!pin && pinnedIds.length >= MAX_PINNED} title={pin ? 'Nicht mehr anheften' : pinnedIds.length >= MAX_PINNED ? `Höchstens ${MAX_PINNED} Projekte anheften` : 'Anheften'} aria-label={pin ? 'Nicht mehr anheften' : 'Anheften'} onClick={() => void togglePin(p.id)}>{pin ? '★' : '☆'}</button>
        </div>
        {sel && (
          <div className="sub2">
            <NavLink to={`${base}/board`} data-tour="p-aufgaben" className={() => (AREAS_AP.some((s) => isActive(`${base}/${s}`)) ? 'active' : '')}>Arbeitspakete</NavLink>
            <NavLink to={`${base}/mail`} data-tour="p-postfach">Postfach</NavLink>
            <NavLink to={`${base}/doku`} data-tour="p-doku">Doku</NavLink>
            <NavLink to={`${base}/raid`} data-tour="p-raid">Risiken</NavLink>
            {(ai?.enabled || ai?.killswitch) && <NavLink to={`${base}/ki`} data-tour="p-ki">KI</NavLink>}
            <NavLink to={`${base}/einstellungen`} data-tour="p-einstellungen" className={() => (isActive(`${base}/einstellungen`) ? 'active' : '')}>Einstellungen</NavLink>
          </div>
        )}
      </div>
    );
  };
  return (
    <MessengerCtx.Provider value={openChat}>
    <div className="app">
      {menu && <div className="sidebar-backdrop" onClick={() => setMenu(false)} />}
      <nav className={`sidebar ${menu ? 'open' : ''}`}>
        <div className="brand"><NavLink to="/dashboard" className="brand-link" data-tour="dashboard" title="Dashboard">PROject<small>{orgName}</small></NavLink><button className="close-menu" title="Menü schließen" onClick={() => setMenu(false)}>✕</button></div>
        <div className="sub projects-nav">
          {pinned.map((p, i) => projectNav(p, true, i === 0 ? 'projekt' : undefined))}
          {current && projectNav(current, false)}
          {projects.length > 0 && pinned.length === 0 && !current && <div className="muted small" style={{ padding: '2px 10px 4px' }}>Projekte über ☆ anheften.</div>}
          <div className="navrow">
            <button className="nav-toggle" data-tour="projekte" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
              <span className="caret-ico">{showAll ? '▾' : '▸'}</span> Alle Projekte <span className="muted small">{projects.length}</span>
            </button>
          </div>
          {showAll && <>
            {others.map((p) => projectNav(p, false, pinned.length === 0 && p.id === others[0]?.id ? 'projekt' : undefined))}
            {projects.length === 0 && <div className="muted small" style={{ padding: '4px 22px' }}>Keine aktiven Projekte.</div>}
            <NavLink to="/projekte" end className="proj-link more">Projektübersicht{user && ['org_admin', 'project_creator'].includes(user.globalRole) ? ' · neues Projekt' : ''}</NavLink>
          </>}
        </div>
        <div className="nav-sep" />
        <NavLink to="/postfach" data-tour="postfach"><span>Postfach</span>{mailUnread.total > 0 && <span className="badge danger" style={{ marginLeft: 6 }} title="ungelesene Mails">{mailUnread.total}</span>}</NavLink>
        <NavLink to="/kalender" data-tour="kalender">Kalender</NavLink>
        <NavLink to="/workflows" data-tour="workflows">Workflows</NavLink>
        <NavLink to="/chat" data-tour="chat" className={({ isActive: a }) => (a || chat.open ? 'active' : '')} onClick={(e) => { if (!mobile) { e.preventDefault(); if (chat.open) setChat((c) => ({ ...c, open: false })); else openChat(); } }}>Chat{unread.total > 0 && <span className="badge danger nav-count">{unread.total}</span>}</NavLink>
        <div className="section">Einstellungen</div>
        <NavLink to="/einstellungen" data-tour="benutzer">Meine Einstellungen</NavLink>
        {/* Verwaltung: Org-Admin; mit Org-Recht (KI, Gruppen) oder als Verwalter einer Gruppe nur die passenden Karten */}
        {user && (user.globalRole === 'org_admin' || user.orgRights?.some((r) => r === 'ai_admin' || r === 'groups_admin' || r === 'resources_admin') || user.managesGroups) && <NavLink to="/verwaltung" data-tour="verwaltung">Verwaltung</NavLink>}
        <div className="footer">
          <div>{user?.name}</div>
          <div className="small">{user?.email}</div>
          <div className="row"><button onClick={() => void logout()}>Abmelden</button><button onClick={() => setTour(true)} title="Interaktives Tutorial starten">Tutorial</button><button data-tour="hilfe" onClick={() => nav('/hilfe')} title="Kurzanleitung, Handbuch, KI-Agenten, KI-Sheet">Hilfe</button>{version && <span className="small" title="Build-Version" style={{ marginLeft: 'auto', opacity: 0.6 }}>{version}</span>}</div>
        </div>
      </nav>
      <MenuCtx.Provider value={() => setMenu(true)}>
        <div className="main">{children}</div>
      </MenuCtx.Provider>
      {!mobile && !loc.pathname.startsWith('/chat') && (chat.open
        ? <div className="messenger-overlay" role="dialog" aria-label="Chat"><Messenger channelId={chat.channelId} threadId={chat.threadId} msgId={chat.msgId} onSelect={(channelId, threadId) => setChat({ open: true, channelId, threadId: threadId ?? null, msgId: null })} onClose={() => setChat((c) => ({ ...c, open: false }))} onRead={unread.reload} /></div>
        : <button className="chat-fab" title="Chat öffnen" aria-label="Chat öffnen" onClick={() => openChat()}>
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" /></svg>
            <span>Chat</span>{unread.total > 0 && <span className="badge danger">{unread.total}</span>}
          </button>)}
      {tour && user && <Tour userId={user.id} isAdmin={user.globalRole === 'org_admin'} projects={pinned.length ? pinned : projects} onDone={() => setTour(false)} />}
    </div>
    </MessengerCtx.Provider>
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

/** Glocke: Meldungen mit Filtern (Klasse, Projekt, nur ungelesene); Klick öffnet über openNotification() wie im Dashboard. */
function Bell() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ notifications: Notification[]; unread: number }>({ notifications: [], unread: 0 });
  const [filter, setFilter] = useState<{ event: NotifyEvent | ''; projectId: string; unread: boolean }>({ event: '', projectId: '', unread: false });
  const [projects, setProjects] = useState<Project[]>([]);
  const [tab, setTab] = useState<'all' | 'open'>('all');
  // Offene Fragen an mich (Reiter „Offen für mich“): bleiben, bis jemand antwortet oder sie abgebrochen werden
  const [questions, setQuestions] = useState<Question[]>([]);
  const openChat = useOpenChat();
  const openNotification = useOpenNotification();
  const query = new URLSearchParams({ ...(filter.event ? { event: filter.event } : {}), ...(filter.projectId ? { projectId: filter.projectId } : {}), ...(filter.unread ? { unread: '1' } : {}) }).toString();
  const load = () => Promise.all([
    api.get<{ notifications: Notification[]; unread: number }>(`/notifications${query ? `?${query}` : ''}`).then(setData),
    api.get<{ questions: Question[] }>('/questions?status=open').then((r) => setQuestions(r.questions ?? []))
  ]).catch(() => undefined);
  useEffect(() => { void load(); const h = setInterval(load, 60_000); return () => clearInterval(h); }, [query]);
  useEffect(() => { if (open && !projects.length) api.get<{ projects: Project[] }>('/projects').then((r) => setProjects(r.projects.filter((p) => p.status === 'active'))).catch(() => undefined); }, [open]);
  const go = async (n: Notification) => {
    setOpen(false);
    await openNotification(n);
    await load();
  };
  return (
    <div className="bell" style={{ position: 'relative' }}>
      <button className="btn" title="Benachrichtigungen" aria-label="Benachrichtigungen" onClick={() => setOpen(!open)}>🔔{data.unread > 0 && <span className="dot">{data.unread}</span>}</button>
      {open && (
        <div className="notif-panel">
          <div className="row between" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}><span className="row" style={{ gap: 8 }}><button className={`btn sm ${tab === 'all' ? 'primary' : ''}`} onClick={() => setTab('all')}>Alle</button><button className={`btn sm ${tab === 'open' ? 'primary' : ''}`} title="Fragen, Entscheidungen und Bestätigungen, die auf dich warten" onClick={() => setTab('open')}>Offen für mich{questions.length > 0 && <span className="badge" style={{ marginLeft: 4 }}>{questions.length}</span>}</button></span>{tab === 'all' && data.unread > 0 && <button className="btn sm link" onClick={() => void api.post('/notifications/read', { all: true }).then(load)}>Alle gelesen</button>}</div>
          {tab === 'open' && <div className="question-list" style={{ padding: '4px 12px' }}>
            {questions.length === 0 && <div className="empty" style={{ margin: 12 }}>Nichts offen für dich.</div>}
            {questions.map((q) => <div key={q.id} className="q notif" role="button" tabIndex={0} onClick={() => { setOpen(false); if (q.channelId) openChat(q.channelId, q.messageId, q.messageId); }}>
              <div className="t">{q.kind === 'confirm' ? 'Bestätigung' : q.kind === 'decision' ? 'Entscheidung' : 'Frage'} von {q.askedByName ?? '?'}{q.taskCode ? ` zu ${q.taskCode}` : ''}{q.addresseeId ? '' : ' (Projektkanal)'}</div>
              <div className="b">{q.body.length > 140 ? `${q.body.slice(0, 140)} …` : q.body}</div>
              <div className="b">{new Date(q.createdAt).toLocaleString('de-DE')}{q.remindAt && q.status === 'open' ? ` · Erinnerung ${new Date(q.remindAt).toLocaleDateString('de-DE')}` : ''}</div>
            </div>)}
          </div>}
          {tab === 'all' && <><div className="notif-filter">
            <select aria-label="Klasse" value={filter.event} onChange={(e) => setFilter({ ...filter, event: e.target.value as NotifyEvent | '' })}><option value="">alle Klassen</option>{NOTIFY_EVENTS.map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}</select>
            <select aria-label="Projekt" value={filter.projectId} onChange={(e) => setFilter({ ...filter, projectId: e.target.value })}><option value="">alle Projekte</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.key}</option>)}</select>
            <label className="check small"><input type="checkbox" checked={filter.unread} onChange={(e) => setFilter({ ...filter, unread: e.target.checked })} /> nur ungelesene</label>
          </div>
          {data.notifications.length === 0 && <div className="empty" style={{ margin: 12 }}>Keine Benachrichtigungen.</div>}
          {data.notifications.map((n) => <div key={n.id} className={`notif ${n.readAt ? '' : 'unread'}`} onClick={() => void go(n)}><div className="t">{n.title}</div>{n.body && <div className="b">{n.body}</div>}<div className="b">{eventLabel(n)}{new Date(n.createdAt).toLocaleString('de-DE')}{n.ref?.type === 'question' && !n.resolvedAt ? ' · offen' : ''}</div></div>)}</>}
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
