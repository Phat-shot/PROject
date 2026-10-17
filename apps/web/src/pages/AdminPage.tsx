import { useState } from 'react';
import type { AuditEntry, DocTemplate, Group, Invitation, OrgSettings, User } from '@projekttool/shared';
import { Link } from 'react-router-dom';
import { RichEditor } from '../components/RichEditor';
import { api, fmtDateTime } from '../lib/api';
import { useData } from '../lib/useData';
import { TopBar } from '../components/Layout';
import { Modal, useAsync, useDialog } from '../components/ui';

const globalLabel: Record<string, string> = { org_admin: 'Org-Admin', project_creator: 'Projektersteller', user: 'Benutzer' };

export function AdminPage() {
  const users = useData<{ users: User[] }>('/users');
  const [create, setCreate] = useState(false);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const { error, run, busy } = useAsync();
  const dialog = useDialog();
  return (
    <>
      <TopBar title="Verwaltung"><button className="btn" onClick={() => setCreate(true)}>Benutzer manuell anlegen</button></TopBar>
      <div className="content">
        <InvitationsCard onAccepted={() => void users.reload()} />
        <div className="card">
          <h2>Benutzer</h2>
          {error && <div className="error mb">{error}</div>}
          <table className="table"><thead><tr><th>Name</th><th>E-Mail</th><th>Globale Rolle</th><th /></tr></thead><tbody>
            {users.data?.users.map((u) => <tr key={u.id}><td>{u.name}</td><td>{u.email}</td><td><span className="badge">{globalLabel[u.globalRole]}</span></td>
              <td><button className="btn sm danger" disabled={busy} onClick={() => void dialog.confirm({ title: 'Benutzer deaktivieren', text: `${u.name} deaktivieren? Der Login endet, persönliche Mail-Konten werden getrennt, Zuständigkeiten fallen auf die Vererbung zurück.`, confirmLabel: 'Deaktivieren', danger: true }).then((ok) => { if (ok) void run(async () => { await api.post(`/users/${u.id}/deactivate`); await users.reload(); }); })}>Deaktivieren</button></td></tr>)}
          </tbody></table>
        </div>
        <GroupsCard users={users.data?.users ?? []} />
        <PdfStyleCard />
        <TemplatesCard />
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

const WEEK = 7 * 86400_000;

function InvitationsCard({ onAccepted }: { onAccepted: () => void }) {
  const { data, reload } = useData<{ invitations: Invitation[]; hasOrgAccount: boolean }>('/invitations');
  const [f, setF] = useState({ email: '', name: '', globalRole: 'user' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string; link?: string } | null>(null);
  const { busy, error, run } = useAsync();
  void onAccepted; void WEEK;
  const copy = async (link: string) => { try { await navigator.clipboard.writeText(link); setMsg({ ok: true, text: 'Link kopiert.' }); } catch { setMsg({ ok: false, text: link }); } };
  return (
    <div className="card">
      <h2>Benutzer einladen</h2>
      {data && !data.hasOrgAccount && <div className="notice mb small">Kein Org-Postfach angebunden. Einladungen werden dann nicht per Mail verschickt, der Einladungslink lässt sich aber kopieren und weitergeben. Org-Postfach anlegen unter <Link to="/einstellungen/mail-konten">Meine Mail-Konten</Link> (Typ „Org-Postfach“).</div>}
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

function GroupsCard({ users }: { users: User[] }) {
  const { data, reload } = useData<{ groups: Group[] }>('/groups');
  const [edit, setEdit] = useState<Group | null>(null);
  const [f, setF] = useState({ name: '', description: '', memberIds: [] as string[] });
  const { busy, error, run } = useAsync();
  const dialog = useDialog();
  const open = (g: Group | null) => { setEdit(g ?? { id: '', name: '', description: '', memberIds: [] }); setF({ name: g?.name ?? '', description: g?.description ?? '', memberIds: g?.memberIds ?? [] }); };
  return (
    <div className="card">
      <div className="row between"><h2 style={{ margin: 0 }}>Berechtigungsgruppen</h2><button className="btn sm" onClick={() => open(null)}>+ Gruppe</button></div>
      <p className="muted small">Gruppen bündeln Benutzer für Sichtbarkeit und Rechte: eingeschränkte Teilprojekte und Mail-Ansichten lassen sich an Gruppen freigeben.</p>
      {data && data.groups.length === 0 && <div className="empty">Noch keine Gruppen.</div>}
      {data && data.groups.length > 0 && <table className="table"><thead><tr><th>Gruppe</th><th>Mitglieder</th><th /></tr></thead><tbody>
        {data.groups.map((g) => <tr key={g.id}><td>{g.name}{g.description && <div className="muted small">{g.description}</div>}</td><td className="small">{g.memberIds.map((id) => users.find((u) => u.id === id)?.name).filter(Boolean).join(', ') || <span className="muted">–</span>}</td>
          <td className="nowrap"><button className="btn sm link" onClick={() => open(g)}>Bearbeiten</button><button className="btn sm link" onClick={() => void dialog.confirm({ title: 'Gruppe löschen', text: `„${g.name}“ löschen? Freigaben über diese Gruppe (Teilprojekte, Mail-Ansichten) enden.`, confirmLabel: 'Löschen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/groups/${g.id}`); await reload(); }); })}>✕</button></td></tr>)}
      </tbody></table>}
      {error && <div className="error mt">{error}</div>}
      {edit && (
        <Modal title={edit.id ? `Gruppe: ${edit.name}` : 'Neue Gruppe'} onClose={() => setEdit(null)}>
          <div className="form">
            <label className="field"><span>Name</span><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></label>
            <label className="field"><span>Beschreibung</span><input type="text" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
            <div className="field"><span>Mitglieder</span>
              <div className="grid cols-2" style={{ gap: 2 }}>{users.map((u) => <label key={u.id} className="check small"><input type="checkbox" checked={f.memberIds.includes(u.id)} onChange={(e) => setF({ ...f, memberIds: e.target.checked ? [...f.memberIds, u.id] : f.memberIds.filter((x) => x !== u.id) })} /> {u.name}</label>)}</div></div>
            <div><button className="btn primary" disabled={busy || !f.name.trim()} onClick={() => void run(async () => { if (edit.id) await api.patch(`/groups/${edit.id}`, f); else await api.post('/groups', f); setEdit(null); await reload(); })}>Speichern</button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function PdfStyleCard() {
  const { data, reload } = useData<{ name: string; settings: OrgSettings }>('/org/settings');
  const [f, setF] = useState<OrgSettings | null>(null);
  const { busy, error, run } = useAsync();
  const v = f ?? data?.settings ?? {};
  if (!data) return null;
  return (
    <div className="card">
      <h2>Mandant: PDF-Stil und Module</h2>
      <p className="muted small">Gilt für alle PDFs des Mandanten: Kopfzeile, Akzentfarbe für Überschriften und Tabellenköpfe, Fußzeile. Inhalt und Gliederung kommen aus der Seite bzw. Vorlage.</p>
      <div className="form cols-2">
        <label className="field"><span>Firmenname in der Kopfzeile</span><input type="text" value={v.company ?? ''} placeholder={data.name} onChange={(e) => setF({ ...v, company: e.target.value })} /></label>
        <label className="field"><span>Akzentfarbe</span><span className="row"><input type="color" value={v.accentColor ?? '#1f5eff'} onChange={(e) => setF({ ...v, accentColor: e.target.value })} style={{ width: 48, padding: 0, height: 32 }} /><input type="text" value={v.accentColor ?? '#1f5eff'} onChange={(e) => setF({ ...v, accentColor: e.target.value })} style={{ width: 110 }} /></span></label>
        <label className="field full"><span>Fußzeile</span><input type="text" value={v.footerText ?? ''} placeholder="z. B. Vertraulich · nur für Projektbeteiligte" onChange={(e) => setF({ ...v, footerText: e.target.value })} /></label>
        <label className="check full"><input type="checkbox" checked={v.timeTracking !== false} onChange={(e) => setF({ ...v, timeTracking: e.target.checked })} /> Zeiterfassung mandantenweit aktiv (aus = Zeiten, Aufwand und Buchungen werden in allen Projekten ausgeblendet; Daten bleiben erhalten)</label>
        {error && <div className="error full">{error}</div>}
        <div className="full"><button className="btn primary sm" disabled={busy || !f} onClick={() => void run(async () => { await api.put('/org/settings', f); setF(null); await reload(); window.location.reload(); })}>Speichern</button></div>
      </div>
    </div>
  );
}

function TemplatesCard() {
  const { data, reload } = useData<{ templates: DocTemplate[] }>('/docs/templates');
  const [edit, setEdit] = useState<DocTemplate | null>(null);
  const [name, setName] = useState('');
  const [html, setHtml] = useState('');
  const [newKey, setNewKey] = useState('');
  const { busy, error, run } = useAsync();
  const open = (t: DocTemplate) => { setEdit(t); setName(t.name); setHtml(t.contentHtml || ''); };
  return (
    <div className="card">
      <h2>Vorlagen (Protokoll, Statusbericht, RAID-Log …)</h2>
      <p className="muted small">Vorlagen werden im selben Editor wie Seiten gepflegt; Platzhalter <code>{'{{datum}}'}</code> wird beim Anlegen ersetzt. Eingebaute Vorlagen lassen sich für den Mandanten überschreiben. Oberseiten legen fest, welche Vorlage ihre Unterseiten bekommen.</p>
      <div className="row mb">
        {data?.templates.map((t) => <button key={t.id} className={`chip ${edit?.key === t.key ? 'on' : ''}`} onClick={() => open(t)}>{t.name}</button>)}
        <span className="row small"><input type="text" placeholder="neuer Schlüssel, z. B. abnahme" value={newKey} onChange={(e) => setNewKey(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))} style={{ width: 200 }} /><button className="btn sm" disabled={!newKey} onClick={() => { setEdit({ id: '', key: newKey, name: '', contentMd: '', contentHtml: '<h1>Titel</h1><p></p>' }); setName(''); setHtml('<h1>Titel</h1><p></p>'); }}>+ Vorlage</button></span>
      </div>
      {edit && (
        <div className="form">
          <label className="field"><span>Name (Schlüssel: {edit.key})</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <RichEditor key={edit.key} html={html} onChange={setHtml} />
          {error && <div className="error">{error}</div>}
          <div className="row"><button className="btn primary sm" disabled={busy || !name} onClick={() => void run(async () => { await api.put(`/docs/templates/${edit.key}`, { name, contentHtml: html }); await reload(); })}>Speichern</button><button className="btn sm" onClick={() => setEdit(null)}>Schließen</button></div>
        </div>
      )}
    </div>
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
