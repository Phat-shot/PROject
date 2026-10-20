import { useState } from 'react';
import type { AuditEntry } from '@projekttool/shared';
import { api, downloadCsv, fmtDateTime } from '../../lib/api';
import { useAsync } from '../../components/ui';

/** Audit-Export des Mandanten: Metadaten anzeigen (wird protokolliert) oder als CSV laden. */
export function AuditCard() {
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const { error, run, busy } = useAsync();
  return (
    <div className="card" id="audit">
      <div className="row between"><h2 style={{ margin: 0 }}>Audit-Export</h2><span className="row">
        <button className="btn" disabled={busy} onClick={() => void run(async () => setAudit((await api.get<{ entries: AuditEntry[] }>('/audit')).entries))}>Anzeigen (nur Metadaten, wird protokolliert)</button>
        <button className="btn primary" disabled={busy} onClick={() => void run(async () => { const e = (await api.get<{ entries: AuditEntry[] }>('/audit')).entries; downloadCsv(`audit-${new Date().toISOString().slice(0, 10)}.csv`, ['Zeit', 'Wer', 'Aktion', 'Objekttyp', 'Objekt', 'Projekt', 'Details'], e.map((x) => [x.createdAt, x.userName ?? 'Worker', x.action, x.objectType, x.objectId, x.projectId, JSON.stringify(x.details)])); })}>CSV herunterladen</button>
      </span></div>
      {error && <div className="error mt">{error}</div>}
      {audit && <p className="muted small mt">{audit.length} Einträge, die ersten 300 angezeigt.</p>}
      {audit && <table className="table mt"><thead><tr><th>Zeit</th><th>Wer</th><th>Aktion</th><th>Objekt</th></tr></thead><tbody>
        {audit.slice(0, 300).map((e) => <tr key={e.id}><td className="nowrap small">{fmtDateTime(e.createdAt)}</td><td>{e.userName ?? 'Worker'}</td><td><code>{e.action}</code></td><td className="small muted">{e.objectType} {e.objectId?.slice(0, 8)}</td></tr>)}
      </tbody></table>}
    </div>
  );
}
