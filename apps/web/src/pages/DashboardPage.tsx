import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { Notification, TimeEntry } from '@projekttool/shared';
import { useData } from '../lib/useData';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtDateTime, today } from '../lib/api';
import { TopBar } from '../components/Layout';
import { buildWorkTree, useShowDone, WorkTree, type WorkProject } from './WorkTree';

/**
 * Dashboard: Soll/Ist meiner Arbeit über alle Projekte (analog zur Projekt-Übersicht),
 * danach die geklammerte Sicht Projekt › Teilprojekt › Arbeitspaket › Task.
 */
export function DashboardPage() {
  const { user } = useAuth();
  const work = useData<{ projects: WorkProject[] }>('/my/work');
  const notes = useData<{ notifications: Notification[]; unread: number }>('/notifications');
  const time = useData<{ entries: (TimeEntry & { projectKey: string })[]; totalMinutes: number }>('/my/time');
  const { showDone, setShowDone } = useShowDone();
  const t = today();
  const week = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
  const nodes = useMemo(() => buildWorkTree(work.data?.projects ?? [], user?.id, showDone), [work.data, user?.id, showDone]);
  const all = useMemo(() => buildWorkTree(work.data?.projects ?? [], user?.id, true), [work.data, user?.id]);
  const aps = all.flatMap((n) => n.lanes.flatMap((l) => l.items));
  const open = aps.filter((x) => !x.ap.done);
  const overdue = open.filter((x) => x.ap.dueDate && x.ap.dueDate < t);
  const dueWeek = open.filter((x) => x.ap.dueDate && x.ap.dueDate >= t && x.ap.dueDate <= week);
  const noDue = open.filter((x) => !x.ap.dueDate);
  const trouble = open.filter((x) => x.ap.blocked || x.ap.escalationLevel > 0 || x.ap.conflicts.length > 0);
  const inPlan = open.length - overdue.length;
  const pct = open.length ? Math.round((inPlan / open.length) * 100) : 100;
  const tasksOpen = aps.flatMap((x) => x.tasks).filter((x) => !x.item.done).length;
  const perProject = all.map((n) => {
    const items = n.lanes.flatMap((l) => l.items).filter((x) => !x.ap.done);
    return { id: n.p.id, key: n.p.key, name: n.p.name, open: items.length, overdue: items.filter((x) => x.ap.dueDate && x.ap.dueDate < t).length, lead: n.leadIsMe };
  }).filter((p) => p.open > 0 || p.lead);
  const upcoming = [...open].filter((x) => x.ap.dueDate).sort((a, b) => a.ap.dueDate!.localeCompare(b.ap.dueDate!)).slice(0, 8);
  const h = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} h`;
  return (
    <>
      <TopBar title="Dashboard" />
      <div className="content">
        {work.error && <div className="error mb">{work.error}</div>}
        <div className="kpis mb">
          <div className="kpi"><div className="v">{open.length}</div><div className="l">offene Arbeitspakete</div></div>
          <div className={`kpi ${overdue.length ? 'bad' : 'ok'}`}><div className="v">{overdue.length}</div><div className="l">überfällig</div></div>
          <div className={`kpi ${dueWeek.length ? 'warn' : ''}`}><div className="v">{dueWeek.length}</div><div className="l">fällig in 7 Tagen</div></div>
          <div className={`kpi ${trouble.length ? 'bad' : 'ok'}`}><div className="v">{trouble.length}</div><div className="l">blockiert / eskaliert / Konflikt</div></div>
          <div className={`kpi ${pct < 80 ? 'warn' : 'ok'}`}><div className="v">{pct}%</div><div className="l">im Plan ({inPlan}/{open.length} Soll erreicht)</div></div>
          <div className="kpi"><div className="v">{tasksOpen}</div><div className="l">offene Tasks</div></div>
          <div className={`kpi ${notes.data?.unread ? 'warn' : ''}`}><div className="v">{notes.data?.unread ?? 0}</div><div className="l">ungelesene Meldungen</div></div>
          {time.data && time.data.totalMinutes > 0 && <div className="kpi"><div className="v">{h(time.data.totalMinutes)}</div><div className="l">gebucht, 7 Tage</div></div>}
        </div>
        <div className="grid cols-3 mb">
          <div className="card">
            <h2>Soll / Ist je Projekt</h2>
            {perProject.length === 0 && <div className="muted small">Keine offenen Arbeitspakete.</div>}
            {perProject.map((p) => (
              <div key={p.id} className="mb">
                <div className="row between small"><Link to={`/projekte/${p.id}`}><span className="badge">{p.key}</span> {p.name}</Link><span className="muted">{p.open - p.overdue}/{p.open} im Plan{p.overdue ? <span style={{ color: 'var(--danger)' }}> · {p.overdue} überfällig</span> : ''}</span></div>
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
            <h2>Meldungen {notes.data && notes.data.unread > 0 && <span className="badge warn">{notes.data.unread} neu</span>}</h2>
            {(notes.data?.notifications ?? []).slice(0, 6).map((n) => <div key={n.id} className={`notif ${n.readAt ? '' : 'unread'}`} style={{ padding: '6px 0' }}><div className="t">{n.link ? <Link to={n.link}>{n.title}</Link> : n.title}</div><div className="b muted small">{fmtDateTime(n.createdAt)}</div></div>)}
            {notes.data && notes.data.notifications.length === 0 && <div className="muted small">Keine Meldungen.</div>}
          </div>
        </div>
        <div className="row mb">
          <h2 style={{ margin: 0 }}>Meine Arbeit</h2>
          <span className="muted small">Projekt › Teilprojekt › Arbeitspaket › Task, nur was dir zugewiesen oder vererbt ist</span>
          <label className="check small right"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> erledigte zeigen</label>
          <Link className="btn sm" to="/projekte/aufgaben">Alle Arbeitspakete</Link>
        </div>
        {work.data && <WorkTree nodes={nodes} reload={work.reload} />}
      </div>
    </>
  );
}
