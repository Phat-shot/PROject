import { useMemo } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import type { Notification, Project, TimeEntry } from '@projekttool/shared';
import { useData } from '../lib/useData';
import { useAuth } from '../lib/auth';
import { fmtDate, today } from '../lib/api';
import { TopBar } from '../components/Layout';
import { buildWorkTree, useShowDone, WorkTree, type WorkItem, type WorkProject } from './WorkTree';
import { PortfolioView } from './PortfolioPage';
import { AllTasksView } from './AllTasksPage';
import { ProjectScope } from './ProjectPage';
import { OverviewView } from './project/OverviewView';
import { NotificationRow } from '../components/Notifications';

/**
 * Dashboard (nur global, filterbar nach Projekt über ?projekt=): Reiter Meine Arbeit, Projekte (Ampel, Fortschritt,
 * Auslastung; früher Portfolio) und Alle Arbeitspakete. Mit Projektfilter zeigt „Meine Arbeit“ das Projekt-Dashboard
 * (Kennzahlen, Warnungen, Meilensteine, Aktivität) und darunter die eigene Arbeit in diesem Projekt.
 */
export function DashboardPage() {
  const loc = useLocation();
  const [params, setParams] = useSearchParams();
  const pf = params.get('projekt') ?? '';
  const projects = useData<{ projects: Project[] }>('/projects');
  const active = (projects.data?.projects ?? []).filter((p) => p.status === 'active');
  const project = active.find((p) => p.id === pf) ?? null;
  const tab = loc.pathname.startsWith('/dashboard/projekte') ? 'projekte' : loc.pathname.startsWith('/dashboard/arbeitspakete') ? 'aps' : 'mine';
  const qs = pf ? `?projekt=${pf}` : '';
  const setProject = (id: string) => { const n = new URLSearchParams(params); if (id) n.set('projekt', id); else n.delete('projekt'); setParams(n, { replace: true }); };
  return (
    <>
      <TopBar title="Dashboard" tabs={[{ to: `/dashboard${qs}`, label: 'Meine Arbeit', end: true }, { to: `/dashboard/projekte${qs}`, label: 'Projekte' }, { to: `/dashboard/arbeitspakete${qs}`, label: 'Alle Arbeitspakete' }]} />
      <div className="content">
        <div className="filterbar mb">
          <select value={pf} onChange={(e) => setProject(e.target.value)} aria-label="Projektfilter" data-tour="dashboard-filter">
            <option value="">Alle Projekte</option>
            {active.map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}
          </select>
          {project && <><Link className="chip" to={`/projekte/${project.id}/board`}>Zu den Arbeitspaketen</Link><button className="chip" onClick={() => setProject('')}>Filter aufheben</button></>}
        </div>
        {pf && projects.data && !project && <div className="notice mb">Projekt nicht gefunden oder nicht aktiv.</div>}
        {tab === 'projekte' && <PortfolioView projectId={project?.id ?? null} />}
        {tab === 'aps' && <AllTasksView projectId={project?.id ?? null} />}
        {tab === 'mine' && (project
          ? <ProjectScope projectId={project.id}><OverviewView /><MyWork projectId={project.id} /></ProjectScope>
          : <MyWork projectId={null} />)}
      </div>
    </>
  );
}

/** Soll/Ist meiner Arbeit (über alle Projekte oder eines), danach die geklammerte Sicht Projekt › Teilprojekt › Arbeitspaket › Aufgabe › Task. */
function MyWork({ projectId }: { projectId: string | null }) {
  const { user, timeTracking } = useAuth();
  const work = useData<{ projects: WorkProject[] }>('/my/work');
  const notes = useData<{ notifications: Notification[]; unread: number }>('/notifications');
  const waiting = useData<{ drafts: { projectId: string; projectKey: string; count: number }[]; pagesInReview: { id: string; title: string; projectId: string; projectKey: string }[]; tasks: { id: string; number: number; title: string; projectId: string; projectKey: string; blocked: boolean; escalationLevel: number }[] }>('/my/waiting');
  const time = useData<{ entries: (TimeEntry & { projectKey: string })[]; totalMinutes: number }>(timeTracking ? '/my/time' : null);
  const { showDone, setShowDone } = useShowDone();
  const t = today();
  const week = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
  const scoped = useMemo(() => (work.data?.projects ?? []).filter((p) => !projectId || p.id === projectId), [work.data, projectId]);
  const nodes = useMemo(() => buildWorkTree(scoped, user?.id, showDone), [scoped, user?.id, showDone]);
  const all = useMemo(() => buildWorkTree(scoped, user?.id, true), [scoped, user?.id]);
  // Arbeitspakete und Aufgaben, die mir zugewiesen oder vererbt sind oder eigene Tasks haben (Aufgaben zählen wie Arbeitspakete)
  const flat = (i: WorkItem): WorkItem[] => [...(i.mine || i.tasks.length ? [i] : []), ...i.subs.flatMap(flat)];
  const aps = all.flatMap((n) => n.lanes.flatMap((l) => l.items.flatMap(flat)));
  const open = aps.filter((x) => !x.ap.done);
  const overdue = open.filter((x) => x.ap.dueDate && x.ap.dueDate < t);
  const dueWeek = open.filter((x) => x.ap.dueDate && x.ap.dueDate >= t && x.ap.dueDate <= week);
  const noDue = open.filter((x) => !x.ap.dueDate);
  const trouble = open.filter((x) => x.ap.blocked || x.ap.escalationLevel > 0 || x.ap.conflicts.length > 0);
  const inPlan = open.length - overdue.length;
  const pct = open.length ? Math.round((inPlan / open.length) * 100) : 100;
  const tasksOpen = aps.flatMap((x) => x.tasks).filter((x) => !x.item.done).length;
  const perProject = all.map((n) => {
    const items = n.lanes.flatMap((l) => l.items.flatMap(flat)).filter((x) => !x.ap.done);
    return { id: n.p.id, key: n.p.key, name: n.p.name, open: items.length, overdue: items.filter((x) => x.ap.dueDate && x.ap.dueDate < t).length, lead: n.leadIsMe };
  }).filter((p) => p.open > 0 || p.lead);
  const upcoming = [...open].filter((x) => x.ap.dueDate).sort((a, b) => a.ap.dueDate!.localeCompare(b.ap.dueDate!)).slice(0, 8);
  const h = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} h`;
  const list = (extra: string) => `/dashboard/arbeitspakete?mine=1${projectId ? `&projekt=${projectId}` : ''}${extra}`;
  const waitingIn = <T extends { projectId: string }>(xs: T[] | undefined) => (xs ?? []).filter((x) => !projectId || x.projectId === projectId);
  if (projectId) {
    // Im Projekt-Dashboard steht Soll/Ist schon oben; hier nur die eigene Arbeit in diesem Projekt
    return (
      <div className="mt">
        <div className="row mb">
          <h2 style={{ margin: 0 }}>Meine Arbeit in diesem Projekt</h2>
          <span className="muted small">{open.length} offen{overdue.length ? ` · ${overdue.length} überfällig` : ''}{tasksOpen ? ` · ${tasksOpen} Tasks` : ''}</span>
          <label className="check small right"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> erledigte zeigen</label>
        </div>
        {work.data && <WorkTree nodes={nodes} reload={work.reload} />}
      </div>
    );
  }
  return (
    <>
      <div>
        {work.error && <div className="error mb">{work.error}</div>}
        <div className="kpis mb">
          <Link className="kpi" to={list('')} title="Als Liste öffnen"><div className="v">{open.length}</div><div className="l">offene Arbeitspakete</div></Link>
          <Link className={`kpi ${overdue.length ? 'bad' : 'ok'}`} to={list('&filter=overdue')} title="Als Liste öffnen"><div className="v">{overdue.length}</div><div className="l">überfällig</div></Link>
          <Link className={`kpi ${dueWeek.length ? 'warn' : ''}`} to={list('&filter=week')} title="Als Liste öffnen"><div className="v">{dueWeek.length}</div><div className="l">fällig in 7 Tagen</div></Link>
          <Link className={`kpi ${trouble.length ? 'bad' : 'ok'}`} to={list('&filter=trouble')} title="Als Liste öffnen"><div className="v">{trouble.length}</div><div className="l">blockiert / eskaliert / Konflikt</div></Link>
          <div className={`kpi ${pct < 80 ? 'warn' : 'ok'}`}><div className="v">{pct}%</div><div className="l">im Plan ({inPlan}/{open.length} Soll erreicht)</div></div>
          <div className="kpi"><div className="v">{tasksOpen}</div><div className="l">offene Tasks</div></div>
          <div className={`kpi ${notes.data?.unread ? 'warn' : ''}`}><div className="v">{notes.data?.unread ?? 0}</div><div className="l">ungelesene Meldungen</div></div>
          {time.data && time.data.totalMinutes > 0 && <div className="kpi"><div className="v">{h(time.data.totalMinutes)}</div><div className="l">gebucht, 7 Tage</div></div>}
        </div>
        <div className="grid cols-2 mb">
          <div className="card">
            <h2>Soll / Ist je Projekt</h2>
            {perProject.length === 0 && <div className="muted small">Keine offenen Arbeitspakete.</div>}
            {perProject.map((p) => (
              <div key={p.id} className="mb">
                <div className="row between small"><Link to={`/dashboard?projekt=${p.id}`} title="Projekt-Dashboard"><span className="badge">{p.key}</span> {p.name}</Link><span className="muted">{p.open - p.overdue}/{p.open} im Plan{p.overdue ? <span style={{ color: 'var(--danger)' }}> · {p.overdue} überfällig</span> : ''}</span></div>
                <div className="bar"><div className="done" style={{ width: `${p.open ? ((p.open - p.overdue) / p.open) * 100 : 100}%` }} /><div className="over" style={{ width: `${p.open ? (p.overdue / p.open) * 100 : 0}%` }} /></div>
              </div>
            ))}
            {noDue.length > 0 && <p className="muted small">{noDue.length} offene Arbeitspakete ohne Termin.</p>}
          </div>
          <div className="card">
            <h2>Nächste Termine</h2>
            {upcoming.length === 0 ? <div className="muted small">Keine Termine.</div> : (
              <table className="table"><tbody>
                {upcoming.map(({ ap }) => <tr key={ap.id}><td className="nowrap" style={ap.dueDate! < t ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>{fmtDate(ap.dueDate)}</td><td><Link to={`/projekte/${ap.projectId}/board?task=${ap.id}`}>{ap.title}</Link></td></tr>)}
              </tbody></table>
            )}
          </div>
          <div className="card">
            <h2>Wartet auf dich</h2>
            {waiting.data && waiting.data.drafts.length + waiting.data.pagesInReview.length + waiting.data.tasks.length === 0 && <div className="muted small">Nichts offen.</div>}
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
              {waitingIn(waiting.data?.drafts).map((d) => <li key={d.projectId}><Link to={`/projekte/${d.projectId}/mail/freigaben`}><span className="badge">{d.projectKey}</span> {d.count} Mail-Entwürfe zur Freigabe</Link></li>)}
              {waitingIn(waiting.data?.pagesInReview).map((p) => <li key={p.id}><Link to={`/projekte/${p.projectId}/doku/${p.id}`}><span className="badge">{p.projectKey}</span> Seite „{p.title}“ in Prüfung</Link></li>)}
              {waitingIn(waiting.data?.tasks).map((x) => <li key={x.id}><Link to={`/projekte/${x.projectId}/board?task=${x.id}`}><span className="tkey">{x.projectKey}-{x.number}</span> {x.title}</Link> {x.blocked && <span className="badge blocked">blockiert</span>}{x.escalationLevel > 0 && <span className="badge danger">Esk. {x.escalationLevel}</span>}</li>)}
            </ul>
          </div>
          <div className="card">
            <h2>Meldungen {notes.data && notes.data.unread > 0 && <span className="badge warn">{notes.data.unread} neu</span>}</h2>
            {(notes.data?.notifications ?? []).slice(0, 6).map((n) => <NotificationRow key={n.id} n={n} onOpened={() => void notes.reload()} />)}
            {notes.data && notes.data.notifications.length === 0 && <div className="muted small">Keine Meldungen.</div>}
          </div>
        </div>
        <div className="row mb">
          <h2 style={{ margin: 0 }}>Meine Arbeit</h2>
          <span className="muted small">Projekt › Teilprojekt › Arbeitspaket › Aufgabe › Task, nur was dir zugewiesen oder vererbt ist</span>
          <label className="check small right"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> erledigte zeigen</label>
          <Link className="btn sm" to="/dashboard/arbeitspakete">Alle Arbeitspakete</Link>
        </div>
        {work.data && <WorkTree nodes={nodes} reload={work.reload} />}
      </div>
    </>
  );
}
