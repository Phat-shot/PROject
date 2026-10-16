import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtDate } from '../../lib/api';
import { Modal, roleLabel, useAsync } from '../../components/ui';
import { useProject, type MemberRow } from '../ProjectPage';

export function MembersView() {
  const { detail, users, reload } = useProject();
  const me = detail.project.myMembership;
  const [edit, setEdit] = useState<MemberRow | null>(null);
  const [invite, setInvite] = useState(false);
  const [columns, setColumns] = useState(false);
  const { error, run } = useAsync();
  const nav = useNavigate();
  const isPl = me.role === 'pl';
  return (
    <div className="content">
      <div className="grid cols-2">
        <div className="card">
          <div className="row between mb"><h2 style={{ margin: 0 }}>Mitglieder</h2>{isPl && <button className="btn primary sm" onClick={() => setInvite(true)}>Einladen</button>}</div>
          {error && <div className="error mb">{error}</div>}
          <table className="table"><thead><tr><th>Name</th><th>Projektrolle</th><th>Einzelrechte</th><th /></tr></thead><tbody>
            {detail.members.map((m) => (
              <tr key={m.userId}>
                <td>{m.name}<div className="muted small">{m.email}</div></td>
                <td><span className={`badge ${m.role}`}>{roleLabel[m.role]}{m.role === 'pl' && (m.isDeputy ? ' (Stellvertretung)' : ' (verantwortlich)')}</span></td>
                <td className="small muted">{m.role === 'pl' ? 'alle' : [m.canEditPlan && 'Projektplan ändern', m.canApprove && 'KI-Vorschläge freigeben', m.canFinalize && 'Final setzen / Versand', m.canUseAi && 'KI nutzen'].filter(Boolean).join(', ') || '–'}</td>
                <td className="nowrap">{isPl && <><button className="btn sm link" onClick={() => setEdit(m)}>Rolle</button>{!(m.role === 'pl' && !m.isDeputy) && <button className="btn sm link" onClick={() => { if (confirm(`${m.name} entfernen? Zugriff endet sofort, Historie bleibt.`)) void run(async () => { await api.del(`/projects/${detail.project.id}/members/${m.userId}`); await reload(); }); }}>Entfernen</button>}</>}</td>
              </tr>
            ))}
          </tbody></table>
          <p className="muted small mt">Rechte vor Funktion: Jede Aktion prüft Projektmitgliedschaft und Einzelrecht. Org-Admins sehen Projektinhalte nur als Mitglied. Keine externen Gäste.</p>
        </div>
        <div className="stack">
          <div className="card">
            <h2>Projekt</h2>
            <dl className="kv">
              <dt>Kürzel</dt><dd>{detail.project.key}</dd>
              <dt>Mailadresse</dt><dd>{detail.project.mailAddress ?? <span className="muted">keine</span>}</dd>
              <dt>Status</dt><dd>{detail.project.status === 'active' ? 'aktiv' : 'archiviert'}</dd>
              <dt>Externe Kontakte</dt><dd><Contacts /></dd>
              <dt>Zeiterfassung</dt><dd>{isPl ? <label className="check"><input type="checkbox" checked={detail.project.timeTrackingEnabled} onChange={(e) => void run(async () => { await api.patch(`/projects/${detail.project.id}`, { timeTrackingEnabled: e.target.checked }); await reload(); })} /> aktiv (optionales Modul)</label> : detail.project.timeTrackingEnabled ? 'aktiv' : 'aus'}</dd>
              {(detail.project.timeTrackingEnabled || detail.project.budgetHours) && <><dt>Budget (Stunden)</dt><dd>{isPl ? <BudgetInput /> : detail.project.budgetHours ?? '–'}</dd></>}
            </dl>
            {isPl && <div className="row mt">
              <button className="btn sm" onClick={() => setColumns(true)}>Board-Spalten</button>
              {detail.project.status === 'active' && <button className="btn sm danger" onClick={() => { if (confirm('Projekt archivieren? Nur lesend, Mail-Ansichten werden getrennt, Automatik stoppt (W11).')) void run(async () => { await api.post(`/projects/${detail.project.id}/archive`); await reload(); nav('/projekte'); }); }}>Archivieren</button>}
            </div>}
          </div>
          <div className="card">
            <h2>Meilensteine</h2>
            <ul>{detail.milestones.map((m) => <li key={m.id}>{fmtDate(m.date)} – {m.name}</li>)}</ul>
          </div>
        </div>
      </div>
      {edit && <RoleForm member={edit} onClose={() => setEdit(null)} />}
      {invite && <RoleForm onClose={() => setInvite(false)} />}
      {columns && <ColumnsForm onClose={() => setColumns(false)} />}
    </div>
  );

  function RoleForm({ member, onClose }: { member?: MemberRow; onClose: () => void }) {
    const candidates = users.filter((u) => !detail.members.some((m) => m.userId === u.id));
    const [f, setF] = useState({ userId: member?.userId ?? candidates[0]?.id ?? '', role: member?.role ?? 'member', isDeputy: member?.isDeputy ?? true, canEditPlan: member?.canEditPlan ?? false, canApprove: member?.canApprove ?? false, canFinalize: member?.canFinalize ?? false, canUseAi: member?.canUseAi ?? true });
    const { busy, error, run } = useAsync();
    return (
      <Modal title={member ? `Rolle: ${member.name}` : 'Mitglied einladen (W2)'} onClose={onClose}>
        <div className="form">
          {!member && <label className="field"><span>Benutzer des Mandanten</span><select value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}>{candidates.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}</select></label>}
          <label className="field"><span>Projektrolle</span><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as any })}><option value="pl">PL</option><option value="member">Mitglied</option><option value="reader">Leser</option></select></label>
          {f.role === 'pl' && <label className="check"><input type="checkbox" checked={f.isDeputy} onChange={(e) => setF({ ...f, isDeputy: e.target.checked })} /> Stellvertretung (zweiter PL). Ohne Haken wird diese Person verantwortlicher PL, der bisherige wird Stellvertretung.</label>}
          {f.role === 'member' && <>
            <strong className="small">Optionale Rechte („opt.“)</strong>
            <label className="check"><input type="checkbox" checked={f.canEditPlan} onChange={(e) => setF({ ...f, canEditPlan: e.target.checked })} /> Projektplan, Meilensteine ändern</label>
            <label className="check"><input type="checkbox" checked={f.canApprove} onChange={(e) => setF({ ...f, canApprove: e.target.checked })} /> KI-Vorschläge freigeben</label>
            <label className="check"><input type="checkbox" checked={f.canFinalize} onChange={(e) => setF({ ...f, canFinalize: e.target.checked })} /> Dokument final setzen, Versand auslösen</label>
            <label className="check"><input type="checkbox" checked={f.canUseAi} onChange={(e) => setF({ ...f, canUseAi: e.target.checked })} /> KI nutzen</label>
          </>}
          {f.role === 'reader' && <label className="check"><input type="checkbox" checked={f.canUseAi} onChange={(e) => setF({ ...f, canUseAi: e.target.checked })} /> KI nutzen (nur Fragen)</label>}
          {error && <div className="error">{error}</div>}
          <div><button className="btn primary" disabled={busy || !f.userId} onClick={() => void run(async () => { await api.put(`/projects/${detail.project.id}/members/${f.userId}`, f); await reload(); onClose(); })}>Speichern</button></div>
        </div>
      </Modal>
    );
  }

  function ColumnsForm({ onClose }: { onClose: () => void }) {
    const { reloadTasks } = useProject();
    const [cols, setCols] = useState(detail.columns.map((c) => ({ id: c.id as string | undefined, name: c.name, isDone: c.isDone, wipLimit: c.wipLimit })));
    const { busy, error, run } = useAsync();
    return (
      <Modal title="Board-Spalten" onClose={onClose}>
        <div className="stack">
          {cols.map((c, i) => <div key={i} className="row"><input type="text" value={c.name} onChange={(e) => setCols(cols.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} style={{ flex: 1 }} /><label className="check small"><input type="checkbox" checked={c.isDone} onChange={(e) => setCols(cols.map((x, j) => (j === i ? { ...x, isDone: e.target.checked } : x)))} /> erledigt</label><label className="small nowrap">WIP <input type="number" min={0} value={c.wipLimit ?? ''} placeholder="–" onChange={(e) => setCols(cols.map((x, j) => (j === i ? { ...x, wipLimit: e.target.value ? Number(e.target.value) : null } : x)))} style={{ width: 56 }} /></label><button className="btn sm link" onClick={() => setCols(cols.filter((_, j) => j !== i))}>✕</button></div>)}
          <button className="btn sm" onClick={() => setCols([...cols, { id: undefined, name: 'Neue Spalte', isDone: false, wipLimit: null }])}>+ Spalte</button>
          <p className="muted small">WIP-Limit: Spalte färbt sich rot, wenn mehr Aufgaben darin liegen (Kanban-Prinzip: erst fertig machen, dann neu anfangen).</p>
          {error && <div className="error">{error}</div>}
          <div><button className="btn primary" disabled={busy} onClick={() => void run(async () => { await api.put(`/projects/${detail.project.id}/columns`, { columns: cols }); await reload(); await reloadTasks(); onClose(); })}>Speichern</button></div>
        </div>
      </Modal>
    );
  }
}

function BudgetInput() {
  const { detail, reload } = useProject();
  const [v, setV] = useState(detail.project.budgetHours?.toString() ?? '');
  return <span className="row"><input type="number" min={0} value={v} onChange={(e) => setV(e.target.value)} style={{ width: 100 }} /><button className="btn sm" onClick={() => void api.patch(`/projects/${detail.project.id}`, { budgetHours: v ? Number(v) : null }).then(reload)}>Speichern</button></span>;
}

function Contacts() {
  const { detail } = useProject();
  const [list, setList] = useState<{ email: string; name: string | null }[] | null>(null);
  if (!list) { void api.get<{ contacts: any[] }>(`/projects/${detail.project.id}/contacts`).then((r) => setList(r.contacts)); return <span className="muted">…</span>; }
  return <span className="small">{list.length ? list.map((c) => c.name ? `${c.name} <${c.email}>` : c.email).join(', ') : '–'}</span>;
}
