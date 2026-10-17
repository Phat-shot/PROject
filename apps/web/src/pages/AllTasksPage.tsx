import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Task } from '@projekttool/shared';
import { useData } from '../lib/useData';
import { fmtDate, today } from '../lib/api';
import { TopBar } from '../components/Layout';
import { prioLabel } from '../components/ui';
import { useAuth } from '../lib/auth';

type Row = Task & { projectKey: string };

/** Gesamtsicht der Arbeitspakete über alle aktiven Projekte (Projekte gewählt, kein konkretes Projekt). */
export function AllTasksPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const scope = 'all' as const;
  const withDone = params.get('done') === '1';
  const project = params.get('projekt') ?? '';
  const q = params.get('q') ?? '';
  const mine = params.get('mine') === '1';
  const filter = params.get('filter') ?? '';
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  const { data, error } = useData<{ tasks: Row[] }>(`/my/tasks?scope=${scope}${withDone ? '&done=1' : ''}`, [withDone]);
  const t = today();
  const week = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
  const projects = useMemo(() => Array.from(new Set((data?.tasks ?? []).map((x) => x.projectKey))).sort(), [data]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return [...(data?.tasks ?? [])]
      .filter((x) => (!project || x.projectKey === project) && (!needle || x.title.toLowerCase().includes(needle)))
      .filter((x) => !mine || x.responsible.userId === user?.id)
      .filter((x) => filter === 'overdue' ? !x.done && Boolean(x.dueDate) && x.dueDate! < t
        : filter === 'week' ? !x.done && Boolean(x.dueDate) && x.dueDate! >= t && x.dueDate! <= week
        : filter === 'trouble' ? !x.done && (x.blocked || x.escalationLevel > 0 || x.conflicts.length > 0)
        : filter === 'nodue' ? !x.done && !x.dueDate : true)
      .sort((a, b) => Number(a.done) - Number(b.done) || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'));
  }, [data, project, q, mine, filter, user?.id, t, week]);
  const FILTERS: [string, string][] = [['', 'Alle'], ['overdue', 'Überfällig'], ['week', 'Fällig in 7 Tagen'], ['trouble', 'Blockiert / eskaliert / Konflikt'], ['nodue', 'Ohne Termin']];
  const overdue = rows.filter((x) => !x.done && x.dueDate && x.dueDate < t).length;
  return (
    <>
      <TopBar title="Alle Arbeitspakete" />
      <div className="content">
        <div className="filterbar">
          <Link className="chip" to="/dashboard">← Dashboard</Link>
          {<><select value={project} onChange={(e) => set('projekt', e.target.value)}><option value="">Alle Projekte</option>{projects.map((k) => <option key={k} value={k}>{k}</option>)}</select>
          <input type="text" placeholder="Titel filtern …" value={q} onChange={(e) => set('q', e.target.value)} />
          <button className={`chip ${mine ? 'on' : ''}`} onClick={() => set('mine', mine ? '' : '1')}>Nur meine</button>
          {FILTERS.map(([k, l]) => <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => set('filter', k)}>{l}</button>)}
          <label className="check small"><input type="checkbox" checked={withDone} onChange={(e) => set('done', e.target.checked ? '1' : '')} /> erledigte zeigen</label>
          <span className="muted small right">{rows.length} Arbeitspakete{overdue > 0 && <> · <span style={{ color: 'var(--danger)' }}>{overdue} überfällig</span></>}</span></>}
        </div>
        {error && <div className="error mb">{error}</div>}
        {<div className="card">
          {data && rows.length === 0 ? <div className="empty">Keine Arbeitspakete.</div> : (
            <table className="table">
              <thead><tr><th>Kennung</th><th>Arbeitspaket</th><th>Priorität</th><th>Fällig</th><th>Zuständig</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={x.id} style={{ opacity: x.done ? 0.6 : 1 }}>
                    <td className="nowrap"><Link to={`/projekte/${x.projectId}/board?task=${x.id}`} className="tkey">{x.projectKey}-{x.number}</Link></td>
                    <td>
                      <Link to={`/projekte/${x.projectId}/board?task=${x.id}`}>{x.title}</Link>
                      {x.blocked && <span className="badge warn" style={{ marginLeft: 6 }}>blockiert</span>}
                      {x.escalationLevel > 0 && <span className="badge danger" style={{ marginLeft: 6 }}>Eskalation {x.escalationLevel}</span>}
                      {x.conflicts.length > 0 && <span className="badge warn" style={{ marginLeft: 6 }}>Konflikt</span>}
                    </td>
                    <td><span className={`badge prio-${x.priority}`}>{prioLabel[x.priority]}</span></td>
                    <td className="nowrap" style={{ color: !x.done && x.dueDate && x.dueDate < t ? 'var(--danger)' : undefined }}>{fmtDate(x.dueDate)}</td>
                    <td className="small">{x.responsible.name ?? x.responsible.email ?? <span className="muted">–</span>}{x.responsible.inherited && <span className="muted"> (geerbt{x.responsible.inheritedFrom === 'subproject' ? ' vom Teilprojekt' : ' vom PL'})</span>}{x.responsible.userId === user?.id && <span className="badge" style={{ marginLeft: 6 }}>ich</span>}</td>
                    <td className="small muted">{x.done ? 'erledigt' : 'offen'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>}
      </div>
    </>
  );
}
