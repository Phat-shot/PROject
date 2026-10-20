import { useState } from 'react';
import { ORG_RIGHTS, type AdminProject, type Group, type Invitation, type User } from '@projekttool/shared';
import { Link } from 'react-router-dom';
import { api, fmtDateTime } from '../../lib/api';
import { useData } from '../../lib/useData';
import { Modal, useAsync, useDialog } from '../../components/ui';
import { useAuth } from '../../lib/auth';

export const globalLabel: Record<string, string> = { org_admin: 'Org-Admin', project_creator: 'Projektersteller', user: 'Benutzer' };

const ORG_RIGHT_HINT: Record<string, string> = {
  ai_admin: 'Verwaltung › KI: Freigaben und Notaus, Profile, Agenten, Budgets; keine Benutzer, Gruppen oder Audit',
  groups_admin: 'Alle Gruppen anlegen und pflegen (Mitglieder, Verwalter)',
  resources_admin: 'Pool-Ressourcen und Sperrzeiten im Pool'
};

/**
 * Benutzer (Org-Admin): globale Rolle, Org-Rechte, deaktivieren und reaktivieren. Den eigenen Zugang deaktiviert man nicht selbst,
 * der letzte aktive Org-Admin bleibt erhalten (prüft die API).
 */
export function UsersCard({ users, reload }: { users: User[]; reload: () => Promise<void> }) {
  const { user: me } = useAuth();
  const { error, run, busy } = useAsync();
  const dialog = useDialog();
  const [create, setCreate] = useState(false);
  const patch = (u: User, body: Record<string, unknown>) => void run(async () => { await api.patch(`/users/${u.id}`, body); await reload(); });
  return (
    <div className="card">
      <div className="row between mb"><h2 style={{ margin: 0 }}>Benutzer</h2><button className="btn sm" onClick={() => setCreate(true)}>Benutzer manuell anlegen</button></div>
      {create && <CreateUser onClose={() => setCreate(false)} onCreated={async () => { setCreate(false); await reload(); }} />}
      {error && <div className="error mb">{error}</div>}
      <table className="table"><thead><tr><th>Name</th><th>E-Mail</th><th>Globale Rolle</th><th title="Org-Rechte neben der Rolle; der Org-Admin hat alle">Org-Rechte</th><th /></tr></thead><tbody>
        {users.map((u) => <tr key={u.id} className={u.active ? undefined : 'muted'}>
          <td>{u.name}{!u.active && <span className="badge" style={{ marginLeft: 4 }}>deaktiviert</span>}</td><td>{u.email}</td>
          <td>{u.kind === 'agent' ? <span className="badge">KI-Agent</span> : <select aria-label={`Globale Rolle ${u.name}`} value={u.globalRole} disabled={busy || !u.active} onChange={(e) => patch(u, { globalRole: e.target.value })} style={{ width: 'auto' }}>{Object.entries(globalLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}{u.totpEnabled && <span className="badge ok" style={{ marginLeft: 4 }} title="Zweiter Faktor aktiv">2FA</span>}</td>
          <td className="small">{u.kind === 'agent' ? <span className="muted">–</span> : u.globalRole === 'org_admin' ? <span className="muted">alle</span> : ORG_RIGHTS.map((r) => <label key={r.key} className="check" title={ORG_RIGHT_HINT[r.key]}><input type="checkbox" disabled={busy || !u.active} checked={Boolean(u.orgRights?.includes(r.key))} onChange={(e) => { const rest = (u.orgRights ?? []).filter((x) => x !== r.key); patch(u, { orgRights: e.target.checked ? [...rest, r.key] : rest }); }} /> {r.label}</label>)}</td>
          <td className="nowrap">{u.totpEnabled && <button className="btn sm" disabled={busy} style={{ marginRight: 6 }} onClick={() => void dialog.confirm({ title: 'Zweiten Faktor zurücksetzen', text: `${u.name} meldet sich danach wieder nur mit dem Passwort an und kann den zweiten Faktor neu einrichten.`, confirmLabel: 'Zurücksetzen' }).then((ok) => { if (ok) void run(async () => { await api.post(`/users/${u.id}/totp/reset`); await reload(); }); })}>2FA zurücksetzen</button>}
            {u.kind !== 'agent' && !u.active && <button className="btn sm" disabled={busy} onClick={() => patch(u, { active: true })}>Reaktivieren</button>}
            {u.kind !== 'agent' && u.active && u.id !== me?.id && <button className="btn sm danger" disabled={busy} onClick={() => void dialog.confirm({ title: 'Benutzer deaktivieren', text: `${u.name} deaktivieren? Der Login endet, persönliche Mail-Konten werden getrennt, Zuständigkeiten fallen auf die Vererbung zurück, Mitgliedschaften über Gruppen ruhen bis zur Reaktivierung.`, confirmLabel: 'Deaktivieren', danger: true }).then((ok) => { if (ok) void run(async () => { await api.post(`/users/${u.id}/deactivate`); await reload(); }); })}>Deaktivieren</button>}</td>
        </tr>)}
      </tbody></table>
    </div>
  );
}

/**
 * Verantwortliche PL je Projekt (Org-Admin): neu bestimmen, ohne Projektinhalte zu sehen; die bisherige wird Stellvertretung.
 * Sich selbst wählt der Org-Admin nicht (das wäre Inhaltszugriff über die Verwaltung, die API lehnt es ab).
 */
export function ProjectLeadsCard({ users }: { users: User[] }) {
  const { user: me } = useAuth();
  const { data, reload } = useData<{ projects: AdminProject[] }>('/admin/projects');
  const [edit, setEdit] = useState<AdminProject | null>(null);
  const [f, setF] = useState({ userId: '', transferTasks: false });
  const { busy, error, run } = useAsync();
  const people = users.filter((u) => u.active && u.kind !== 'agent' && u.id !== me?.id);
  return (
    <div className="card">
      <h2>Projekte: verantwortliche PL</h2>
      <p className="muted small">Nur Kennung, Name und PL, keine Inhalte. Neu bestimmen z. B., wenn die PL das Unternehmen verlässt; die bisherige PL bleibt Stellvertretung, bis die neue sie entfernt, und bekommt eine Meldung. Sich selbst bestimmt man hier nicht.</p>
      {data && data.projects.length === 0 && <div className="empty">Keine Projekte.</div>}
      {data && data.projects.length > 0 && <table className="table"><thead><tr><th>Projekt</th><th>Verantwortliche PL</th><th /></tr></thead><tbody>
        {data.projects.map((p) => <tr key={p.id}><td><strong>{p.key}</strong> {p.name}{p.status === 'archived' && <span className="badge" style={{ marginLeft: 4 }}>archiviert</span>}</td>
          <td>{p.lead ? <>{p.lead.name}{!p.lead.active && <span className="badge danger" style={{ marginLeft: 4 }}>deaktiviert</span>}</> : <span className="muted">–</span>}</td>
          <td className="nowrap"><button className="btn sm link" onClick={() => { setEdit(p); setF({ userId: people.find((u) => u.id !== p.lead?.userId)?.id ?? '', transferTasks: false }); }}>PL neu bestimmen</button></td></tr>)}
      </tbody></table>}
      {error && <div className="error mt">{error}</div>}
      {edit && (
        <Modal title={`Verantwortliche PL: ${edit.key}`} onClose={() => setEdit(null)}>
          <div className="form">
            <label className="field"><span>Neue verantwortliche PL</span><select value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}>{people.filter((u) => u.id !== edit.lead?.userId).map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}</select></label>
            <label className="check"><input type="checkbox" checked={f.transferTasks} onChange={(e) => setF({ ...f, transferTasks: e.target.checked })} /> direkt zugewiesene Arbeitspakete und Teilprojekte mit übertragen (geerbte wechseln immer)</label>
            <div><button className="btn primary" disabled={busy || !f.userId} onClick={() => void run(async () => { await api.put(`/admin/projects/${edit.id}/lead`, f); setEdit(null); await reload(); })}>Bestimmen</button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

const WEEK = 7 * 86400_000;

export function InvitationsCard({ onAccepted }: { onAccepted: () => void }) {
  const { data, reload } = useData<{ invitations: Invitation[]; hasOrgAccount: boolean }>('/invitations');
  const [f, setF] = useState({ email: '', name: '', globalRole: 'user' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string; link?: string } | null>(null);
  const { busy, error, run } = useAsync();
  void onAccepted; void WEEK;
  const copy = async (link: string) => { try { await navigator.clipboard.writeText(link); setMsg({ ok: true, text: 'Link kopiert.' }); } catch { setMsg({ ok: false, text: link }); } };
  return (
    <div className="card">
      <h2>Benutzer einladen</h2>
      {data && !data.hasOrgAccount && <div className="notice mb small">Kein Org-Postfach angebunden. Einladungen werden dann nicht per Mail verschickt, der Einladungslink lässt sich aber kopieren und weitergeben. Org-Postfach anlegen unter <Link to="/verwaltung/mail">Verwaltung › Mail</Link>.</div>}
      <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="field"><span>Name</span><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="field"><span>E-Mail</span><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        <label className="field"><span>Globale Rolle</span><select value={f.globalRole} onChange={(e) => setF({ ...f, globalRole: e.target.value })}>{Object.entries(globalLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <button className="btn primary" disabled={busy || !f.email || !f.name} onClick={() => void run(async () => {
          const r = await api.post<{ invitation: Invitation; sent: boolean; error?: string }>('/invitations', f);
          setMsg(r.sent ? { ok: true, text: `Einladung an ${r.invitation.email} verschickt.` } : { ok: false, text: r.error ?? 'Nicht verschickt.', link: r.invitation.link });
          setF({ email: '', name: '', globalRole: 'user' });
          await reload();
        })}>Einladen</button>
      </div>
      {error && <div className="error mt">{error}</div>}
      {msg && <div className={`mt small ${msg.ok ? 'muted' : ''}`} style={msg.ok ? undefined : { color: 'var(--warn)' }}>{msg.text}{msg.link && <> · <button className="btn sm link" onClick={() => void copy(msg.link!)}>Link kopieren</button></>}</div>}
      {data && data.invitations.length > 0 && (
        <table className="table mt"><thead><tr><th>Name</th><th>E-Mail</th><th>Rolle</th><th>Status</th><th /></tr></thead><tbody>
          {data.invitations.map((i) => <tr key={i.id}>
            <td>{i.name}</td><td>{i.email}</td><td><span className="badge">{globalLabel[i.globalRole]}</span></td>
            <td className="small">{i.sentAt ? <>verschickt {fmtDateTime(i.sentAt)}</> : <span style={{ color: 'var(--warn)' }}>nicht verschickt{i.sendError ? `: ${i.sendError}` : ''}</span>}<div className="muted">gültig bis {fmtDateTime(i.expiresAt)}</div></td>
            <td className="nowrap"><button className="btn sm link" onClick={() => void copy(i.link)}>Link kopieren</button><button className="btn sm link" disabled={busy} onClick={() => void run(async () => { const r = await api.post<{ sent: boolean; error?: string }>(`/invitations/${i.id}/resend`); setMsg(r.sent ? { ok: true, text: `Erneut an ${i.email} verschickt.` } : { ok: false, text: r.error ?? 'Nicht verschickt.', link: i.link }); await reload(); })}>Erneut senden</button><button className="btn sm link" onClick={() => void run(async () => { await api.del(`/invitations/${i.id}`); await reload(); })}>✕</button></td>
          </tr>)}
        </tbody></table>
      )}
    </div>
  );
}

/**
 * Berechtigungsgruppen: Org-Admin und Gruppenverwaltung (groups_admin) pflegen alle Gruppen samt Verwaltern;
 * Verwalter einer Gruppe sehen hier nur ihre Gruppen und pflegen deren Mitglieder. KI-Agenten sind nie Gruppenmitglied.
 */
export function GroupsCard({ users, canAdmin }: { users: User[]; canAdmin: boolean }) {
  const { user: me } = useAuth();
  const { data, reload } = useData<{ groups: Group[] }>('/groups');
  const [edit, setEdit] = useState<Group | null>(null);
  const [f, setF] = useState({ name: '', description: '', idpName: '', memberIds: [] as string[], managerIds: [] as string[] });
  const { busy, error, run } = useAsync();
  const dialog = useDialog();
  const people = users.filter((u) => u.kind !== 'agent' && u.active);
  const agentIds = new Set(users.filter((u) => u.kind === 'agent').map((u) => u.id));
  const groups = (data?.groups ?? []).filter((g) => canAdmin || g.managerIds.includes(me?.id ?? ''));
  const names = (ids: string[]) => ids.map((id) => users.find((u) => u.id === id)?.name).filter(Boolean).join(', ');
  const open = (g: Group | null) => { setEdit(g ?? { id: '', name: '', description: '', memberIds: [], managerIds: [] }); setF({ name: g?.name ?? '', description: g?.description ?? '', idpName: g?.idpName ?? '', memberIds: (g?.memberIds ?? []).filter((id) => !agentIds.has(id)), managerIds: g?.managerIds ?? [] }); };
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...list.filter((x) => x !== id), id] : list.filter((x) => x !== id));
  return (
    <div className="card">
      <div className="row between"><h2 style={{ margin: 0 }}>Berechtigungsgruppen</h2>{canAdmin && <button className="btn sm" onClick={() => open(null)}>+ Gruppe</button>}</div>
      <p className="muted small">Gruppen bündeln Personen für Sichtbarkeit und Rechte: als Mitglied oder Leser eines Projekts (die PL nimmt sie unter Mitglieder auf), für eingeschränkte Teilprojekte, Mail-Ansichten und KI-Freigaben. Verwalter einer Gruppe pflegen deren Mitglieder.</p>
      {data && groups.length === 0 && <div className="empty">Noch keine Gruppen.</div>}
      {groups.length > 0 && <table className="table"><thead><tr><th>Gruppe</th><th>Mitglieder</th><th>Verwalter</th><th /></tr></thead><tbody>
        {groups.map((g) => <tr key={g.id}><td>{g.name}{g.idpName && <span className="badge" style={{ marginLeft: 6 }} title="Mitglieder kommen bei SSO-Anmeldung aus dieser Gruppe des Identitätsanbieters">SSO: {g.idpName}</span>}{g.description && <div className="muted small">{g.description}</div>}</td><td className="small">{names(g.memberIds) || <span className="muted">–</span>}</td><td className="small">{names(g.managerIds) || <span className="muted">–</span>}</td>
          <td className="nowrap"><button className="btn sm link" onClick={() => open(g)}>Bearbeiten</button>{canAdmin && <button className="btn sm link" onClick={() => void dialog.confirm({ title: 'Gruppe löschen', text: `„${g.name}“ löschen? Freigaben über diese Gruppe (Projekte, Teilprojekte, Mail-Ansichten) enden.`, confirmLabel: 'Löschen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/groups/${g.id}`); await reload(); }); })}>✕</button>}</td></tr>)}
      </tbody></table>}
      {error && <div className="error mt">{error}</div>}
      {edit && (
        <Modal title={edit.id ? `Gruppe: ${edit.name}` : 'Neue Gruppe'} onClose={() => setEdit(null)}>
          <div className="form">
            {canAdmin && <>
              <label className="field"><span>Name</span><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></label>
              <label className="field"><span>Beschreibung</span><input type="text" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
              <label className="field"><span>Gruppe beim Identitätsanbieter (SSO, optional)</span><input type="text" value={f.idpName} placeholder="z. B. PM-Team (Name aus dem Gruppen-Claim)" onChange={(e) => setF({ ...f, idpName: e.target.value })} /><span className="muted small">Bei jeder SSO-Anmeldung wird die Mitgliedschaft nach dieser Gruppe gesetzt oder entfernt.</span></label>
            </>}
            <div className="field"><span>Mitglieder</span>
              <div className="grid cols-2" style={{ gap: 2 }}>{people.map((u) => <label key={u.id} className="check small"><input type="checkbox" disabled={!canAdmin && f.managerIds.includes(u.id)} checked={f.memberIds.includes(u.id)} onChange={(e) => setF({ ...f, memberIds: toggle(f.memberIds, u.id, e.target.checked) })} /> {u.name}</label>)}</div></div>
            {canAdmin && <div className="field"><span>Verwalter (pflegen die Mitglieder dieser Gruppe)</span>
              <div className="grid cols-2" style={{ gap: 2 }}>{people.map((u) => <label key={u.id} className="check small"><input type="checkbox" aria-label={`Verwalter ${u.name}`} checked={f.managerIds.includes(u.id)} onChange={(e) => setF({ ...f, managerIds: toggle(f.managerIds, u.id, e.target.checked), memberIds: e.target.checked ? toggle(f.memberIds, u.id, true) : f.memberIds })} /> {u.name}</label>)}</div></div>}
            {!canAdmin && <p className="muted small">Als Verwalter pflegst du die Mitglieder; Verwalter, Name und SSO-Zuordnung ändert die Gruppenverwaltung.</p>}
            <div><button className="btn primary" disabled={busy || (canAdmin && !f.name.trim())} onClick={() => void run(async () => {
              const body = canAdmin ? f : { memberIds: f.memberIds };
              if (edit.id) await api.patch(`/groups/${edit.id}`, body); else await api.post('/groups', body);
              setEdit(null); await reload();
            })}>Speichern</button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function CreateUser({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
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
