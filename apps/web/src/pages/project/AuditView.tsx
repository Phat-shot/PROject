import type { AuditEntry } from '@projekttool/shared';
import { downloadCsv, fmtDateTime } from '../../lib/api';
import { useData } from '../../lib/useData';
import { useProject } from '../ProjectPage';

/** Audit-Log des Projekts; embedded = ohne eigenen Seitenrahmen (Einstellungen › Daten). */
export function AuditView({ embedded = false }: { embedded?: boolean }) {
  const { detail } = useProject();
  const { data, error } = useData<{ entries: AuditEntry[] }>(`/audit?projectId=${detail.project.id}`);
  const me = detail.project.myMembership;
  return (
    <div className={embedded ? undefined : 'content'}>
      <div className="card">
        <div className="row between"><h2 style={{ margin: 0 }}>Audit-Log</h2>{data && <button className="btn sm" onClick={() => downloadCsv(`audit-${detail.project.key}-${new Date().toISOString().slice(0, 10)}.csv`, ['Zeit', 'Wer', 'Aktion', 'Objekttyp', 'Objekt', 'Details'], data.entries.map((x) => [x.createdAt, x.userName ?? 'Worker', x.action, x.objectType, x.objectId, JSON.stringify(x.details)]))}>CSV herunterladen</button>}</div>
        <p className="muted small">{me.role === 'pl' ? 'Alle Aktionen im Projekt.' : 'Nur eigene Aktionen (Mitglieder sehen ihr eigenes Protokoll).'} Geschrieben ausschließlich von API und Worker.</p>
        {error && <div className="error">{error}</div>}
        <table className="table"><thead><tr><th>Zeit</th><th>Wer</th><th>Aktion</th><th>Objekt</th><th>Details</th></tr></thead><tbody>
          {data?.entries.map((e) => <tr key={e.id}><td className="nowrap small">{fmtDateTime(e.createdAt)}</td><td>{e.userName ?? <span className="muted">Worker</span>}</td><td><code>{e.action}</code></td><td className="small muted">{e.objectType}</td><td className="small muted" style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={JSON.stringify(e.details)}>{JSON.stringify(e.details)}</td></tr>)}
        </tbody></table>
      </div>
    </div>
  );
}
