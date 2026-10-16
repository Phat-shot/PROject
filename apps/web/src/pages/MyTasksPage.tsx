import { Link } from 'react-router-dom';
import type { Task } from '@projekttool/shared';
import { useData } from '../lib/useData';
import { fmtDate, today } from '../lib/api';
import { TopBar } from '../components/Layout';
import { prioLabel } from '../components/ui';

export function MyTasksPage() {
  const { data } = useData<{ tasks: Task[] }>('/my/tasks');
  const t = today();
  const sorted = [...(data?.tasks ?? [])].sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'));
  return (
    <>
      <TopBar title="Meine Aufgaben" />
      <div className="content">
        <div className="card">
          <p className="muted small">Alle offenen Aufgaben über alle Projekte, für die du ausdrücklich oder geerbt zuständig bist.</p>
          {sorted.length === 0 ? <div className="empty">Keine offenen Aufgaben.</div> : (
            <table className="table">
              <thead><tr><th>Aufgabe</th><th>Projekt</th><th>Priorität</th><th>Fällig</th><th>Zuständigkeit</th></tr></thead>
              <tbody>
                {sorted.map((x) => (
                  <tr key={x.id}>
                    <td><Link to={`/projekte/${x.projectId}?task=${x.id}`}>{x.title}</Link>{x.conflicts.length > 0 && <span className="badge warn" style={{ marginLeft: 6 }}>Konflikt</span>}</td>
                    <td><ProjectKey id={x.projectId} /></td>
                    <td><span className={`badge prio-${x.priority}`}>{prioLabel[x.priority]}</span></td>
                    <td className={x.dueDate && x.dueDate < t ? 'nowrap' : 'nowrap'} style={{ color: x.dueDate && x.dueDate < t ? 'var(--danger)' : undefined }}>{fmtDate(x.dueDate)}</td>
                    <td className="muted small">{x.responsible.inherited ? `geerbt (${x.responsible.inheritedFrom === 'subproject' ? 'Teilprojekt' : 'Projekt'})` : 'ausdrücklich'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

function ProjectKey({ id }: { id: string }) {
  const { data } = useData<{ projects: { id: string; key: string }[] }>('/projects');
  const p = data?.projects.find((x) => x.id === id);
  return <span className="badge">{p?.key ?? '…'}</span>;
}
