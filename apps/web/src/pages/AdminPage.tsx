import { useState } from 'react';
import type { AuditEntry, User } from '@projekttool/shared';
import { api, fmtDateTime } from '../lib/api';
import { useData } from '../lib/useData';
import { TopBar } from '../components/Layout';
import { Modal, useAsync } from '../components/ui';

const globalLabel: Record<string, string> = { org_admin: 'Org-Admin', project_creator: 'Projektersteller', user: 'Benutzer' };

export function AdminPage() {
  const users = useData<{ users: User[] }>('/users');
  const [create, setCreate] = useState(false);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const { error, run, busy } = useAsync();
  return (
    <>
      <TopBar title="Verwaltung (Org-Admin)"><button className="btn primary" onClick={() => setCreate(true)}>Benutzer anlegen</button></TopBar>
      <div className="content">
        <div className="card">
          <h2>Benutzer des Mandanten</h2>
          {error && <div className="error mb">{error}</div>}
          <table className="table"><thead><tr><th>Name</th><th>E-Mail</th><th>Globale Rolle</th><th /></tr></thead><tbody>
            {users.data?.users.map((u) => <tr key={u.id}><td>{u.name}</td><td>{u.email}</td><td><span className="badge">{globalLabel[u.globalRole]}</span></td>
              <td><button className="btn sm danger" disabled={busy} onClick={() => { if (confirm(`${u.name} deaktivieren? Login endet, persönliche Konten werden getrennt, Zuständigkeiten fallen zurück (W10).`)) void run(async () => { await api.post(`/users/${u.id}/deactivate`); await users.reload(); }); }}>Deaktivieren</button></td></tr>)}
          </tbody></table>
        </div>
        <div className="card">
          <div className="row between"><h2 style={{ margin: 0 }}>Audit-Export</h2><button className="btn" disabled={busy} onClick={() => void run(async () => setAudit((await api.get<{ entries: AuditEntry[] }>('/audit')).entries))}>Export laden (nur Metadaten, wird protokolliert)</button></div>
          {audit && <table className="table mt"><thead><tr><th>Zeit</th><th>Wer</th><th>Aktion</th><th>Objekt</th></tr></thead><tbody>
            {audit.slice(0, 300).map((e) => <tr key={e.id}><td className="nowrap small">{fmtDateTime(e.createdAt)}</td><td>{e.userName ?? 'Worker'}</td><td><code>{e.action}</code></td><td className="small muted">{e.objectType} {e.objectId?.slice(0, 8)}</td></tr>)}
          </tbody></table>}
        </div>
      </div>
      {create && <CreateUser onClose={() => setCreate(false)} onCreated={async () => { setCreate(false); await users.reload(); }} />}
    </>
  );
}

function CreateUser({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const [f, setF] = useState({ email: '', name: '', password: '', globalRole: 'user' });
  const { busy, error, run } = useAsync();
  return (
    <Modal title="Benutzer anlegen" onClose={onClose}>
      <div className="form">
        <label className="field"><span>Name</span><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="field"><span>E-Mail</span><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        <label className="field"><span>Passwort</span><input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
        <label className="field"><span>Globale Rolle</span><select value={f.globalRole} onChange={(e) => setF({ ...f, globalRole: e.target.value })}>{Object.entries(globalLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        {error && <div className="error">{error}</div>}
        <div><button className="btn primary" disabled={busy} onClick={() => void run(async () => { await api.post('/users', f); await onCreated(); })}>Anlegen</button></div>
      </div>
    </Modal>
  );
}
