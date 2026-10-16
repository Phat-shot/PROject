import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Task, TimeEntry } from '@projekttool/shared';
import { useData } from '../lib/useData';
import { fmtDate, today } from '../lib/api';
import { TopBar } from '../components/Layout';
import { prioLabel } from '../components/ui';
import { useAuth } from '../lib/auth';

type Row = Task & { projectKey: string };

/** Gesamtsicht der Aufgaben über alle aktiven Projekte (Projekte gewählt, kein konkretes Projekt). */
export function AllTasksPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const scope = params.get('scope') === 'mine' ? 'mine' : 'all';
  const withDone = params.get('done') === '1';
  const project = params.get('projekt') ?? '';
  const q = params.get('q') ?? '';
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  const { data, error } = useData<{ tasks: Row[] }>(`/my/tasks?scope=${scope}${withDone ? '&done=1' : ''}`, [scope, withDone]);
  const t = today();
  const projects = useMemo(() => Array.from(new Set((data?.tasks ?? []).map((x) => x.projectKey))).sort(), [data]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return [...(data?.tasks ?? [])]
      .filter((x) => (!project || x.projectKey === project) && (!needle || x.title.toLowerCase().includes(needle)))
      .sort((a, b) => Number(a.done) - Number(b.done) || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'));
  }, [data, project, q]);
  const overdue = rows.filter((x) => !x.done && x.dueDate && x.dueDate < t).length;
  return (
    <>
      <TopBar title="Alle Aufgaben" />
      <div className="content">
        <div className="filterbar">
          <span className={`chip ${scope === 'all' ? 'on' : ''}`} onClick={() => set('scope', '')}>Alle</span>
          <span className={`chip ${scope === 'mine' ? 'on' : ''}`} onClick={() => set('scope', 'mine')}>Meine</span>
          <select value={project} onChange={(e) => set('projekt', e.target.value)}><option value="">Alle Projekte</option>{projects.map((k) => <option key={k} value={k}>{k}</option>)}</select>
          <input type="text" placeholder="Titel filtern …" value={q} onChange={(e) => set('q', e.target.value)} />
          <label className="check small"><input type="checkbox" checked={withDone} onChange={(e) => set('done', e.target.checked ? '1' : '')} /> erledigte zeigen</label>
          <span className="muted small right">{rows.length} Aufgaben{overdue > 0 && <> · <span style={{ color: 'var(--danger)' }}>{overdue} überfällig</span></>}</span>
        </div>
        {error && <div className="error mb">{error}</div>}
        <div className="card">
          {scope === 'mine' && <p className="muted small">Offene Aufgaben, für die du ausdrücklich oder geerbt zuständig bist.</p>}
          {data && rows.length === 0 ? <div className="empty">Keine Aufgaben.</div> : (
            <table className="table">
              <thead><tr><th>Projekt</th><th>Aufgabe</th><th>Priorität</th><th>Fällig</th><th>Zuständig</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={x.id} style={{ opacity: x.done ? 0.6 : 1 }}>
                    <td><Link to={`/projekte/${x.projectId}`}><span className="badge">{x.projectKey}</span></Link></td>
                    <td>
                      <Link to={`/projekte/${x.projectId}/board?task=${x.id}`}>{x.title}</Link>
                      {x.blocked && <span className="badge warn" style={{ marginLeft: 6 }}>blockiert</span>}
                      {x.escalationLevel > 0 && <span className="badge danger" style={{ marginLeft: 6 }}>Eskalation {x.escalationLevel}</span>}
                      {x.conflicts.length > 0 && <span className="badge warn" style={{ marginLeft: 6 }}>Konflikt</span>}
                    </td>
                    <td><span className={`badge prio-${x.priority}`}>{prioLabel[x.priority]}</span></td>
                    <td className="nowrap" style={{ color: !x.done && x.dueDate && x.dueDate < t ? 'var(--danger)' : undefined }}>{fmtDate(x.dueDate)}</td>
                    <td className="small">{x.responsible.name ?? x.responsible.email ?? <span className="muted">–</span>}{x.responsible.userId === user?.id && <span className="muted"> (ich)</span>}{x.responsible.inherited && <span className="muted"> · geerbt</span>}</td>
                    <td className="small muted">{x.done ? 'erledigt' : 'offen'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {scope === 'mine' && <MyWeek />}
      </div>
    </>
  );
}

function MyWeek() {
  const { data } = useData<{ from: string; to: string; entries: (TimeEntry & { projectKey: string })[]; totalMinutes: number }>('/my/time');
  if (!data || data.entries.length === 0) return null;
  const h = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} h`;
  return (
    <div className="card mt">
      <h2>Meine Zeiten (letzte 7 Tage) <span className="badge">{h(data.totalMinutes)}</span></h2>
      <table className="table"><tbody>{data.entries.map((e) => <tr key={e.id}><td className="nowrap">{fmtDate(e.date)}</td><td><span className="badge">{e.projectKey}</span></td><td>{e.taskTitle ?? <span className="muted">ohne Aufgabe</span>}</td><td className="nowrap">{h(e.minutes)}</td><td className="muted small">{e.note}</td></tr>)}</tbody></table>
    </div>
  );
}
