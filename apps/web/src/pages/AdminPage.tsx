import { useEffect, useState } from 'react';
import type { AdminProject, AgentUser, AiDecision, AiPolicyRule, AiProfile, AuditEntry, DocTemplate, Group, Invitation, OrgSettings, ProjectTemplate, User, MailInquiry } from '@projekttool/shared';
import { AI_CATEGORIES, AI_FEATURES, ORG_RIGHTS } from '@projekttool/shared';
import { Link } from 'react-router-dom';
import { RichEditor } from '../components/RichEditor';
import { api, downloadCsv, fmtDateTime } from '../lib/api';
import { useData } from '../lib/useData';
import { TopBar } from '../components/Layout';
import { Modal, useAsync, useDialog } from '../components/ui';
import { invalidateAi, useAiStatus } from '../lib/useAi';
import { useAuth } from '../lib/auth';
import { OrgNotifyCard } from '../components/NotifyRules';
import { AgentPolicyEditor } from '../components/AgentPolicy';

const globalLabel: Record<string, string> = { org_admin: 'Org-Admin', project_creator: 'Projektersteller', user: 'Benutzer' };

/**
 * Verwaltung: der Org-Admin sieht alle Karten; die KI-Verwaltung (Org-Recht ai_admin) nur die KI-Karten
 * (Freigaben und Notaus, Profile, eigene LLMs der Projekte, Agenten), die Gruppenverwaltung (groups_admin)
 * und Verwalter einer Gruppe nur die Gruppen.
 */
export function AdminPage() {
  const { user } = useAuth();
  const isAdmin = user?.globalRole === 'org_admin';
  const aiAdmin = isAdmin || Boolean(user?.orgRights?.includes('ai_admin'));
  const groupsAdmin = isAdmin || Boolean(user?.orgRights?.includes('groups_admin'));
  const users = useData<{ users: User[] }>(isAdmin ? '/users?all=1' : '/users');
  const [create, setCreate] = useState(false);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const { error, run, busy } = useAsync();
  if (!isAdmin) return (
    <>
      <TopBar title={aiAdmin && !groupsAdmin && !user?.managesGroups ? 'Verwaltung › KI' : 'Verwaltung'} />
      <div className="content">
        {(groupsAdmin || user?.managesGroups) && <GroupsCard users={users.data?.users ?? []} canAdmin={groupsAdmin} />}
        {aiAdmin && <><AiPolicyCard /><AiCard /><ProjectLlmsCard /><AgentsCard /></>}
      </div>
    </>
  );
  return (
    <>
      <TopBar title="Verwaltung"><button className="btn" onClick={() => setCreate(true)}>Benutzer manuell anlegen</button></TopBar>
      <div className="content">
        <InvitationsCard onAccepted={() => void users.reload()} />
        <UsersCard users={users.data?.users ?? []} reload={users.reload} />
        <GroupsCard users={users.data?.users ?? []} canAdmin />
        <ProjectLeadsCard users={users.data?.users ?? []} />
        <PdfStyleCard />
        <OrgNotifyCard />
        <AiPolicyCard />
        <AiCard />
        <ProjectLlmsCard />
        <AgentsCard />
        <ProjectTemplatesCard />
        <TemplatesCard />
        <div className="card">
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
      </div>
      {create && <CreateUser onClose={() => setCreate(false)} onCreated={async () => { setCreate(false); await users.reload(); }} />}
    </>
  );
}

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
  const patch = (u: User, body: Record<string, unknown>) => void run(async () => { await api.patch(`/users/${u.id}`, body); await reload(); });
  return (
    <div className="card">
      <h2>Benutzer</h2>
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
        <label className="check full"><input type="checkbox" checked={Boolean(v.personalProjects)} onChange={(e) => setF({ ...v, personalProjects: e.target.checked })} /> Alle Benutzer dürfen ein persönliches Projekt (Assistent) anlegen: nur die Person und KI-Agenten, Org-Admin ohne Inhalte und ohne Kontenverwaltung. Projektersteller dürfen es immer.</label>
        <label className="field"><span>Mail-Rückfrage (Vorgabe für Projekte): offene Punkte aus neuen Mails</span><select value={v.mailInquiry?.mode ?? 'ask_pl'} onChange={(e) => setF({ ...v, mailInquiry: { mode: e.target.value as MailInquiry['mode'], waitHours: v.mailInquiry?.waitHours ?? 48 } })}><option value="ask_pl">PL fragen (klar / im Projekt fragen / beim Absender rückfragen)</option><option value="ask_project">im Projekt fragen</option><option value="ask_sender">beim Absender rückfragen</option><option value="off">aus (nur Log)</option></select></label>
        <label className="field"><span>Frist der Rückfrage (Stunden, danach Weitergabe über die Kette)</span><input type="number" min={1} max={720} value={v.mailInquiry?.waitHours ?? 48} onChange={(e) => setF({ ...v, mailInquiry: { mode: v.mailInquiry?.mode ?? 'ask_pl', waitHours: Number(e.target.value) } })} /></label>
        {error && <div className="error full">{error}</div>}
        <div className="full"><button className="btn primary sm" disabled={busy || !f} onClick={() => void run(async () => { await api.put('/org/settings', f); setF(null); await reload(); window.location.reload(); })}>Speichern</button></div>
      </div>
    </div>
  );
}

function ProjectTemplatesCard() {
  const { data, reload } = useData<{ templates: ProjectTemplate[] }>('/project-templates');
  const dialog = useDialog();
  const { busy, error, run } = useAsync();
  return (
    <div className="card">
      <h2>Projektvorlagen</h2>
      <p className="muted small">Vorlagen entstehen aus bestehenden Projekten („Als Vorlage speichern“ in den Projekteinstellungen) und belegen neue Projekte mit Spalten, Labels, Teilprojekten, Meilensteinen, Doku-Ordnern und Regeln vor.</p>
      {error && <div className="error mb">{error}</div>}
      {data && data.templates.length === 0 && <div className="empty">Noch keine Vorlagen.</div>}
      {data && data.templates.length > 0 && <table className="table"><thead><tr><th>Name</th><th>Inhalt</th><th /></tr></thead><tbody>
        {data.templates.map((t) => <tr key={t.id}>
          <td><InlineName value={t.name} onSave={(name) => run(async () => { await api.patch(`/project-templates/${t.id}`, { name }); await reload(); })} />{t.description && <div className="muted small">{t.description}</div>}</td>
          <td className="small muted">{t.spec.columns?.length ?? 0} Spalten · {t.spec.subprojects?.length ?? 0} Teilprojekte · {t.spec.milestones?.length ?? 0} Meilensteine · {t.spec.labels?.length ?? 0} Labels · {t.spec.folders?.length ?? 0} Ordner</td>
          <td className="nowrap"><button className="btn sm link" disabled={busy} onClick={() => void dialog.confirm({ title: 'Vorlage löschen', text: `„${t.name}“ löschen? Bestehende Projekte bleiben unverändert.`, confirmLabel: 'Löschen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/project-templates/${t.id}`); await reload(); }); })}>✕</button></td>
        </tr>)}
      </tbody></table>}
    </div>
  );
}

function InlineName({ value, onSave }: { value: string; onSave: (v: string) => unknown }) {
  const [v, setV] = useState(value);
  return <input className="inline-text" type="text" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => { if (v.trim() && v.trim() !== value) onSave(v.trim()); else setV(value); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />;
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

/** KI-Profile je Mandant: Anbieter (lokales LLM oder Anthropic), Adresse, Modell, Schlüssel; Agenten und Projekte bekommen je eines zugewiesen. */
function AiCard() {
  const st = useAiStatus();
  const [edit, setEdit] = useState<AiProfile | 'new' | null>(null);
  const [f, setF] = useState({ name: '', provider: 'local' as 'local' | 'anthropic', baseUrl: '', model: '', apiKey: '', thinkingOff: false, projectScope: 'all' as 'all' | 'selected' | 'none', projectIds: [] as string[], personalScope: false, webSearch: false });
  const [budget, setBudget] = useState<number | null>(null);
  const [assist, setAssist] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const dialog = useDialog();
  const { busy, error, run } = useAsync();
  if (!st) return null;
  const open = (p: AiProfile | 'new') => { setEdit(p); setF(p === 'new' ? { name: '', provider: 'local', baseUrl: '', model: '', apiKey: '', thinkingOff: false, projectScope: 'all', projectIds: [], personalScope: false, webSearch: false } : { name: p.name, provider: p.provider, baseUrl: p.baseUrl ?? '', model: p.model, apiKey: '', thinkingOff: p.thinkingOff, projectScope: (p as any).projectScope ?? 'all', projectIds: (p as any).projectIds ?? [], personalScope: Boolean((p as any).personalScope), webSearch: Boolean(p.webSearch) }); };
  return (
    <div className="card">
      <div className="row between"><h2 style={{ margin: 0 }}>KI-Profile</h2><button className="btn primary sm" onClick={() => open('new')}>Profil anlegen</button></div>
      <p className="muted small">Jedes Profil ist eine KI: lokales LLM mit OpenAI-kompatibler API (vLLM, Ollama, LM Studio) oder Anthropic. Agenten bekommen je ein Profil (unten), Je Profil legst du fest, für welche Projekte es bereitsteht (alle, ausgewählte, keine); die PL wählt daraus die Projekt-KI, ohne Auswahl ist die KI dort aus. Eigene LLMs der Projekte erlaubst du unten. Regel vor KI: Vorschläge mit Freigabe, Agenten nur bei zugewiesenen Arbeitspaketen. Jede Anfrage steht im Audit mit Profil, Modell und Token.</p>
      {error && <div className="error mb">{error}</div>}
      {msg && <div className="success mb small">{msg}</div>}
      {st.profiles.length === 0 && <div className="empty mb">Noch kein Profil. Ohne Profil ist KI für den Mandanten aus.</div>}
      {st.profiles.length > 0 && <table className="table mb"><thead><tr><th>Name</th><th>Anbieter</th><th>Modell</th><th>Status</th><th /></tr></thead><tbody>
        {st.profiles.map((p) => <tr key={p.id} style={p.active ? undefined : { opacity: 0.6 }}><td>{p.name}{st.defaultProfileId === p.id && <span className="badge ok" style={{ marginLeft: 6 }} title="Vorbelegung für neue Agenten">Standard</span>}</td><td className="small">{p.provider === 'local' ? <>Lokales LLM<div className="muted">{p.baseUrl}</div></> : 'Anthropic'}</td><td className="small">{p.model}{p.provider === 'local' && p.thinkingOff && <div><span className="badge" title="Denkmodus aus: enable_thinking = false">Denkmodus aus</span></div>}<div className="muted">{{ all: `alle Projekte${(p as any).personalScope ? ' (auch persönliche)' : ''}`, selected: `${(p as any).projectIds?.length ?? 0} ausgewählte Projekte`, none: 'nur Agenten des Org-Admins' }[((p as any).projectScope ?? 'all') as 'all' | 'selected' | 'none']}</div></td><td className="small">{!p.active ? <span className="badge">inaktiv</span> : p.provider === 'anthropic' && !p.hasKey ? <span className="badge warn">Schlüssel fehlt</span> : <span className="badge ok">bereit</span>}</td>
          <td className="nowrap"><button className="btn sm" disabled={busy} onClick={() => void run(async () => { const r = await api.post<{ model: string; reply: string }>(`/ai/profiles/${p.id}/test`); setMsg(`${p.name}: ${r.model} antwortet „${r.reply}“.`); })}>Testen</button>{' '}
            <button className="btn sm" onClick={() => open(p)}>Bearbeiten</button>{' '}
            {st.defaultProfileId !== p.id && <><button className="btn sm" disabled={busy} onClick={() => void run(async () => { await api.put('/ai/settings', { defaultProfileId: p.id }); await invalidateAi(); })}>Als Standard</button>{' '}</>}
            <button className="btn sm danger" disabled={busy} onClick={() => void dialog.confirm({ title: 'Profil löschen', text: `„${p.name}“ löschen? Agenten und Projekte, die es nutzen, verlieren ihre KI, bis ein anderes Profil zugewiesen ist.`, confirmLabel: 'Löschen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/ai/profiles/${p.id}`); await invalidateAi(); }); })}>Löschen</button></td></tr>)}
      </tbody></table>}
      <div className="row small"><span className="muted" title="0 = Agenten laufen nicht; gezählt werden ausgeführte Läufe (auch mit Fehler)">Tagesbudget je Agent (Läufe, 0 = keine):</span><input type="number" min={0} max={1000} value={budget ?? st.agentDailyBudget} onChange={(e) => setBudget(Number(e.target.value))} style={{ width: 90 }} /><button className="btn sm" disabled={busy || budget == null} onClick={() => void run(async () => { await api.put('/ai/settings', { agentDailyBudget: budget }); setBudget(null); await invalidateAi(); setMsg('Budget gespeichert.'); })}>Speichern</button></div>
      <div className="row small mt"><span className="muted" title="Zusammenfassen, Essenz, Statusbericht, Frage ans Projekt, Abschluss-Antwort; 0 = keine">Tagesbudget KI-Assistenz je Projekt (Anfragen, 0 = keine):</span><input type="number" min={0} max={10000} value={assist ?? st.assistDailyBudget ?? 200} onChange={(e) => setAssist(Number(e.target.value))} style={{ width: 90 }} /><button className="btn sm" disabled={busy || assist == null} onClick={() => void run(async () => { await api.put('/ai/settings', { assistDailyBudget: assist }); setAssist(null); await invalidateAi(); setMsg('Budget gespeichert.'); })}>Speichern</button></div>
      <div className="row small mt"><span className="muted" title="Gilt für Mails, Antworten auf Ursprungsmails und PDF-Versand der KI-Agenten an Nicht-Interne; Entwürfe der Mail-KI und die Abschluss-Antwort mit KI werden nur geprüft (Hinweise)">Außenprüfung für Agenten-Mails an Nicht-Interne:</span>
        <select value={st.externalGuard ?? 'strict'} disabled={busy} style={{ width: 'auto' }} onChange={(e) => void run(async () => { await api.put('/ai/settings', { externalGuard: e.target.value }); await invalidateAi(); setMsg('Außenprüfung gespeichert.'); })}>
          <option value="strict">streng: mit Außenkontext neu formulieren, dann prüfen (ein Zusatzaufruf je Mail)</option>
          <option value="check">nur prüfen</option>
        </select></div>
      <PlAgentPolicy st={st} onSaved={async () => { await invalidateAi(); setMsg('Einstellungen gespeichert.'); }} />
      <h3 className="mt">Agenten-Policy des Mandanten</h3>
      <p className="muted small">Vorgabe für alle Projekte: Selbstständigkeit (ohne Angabe „Rückfrage bei wichtigen Schritten“; Bestandsprojekte stehen auf „Selbstständig“) und Grenzen, die kein Projekt unterschreiten kann. Die PL stellt je Projekt, Agent und Arbeitspaket weiter ein; gesperrte Klassen regeln die KI-Freigaben (agent.finalize, agent.send_external, agent.close …).</p>
      <AgentPolicyEditor value={st.agentPolicy ?? {}} limits workflows inheritFrom="Standard" onSave={async (v) => { await api.put('/ai/settings', { agentPolicy: v }); await invalidateAi(); setMsg('Agenten-Policy gespeichert.'); }} />
      <WebSearchForm st={st} onSaved={async () => { await invalidateAi(); setMsg('Einstellungen gespeichert.'); }} />
      {edit && (
        <Modal title={edit === 'new' ? 'KI-Profil anlegen' : `Profil: ${edit.name}`} onClose={() => setEdit(null)}>
          <div className="form cols-2">
            <label className="field full"><span>Name</span><input type="text" value={f.name} autoFocus placeholder="z. B. Qwen3 auf der KI-VM" onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label className="field"><span>Anbieter</span><select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value as any, model: '' })}><option value="local">Lokales LLM (OpenAI-kompatibel: vLLM, Ollama, LM Studio)</option><option value="anthropic">Anthropic (Claude)</option></select></label>
            {f.provider === 'local'
              ? <label className="field"><span>Adresse der API</span><input type="url" value={f.baseUrl} placeholder="http://llm.intern:8000/v1" onChange={(e) => setF({ ...f, baseUrl: e.target.value })} /><span className="muted small">vLLM: Port 8000, Pfad /v1 · Ollama: http://host:11434/v1</span></label>
              : <label className="field"><span>API-Schlüssel{edit !== 'new' && edit.hasKey && <span className="muted"> · gesetzt, leer = unverändert</span>}</span><input type="password" value={f.apiKey} autoComplete="new-password" placeholder="sk-ant-…" onChange={(e) => setF({ ...f, apiKey: e.target.value })} /></label>}
            <label className="field"><span>Modell</span>{f.provider === 'local'
              ? <input type="text" value={f.model} placeholder="Name wie in vLLM/Ollama, z. B. Qwen/Qwen3-32B" onChange={(e) => setF({ ...f, model: e.target.value })} />
              : <select value={f.model || st.models[0]} onChange={(e) => setF({ ...f, model: e.target.value })}>{st.models.map((m) => <option key={m} value={m}>{m}</option>)}</select>}</label>
            {f.provider === 'local' && <label className="field"><span>Schlüssel (optional, Bearer)</span><input type="password" value={f.apiKey} autoComplete="new-password" placeholder="leer, wenn der Server keinen verlangt" onChange={(e) => setF({ ...f, apiKey: e.target.value })} /></label>}
            {f.provider === 'local' && <div className="full stack" style={{ gap: 4 }}>
              <label className="check"><input type="checkbox" checked={f.thinkingOff} onChange={(e) => setF({ ...f, thinkingOff: e.target.checked })} /> Denkmodus aus</label>
              <label className="check" title="Dazu muss die KI-Freigabe „Online-Recherche“ (agent.web) erlauben; lokale Profile brauchen einen Suchdienst (unten)"><input type="checkbox" checked={f.webSearch} onChange={(e) => setF({ ...f, webSearch: e.target.checked })} /> Online-Recherche mit diesem Profil erlaubt</label>
              <span className="muted small">Für Modelle mit Thinking (z. B. Qwen): schneller, weniger Token, keine abgeschnittenen Antworten. Sendet <code>chat_template_kwargs.enable_thinking = false</code> (vLLM, llama.cpp).</span>
            </div>}
            <ScopeEditor scope={f.projectScope} projectIds={f.projectIds} onChange={(projectScope, projectIds) => setF({ ...f, projectScope, projectIds, personalScope: projectScope === 'all' && f.personalScope })} />
            {f.projectScope === 'all' && <label className="check full"><input type="checkbox" checked={f.personalScope} onChange={(e) => setF({ ...f, personalScope: e.target.checked })} /> auch in persönlichen Projekten <span className="muted small">(sonst sehen persönliche Projekte nur ihr eigenes LLM)</span></label>}
            {f.projectScope === 'selected' && <span className="muted small full">Persönliche Projekte stehen als „persönlich (Name)“ in der Liste und werden einzeln ausgewählt.</span>}
            {error && <div className="error full">{error}</div>}
            <div className="full row">
              <button className="btn primary" disabled={busy || !f.name.trim() || (f.provider === 'local' ? !f.baseUrl || !f.model : false)} onClick={() => void run(async () => { const body = { name: f.name, provider: f.provider, baseUrl: f.baseUrl || null, model: f.model || st.models[0], apiKey: f.apiKey || undefined, thinkingOff: f.provider === 'local' && f.thinkingOff, projectScope: f.projectScope, projectIds: f.projectIds, personalScope: f.projectScope === 'all' && f.personalScope }; if (edit === 'new') await api.post('/ai/profiles', body); else await api.patch(`/ai/profiles/${edit.id}`, body); setEdit(null); await invalidateAi(); })}>{edit === 'new' ? 'Anlegen' : 'Speichern'}</button>
              {edit !== 'new' && <button className="btn" disabled={busy} onClick={() => void run(async () => { await api.patch(`/ai/profiles/${edit.id}`, { active: !edit.active }); setEdit(null); await invalidateAi(); })}>{edit.active ? 'Deaktivieren' : 'Aktivieren'}</button>}
              <button className="btn" onClick={() => setEdit(null)}>Abbrechen</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Eigene LLMs der Projekte und höchstes Tagesbudget eigener Agenten der PL (nie über dem Mandantenwert); ob PL Agenten anlegen dürfen, regeln die KI-Freigaben. */
/** Online-Recherche (Konzept 8) und Arbeitszeitfenster für Mails der Agenten nach außen. */
function WebSearchForm({ st, onSaved }: { st: NonNullable<ReturnType<typeof useAiStatus>>; onSaved: () => Promise<void> }) {
  const w = st.web ?? {};
  const win = st.externalWindow ?? { enabled: true, days: [1, 2, 3, 4, 5], from: '07:00', to: '19:00' };
  const [f, setF] = useState({ provider: w.provider ?? 'none', url: w.url ?? '', apiKey: '', maxPerRun: w.maxPerRun ?? 5, dailyPerAgent: w.dailyPerAgent ?? 20, allowed: (w.allowedDomains ?? []).join(', '), blocked: (w.blockedDomains ?? []).join(', ') });
  const [fw, setFw] = useState({ enabled: win.enabled, days: win.days, from: win.from, to: win.to });
  const { busy, error, run } = useAsync();
  const list = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
  return <>
    <h3 className="mt">Online-Recherche</h3>
    <p className="muted small">Standardmäßig gesperrt: freigegeben wird über die KI-Freigabe „Online-Recherche“ (agent.web) je Mandant, Projekt oder Agent und das Häkchen am Profil. Anthropic-Profile suchen über das Server-Tool web_search (Kosten je Suche laut Preisliste); lokale Profile brauchen SearXNG (eigener Dienst) oder die Brave Search API. Nur lesen, Quellen werden gespeichert und Seiten als Abschnitt „Quellen“ angehängt; Suchbegriffe ohne Namen, Adressen und Interna.</p>
    <div className="form cols-2">
      <label className="field"><span>Suchdienst für lokale Profile</span><select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value as 'none' | 'searxng' | 'brave' })}><option value="none">keiner (nur Anthropic-Profile recherchieren)</option><option value="searxng">SearXNG (eigene Instanz)</option><option value="brave">Brave Search API</option></select></label>
      {f.provider === 'searxng' && <label className="field"><span>SearXNG-Adresse</span><input type="url" value={f.url} placeholder="https://searx.firma.local" onChange={(e) => setF({ ...f, url: e.target.value })} /></label>}
      {f.provider === 'brave' && <label className="field"><span>Brave-Schlüssel {w.hasKey && <span className="muted">(gesetzt; leer lassen = behalten)</span>}</span><input type="password" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} /></label>}
      <label className="field"><span>Suchen je Lauf (höchstens 20)</span><input type="number" min={1} max={20} value={f.maxPerRun} onChange={(e) => setF({ ...f, maxPerRun: Number(e.target.value) })} /></label>
      <label className="field"><span>Suchen je Agent und Tag</span><input type="number" min={0} max={500} value={f.dailyPerAgent} onChange={(e) => setF({ ...f, dailyPerAgent: Number(e.target.value) })} /></label>
      <label className="field"><span>Nur diese Domains (Komma)</span><input type="text" value={f.allowed} placeholder="leer = alle" onChange={(e) => setF({ ...f, allowed: e.target.value, blocked: e.target.value ? '' : f.blocked })} /></label>
      <label className="field"><span>Gesperrte Domains (Komma)</span><input type="text" value={f.blocked} disabled={Boolean(f.allowed)} onChange={(e) => setF({ ...f, blocked: e.target.value })} /></label>
      <div className="full"><button className="btn primary sm" disabled={busy} onClick={() => void run(async () => { await api.put('/ai/settings', { web: { provider: f.provider, url: f.url || null, ...(f.apiKey ? { apiKey: f.apiKey } : {}), maxPerRun: f.maxPerRun, dailyPerAgent: f.dailyPerAgent, allowedDomains: list(f.allowed), blockedDomains: list(f.blocked) } }); setF({ ...f, apiKey: '' }); await onSaved(); })}>Speichern</button></div>
    </div>
    <h3 className="mt">Arbeitszeitfenster für Mails nach außen</h3>
    <p className="muted small">Mails der Agenten an Nicht-Interne (auch Antworten auf Ursprungsmails und PDF-Versand) gehen nur in diesem Fenster (Europe/Berlin); außerhalb plant das System den Versand auf den nächsten Fensterbeginn und schreibt das ins Log. Interner Chat, Fragen und Entwürfe sind nicht betroffen.</p>
    <div className="form cols-2">
      <label className="check full"><input type="checkbox" checked={fw.enabled} onChange={(e) => setFw({ ...fw, enabled: e.target.checked })} /> Fenster aktiv</label>
      <div className="field"><span>Wochentage</span><div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>{['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((d, i) => <label key={d} className="check small" style={{ margin: 0 }}><input type="checkbox" checked={fw.days.includes(i + 1)} onChange={(e) => setFw({ ...fw, days: e.target.checked ? [...fw.days, i + 1].sort() : fw.days.filter((x) => x !== i + 1) })} /> {d}</label>)}</div></div>
      <div className="row"><label className="field"><span>von</span><input type="time" value={fw.from} onChange={(e) => setFw({ ...fw, from: e.target.value })} /></label><label className="field"><span>bis</span><input type="time" value={fw.to} onChange={(e) => setFw({ ...fw, to: e.target.value })} /></label></div>
      {error && <div className="error full">{error}</div>}
      <div className="full"><button className="btn primary sm" disabled={busy} onClick={() => void run(async () => { await api.put('/ai/settings', { externalWindow: fw }); await onSaved(); })}>Speichern</button></div>
    </div>
  </>;
}

function PlAgentPolicy({ st, onSaved }: { st: NonNullable<ReturnType<typeof useAiStatus>>; onSaved: () => Promise<void> }) {
  const cur = { maxBudget: st.plAgents?.maxBudget ?? 20, ownLlm: st.ownLlm ?? 'personal' };
  const [f, setF] = useState<typeof cur | null>(null);
  const v = f ?? cur;
  const { busy, error, run } = useAsync();
  return (
    <div className="mt" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
      <label className="field"><span>Eigenes LLM in Projekten einbinden (durch die PL)</span><select value={v.ownLlm} onChange={(e) => setF({ ...v, ownLlm: e.target.value as any })} style={{ width: 'auto' }}><option value="off">nicht erlaubt</option><option value="personal">nur in persönlichen Projekten</option><option value="all">in allen Projekten</option></select></label>
      <div className="small mt">
        <div className="row"><span className="muted">Eigene Agenten der PL ({st.plAgents?.enabled ? 'erlaubt' : 'gesperrt'}, Regel unter KI-Freigaben), höchstes Tagesbudget je Agent:</span><input type="number" min={0} max={st.agentDailyBudget} value={v.maxBudget} onChange={(e) => setF({ ...v, maxBudget: Number(e.target.value) })} style={{ width: 90 }} /><span className="muted">(Mandant: {st.agentDailyBudget})</span></div>
        <p className="muted">Eigene Agenten laufen auf den im Projekt verfügbaren LLMs (Freigabe je Profil oben, eigenes LLM des Projekts). Sie gehören zum Projekt: nur dort einsetzbar, Chat nur für Mitglieder. Du siehst sie unten und kannst sie deaktivieren, aber nicht ihre Inhalte oder Läufe.</p>
      </div>
      {error && <div className="error small">{error}</div>}
      <button className="btn sm mt" disabled={busy || !f} onClick={() => void run(async () => { await api.put('/ai/settings', { plAgents: { maxBudget: v.maxBudget }, ownLlm: v.ownLlm }); setF(null); await onSaved(); })}>Speichern</button>
    </div>
  );
}

/** Eigene LLMs der Projekte: Metadaten und Verbrauch, sperren/entsperren; Schlüssel und Inhalte sieht der Org-Admin nicht. */
function ProjectLlmsCard() {
  const d = useData<{ llms: { id: string; name: string; provider: string; model: string; baseUrl: string | null; active: boolean; adminBlocked: boolean; tokensIn: number; tokensOut: number; lastUsedAt: string | null; project: string; createdBy: string | null }[] }>('/ai/project-llms');
  const { busy, error, run } = useAsync();
  if (!d.data || d.data.llms.length === 0) return null;
  return (
    <div className="card">
      <h2>Eigene LLMs der Projekte</h2>
      <p className="muted small">Von PL eingebundene LLMs, nur im jeweiligen Projekt nutzbar. Sichtbar sind Metadaten und Verbrauch, nicht Schlüssel oder Inhalte. Gesperrte LLMs nutzen weder Projekt-KI noch Agenten.</p>
      {error && <div className="error small">{error}</div>}
      <table className="table"><thead><tr><th>Name</th><th>Anbieter / Adresse</th><th>Projekt</th><th>Verbrauch</th><th /></tr></thead><tbody>
        {d.data.llms.map((l) => <tr key={l.id} style={l.adminBlocked || !l.active ? { opacity: 0.6 } : undefined}><td>{l.name}{l.adminBlocked && <span className="badge danger" style={{ marginLeft: 6 }}>gesperrt</span>}{!l.active && <span className="badge" style={{ marginLeft: 6 }}>inaktiv</span>}<div className="muted small">von {l.createdBy ?? '–'}</div></td>
          <td className="small">{l.provider === 'local' ? l.baseUrl : 'Anthropic'}<div className="muted">{l.model}</div></td><td className="small">{l.project}</td>
          <td className="small">{(l.tokensIn + l.tokensOut).toLocaleString('de-DE')} Token<div className="muted">{l.lastUsedAt ? fmtDateTime(l.lastUsedAt) : 'nie genutzt'}</div></td>
          <td><button className={`btn sm ${l.adminBlocked ? '' : 'danger'}`} disabled={busy} onClick={() => void run(async () => { await api.patch(`/ai/profiles/${l.id}`, { adminBlocked: !l.adminBlocked }); await d.reload(); })}>{l.adminBlocked ? 'Entsperren' : 'Sperren'}</button></td></tr>)}
      </tbody></table>
    </div>
  );
}

/** Freigabe eines Profils für Projekte: alle, ausgewählte oder keine (dann nur für Agenten des Org-Admins). */
function ScopeEditor({ scope, projectIds, onChange }: { scope: 'all' | 'selected' | 'none'; projectIds: string[]; onChange: (scope: 'all' | 'selected' | 'none', projectIds: string[]) => void }) {
  const projects = useData<{ projects: { id: string; label: string }[] }>(scope === 'selected' ? '/ai/release-projects' : null, [scope]);
  return (
    <div className="full stack" style={{ gap: 4 }}>
      <label className="field"><span>Für Projekte (Projekt-KI und eigene Agenten der PL)</span><select value={scope} onChange={(e) => onChange(e.target.value as any, projectIds)}><option value="all">alle Projekte</option><option value="selected">ausgewählte Projekte</option><option value="none">keine (nur Agenten des Org-Admins)</option></select></label>
      {scope === 'selected' && <div className="row small" style={{ flexWrap: 'wrap' }}>{(projects.data?.projects ?? []).map((p) => <label key={p.id} className="check"><input type="checkbox" checked={projectIds.includes(p.id)} onChange={(e) => onChange(scope, e.target.checked ? [...projectIds, p.id] : projectIds.filter((x) => x !== p.id))} /> {p.label}</label>)}</div>}
    </div>
  );
}

/** Denkmodus je Agent: wie Profil, aus oder an; wirkt nur bei lokalen Modellen. */
function ThinkingSelect({ agent, profile, disabled, onChange }: { agent: AgentUser; profile: AiProfile | null; disabled: boolean; onChange: (v: 'off' | 'on' | null) => void }) {
  const local = profile?.provider === 'local';
  return (
    <select className="mt" style={{ display: 'block' }} value={agent.thinkingMode ?? ''} disabled={disabled || !local} title={local ? 'Denkmodus des Modells für diesen Agenten' : 'Nur bei lokalen Modellen'} onChange={(e) => onChange((e.target.value || null) as 'off' | 'on' | null)}>
      <option value="">Denken: wie Profil ({profile?.thinkingOff ? 'aus' : 'Standard'})</option>
      <option value="off">Denken: aus</option>
      <option value="on">Denken: an</option>
    </select>
  );
}

/** Persona eines Agenten: eine Zeile, Speichern beim Verlassen oder mit Enter, Escape verwirft. */
function PersonaField({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <input type="text" maxLength={300} value={v} disabled={disabled} style={{ width: '100%' }} placeholder="z. B. freundlich, knapp, duzt das Team" title="Persona: beschreibt den Schreibstil des Agenten (Log, Mails, Doku, Chat)"
    onChange={(e) => setV(e.target.value)} onBlur={() => { if (v.trim() !== value) onSave(v.trim()); }}
    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setV(value); (e.target as HTMLInputElement).blur(); } }} />;
}

/** Unterschrift für Mails des Agenten: frei, mehrzeilig; leer = „Name (KI-Agent, Projekt KEY)“. */
function SignatureField({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <details className="small" style={{ marginTop: 4 }}><summary className="muted">{value ? 'Unterschrift: eigene' : 'Unterschrift: Standard'}</summary>
    <textarea rows={3} maxLength={500} value={v} disabled={disabled} style={{ width: '100%', minHeight: 64 }} placeholder={'leer = „Name (KI-Agent, Projekt KEY)“\nz. B. Viele Grüße\nMorton, Assistenz von Philipp Schwarz'} onChange={(e) => setV(e.target.value)} onBlur={() => { if (v.trim() !== value) onSave(v.trim()); }} /></details>;
}

/** KI-Agenten: Benutzer ohne Login, vom Org-Admin benannt; in Projekten Mitglied oder stellvertretende PL, nie verantwortliche PL. */
function AgentsCard() {
  const d = useData<{ agents: AgentUser[] }>('/agents');
  const st = useAiStatus();
  const [name, setName] = useState('');
  const [persona, setPersona] = useState('');
  const dialog = useDialog();
  const { busy, error, run } = useAsync();
  return (
    <div className="card">
      <h2>KI-Agenten</h2>
      <p className="muted small">Ein Agent ist ein spezieller Benutzer: kein Login, nie verantwortliche PL oder Org-Admin. Die PL nimmt ihn als Mitglied oder stellvertretende PL ins Projekt (dort auch „darf Mails senden“) und macht ihn zuständig: für Arbeitspakete, Aufgaben oder ein Teilprojekt. Er handelt dann im Rahmen dieser Rechte: Log, Status, Tasks, Planung (Aufgaben, Termine, Zuweisungen), Nachfragen per Mail, Antwort auf die Ursprungsmail, Blockade melden, Eskalation an die PL; im Chat ist er direkt erreichbar. Projekte legt er nie an. Die Persona beschreibt in einer Zeile seinen Schreibstil (Log, Mails, Doku, Chat); Fakten- und Rechteregeln gehen ihr vor. Die Unterschrift ist frei; leer gilt „Name (KI-Agent, Projekt KEY)“. Jeder Lauf steht unter Projekt › KI und im Audit.</p>
      {error && <div className="error mb">{error}</div>}
      {d.data && d.data.agents.length > 0 && <table className="table mb"><thead><tr><th>Name</th><th>Persona (Schreibstil)</th><th>KI-Profil</th><th>Projekte</th><th>Läufe</th><th>Letzter Lauf</th><th /></tr></thead><tbody>
        {d.data.agents.map((a) => a.projectBound ? <tr key={a.id} style={a.active ? undefined : { opacity: 0.6 }}><td>{a.name}{!a.active && <span className="badge" style={{ marginLeft: 6 }}>deaktiviert</span>}<div className="muted small">{a.email}</div></td><td colSpan={2} className="small muted">Agent der PL: {a.projectBound.label}{a.dailyBudget != null ? ` · Budget ${a.dailyBudget}/Tag` : ''}</td><td className="small">{a.projects.map((p) => <span key={p.id} className="badge" style={{ marginRight: 4 }}>{p.key}</span>)}</td><td>{a.runs}</td><td className="small">{a.lastRunAt ? fmtDateTime(a.lastRunAt) : '–'}</td>
          <td className="nowrap">{a.active ? <button className="btn sm danger" disabled={busy} onClick={() => void run(async () => { await api.patch(`/agents/${a.id}`, { active: false }); await d.reload(); })}>Deaktivieren</button> : <button className="btn sm" disabled={busy} onClick={() => void run(async () => { await api.patch(`/agents/${a.id}`, { active: true }); await d.reload(); })}>Aktivieren</button>}</td></tr> : <tr key={a.id} style={a.active ? undefined : { opacity: 0.6 }}><td>{a.name}{!a.active && <span className="badge" style={{ marginLeft: 6 }}>deaktiviert</span>}<div className="muted small">{a.email}</div></td>
          <td style={{ minWidth: 240 }}><PersonaField value={a.persona ?? ''} disabled={busy} onSave={(persona) => void run(async () => { await api.patch(`/agents/${a.id}`, { persona: persona || null }); await d.reload(); })} />
            <SignatureField value={a.signature ?? ''} disabled={busy} onSave={(signature) => void run(async () => { await api.patch(`/agents/${a.id}`, { signature: signature || null }); await d.reload(); })} /></td>
          <td><select value={a.aiProfileId ?? ''} disabled={busy} onChange={(e) => void run(async () => { await api.patch(`/agents/${a.id}`, { aiProfileId: e.target.value || null }); await d.reload(); })}><option value="">– Standard{st?.defaultProfileId ? ` (${st.profiles.find((p) => p.id === st.defaultProfileId)?.name ?? ''})` : ': keines'} –</option>{(st?.profiles ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}{p.active ? '' : ' (inaktiv)'}</option>)}</select>
            <ThinkingSelect agent={a} profile={st?.profiles.find((p) => p.id === (a.aiProfileId ?? st?.defaultProfileId)) ?? null} disabled={busy} onChange={(thinkingMode) => void run(async () => { await api.patch(`/agents/${a.id}`, { thinkingMode }); await d.reload(); })} /></td><td className="small">{a.projects.map((p) => <span key={p.id} className="badge" style={{ marginRight: 4 }}>{p.key}</span>)}{a.projects.length === 0 && <span className="muted">–</span>}</td><td>{a.runs}</td><td className="small">{a.lastRunAt ? fmtDateTime(a.lastRunAt) : '–'}</td>
          <td className="nowrap"><button className="btn sm" disabled={busy} onClick={() => { const n = window.prompt('Neuer Name', a.name); if (n?.trim()) void run(async () => { await api.patch(`/agents/${a.id}`, { name: n.trim() }); await d.reload(); }); }}>Umbenennen</button>{' '}
            {a.active ? <button className="btn sm danger" disabled={busy} onClick={() => void dialog.confirm({ title: 'Agent deaktivieren', text: `${a.name} deaktivieren? Zuweisungen werden entfernt, Mitgliedschaften und Historie bleiben.`, confirmLabel: 'Deaktivieren', danger: true }).then((ok) => { if (ok) void run(async () => { await api.patch(`/agents/${a.id}`, { active: false }); await d.reload(); }); })}>Deaktivieren</button> : <button className="btn sm" disabled={busy} onClick={() => void run(async () => { await api.patch(`/agents/${a.id}`, { active: true }); await d.reload(); })}>Aktivieren</button>}</td></tr>)}
      </tbody></table>}
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return; void run(async () => { await api.post('/agents', { name, persona: persona.trim() || null }); setName(''); setPersona(''); await d.reload(); }); }}>
        <input type="text" placeholder="Name des Agenten, z. B. Nachfasser" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 280 }} />
        <input type="text" placeholder="Persona (optional): Schreibstil, z. B. freundlich, knapp, duzt das Team" maxLength={300} value={persona} onChange={(e) => setPersona(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
        <button className="btn primary sm" disabled={busy || !name.trim()}>Agent anlegen</button>
      </form>
    </div>
  );
}

type PolicyListing = { rules: AiPolicyRule[]; killswitch: boolean; stoppedAgents: { id: string; name: string; projectId: string; projectLabel: string; createdById: string | null; createdByName: string | null; reason: string }[] };
type PolicyTargets = { projects: { id: string; label: string }[]; users: { id: string; name: string; email: string }[]; agents: { id: string; name: string }[]; groups: { id: string; name: string }[] };
type PolicyRow = { projectId: string | null; userId: string | null; groupId: string | null };
type RowKind = 'org' | 'group' | 'project' | 'user' | 'agent' | 'exception';
const ROW_SECTIONS: { kind: RowKind; label: string; hint: string }[] = [
  { kind: 'org', label: 'Mandant', hint: 'alle Personen und Agenten in allen Projekten' },
  { kind: 'group', label: 'Gruppen', hint: 'Mitglieder der Gruppe in allen Projekten' },
  { kind: 'project', label: 'Projekte', hint: 'alle Personen und Agenten im Projekt, auch Agenten der Org' },
  { kind: 'user', label: 'Benutzer', hint: 'eigene Nutzung der Person in allen Projekten' },
  { kind: 'agent', label: 'Agenten', hint: 'Läufe, Chat und Mail-Ansichten des Agenten in allen Projekten (für ein Projekt: Ausnahmen)' },
  { kind: 'exception', label: 'Ausnahmen', hint: 'Person, Agent oder Gruppe in einem Projekt: übersteuert Person bzw. Agent und Projekt, nicht den Notaus' }
];
const STAGE_LABEL: Record<string, string> = { killswitch: 'Notaus', policy: 'Regeln', project: 'Ebene der PL', profile: 'Profil', budget: 'Budget', ok: '' };
const rowKey = (r: PolicyRow) => `${r.projectId ?? ''}|${r.userId ?? ''}|${r.groupId ?? ''}`;

/**
 * KI-Freigaben (ersetzt den Schalter für eigene Agenten der PL): roter Notaus; Matrix mit den Zeilen Mandant, Gruppen,
 * Projekte, Benutzer, Agenten und Ausnahmen und den Spalten Kategorien bzw. Funktionen, jede Zelle erben, erlauben oder
 * sperren mit Notiz; Vorschau der Wirkung für eine Person oder einen Agenten in einem Projekt mit Spur. Sperre gewinnt;
 * eine Ausnahme gibt es nur über „Person in Projekt“; die PL kann im Projekt weiter einschränken.
 */
export function AiPolicyCard() {
  const d = useData<PolicyListing>('/ai/policies');
  const tg = useData<PolicyTargets>('/ai/policy-targets');
  const [detailed, setDetailed] = useState(false);
  const [added, setAdded] = useState<PolicyRow[]>([]);
  const [add, setAdd] = useState<{ kind: RowKind; target: string; projectId: string }>({ kind: 'project', target: '', projectId: '' });
  const [cell, setCell] = useState<{ row: PolicyRow; label: string; feature: string; effect: 'allow' | 'deny' | null; note: string } | null>(null);
  const dialog = useDialog();
  const { busy, error, run } = useAsync();
  if (!d.data || !tg.data) return null;
  const { rules, killswitch, stoppedAgents } = d.data;
  const t = tg.data;
  const kindOf = (r: PolicyRow): RowKind => r.projectId ? (r.userId || r.groupId ? 'exception' : 'project') : r.groupId ? 'group' : r.userId ? (t.agents.some((a) => a.id === r.userId) || rules.some((x) => x.userId === r.userId && x.userKind === 'agent') ? 'agent' : 'user') : 'org';
  const projectName = (id: string) => t.projects.find((p) => p.id === id)?.label ?? rules.find((x) => x.projectId === id)?.projectLabel ?? 'Projekt';
  const whoName = (r: PolicyRow) => r.userId ? ([...t.users, ...t.agents].find((u) => u.id === r.userId)?.name ?? rules.find((x) => x.userId === r.userId)?.userName ?? '?') : r.groupId ? `Gruppe ${t.groups.find((g) => g.id === r.groupId)?.name ?? rules.find((x) => x.groupId === r.groupId)?.groupName ?? '?'}` : '';
  const label = (r: PolicyRow) => { const k = kindOf(r); return k === 'org' ? 'Alle (Mandant)' : k === 'project' ? projectName(r.projectId!) : k === 'exception' ? `${whoName(r)} in ${projectName(r.projectId!)}` : whoName(r); };
  const rows = new Map<string, PolicyRow>([[rowKey({ projectId: null, userId: null, groupId: null }), { projectId: null, userId: null, groupId: null }]]);
  for (const r of [...rules.map((x) => ({ projectId: x.projectId, userId: x.userId, groupId: x.groupId })), ...added]) rows.set(rowKey(r), r);
  const cols = [{ key: '*', label: 'Alle' }, ...AI_CATEGORIES.flatMap((c) => [{ key: c.key as string, label: c.label }, ...(detailed ? AI_FEATURES.filter((f) => f.category === c.key && !('later' in f && f.later)).map((f) => ({ key: f.key as string, label: f.label })) : [])])];
  const ruleAt = (r: PolicyRow, feature: string) => rules.find((x) => rowKey(x) === rowKey(r) && x.feature === feature);
  const save = (row: PolicyRow, feature: string, effect: 'allow' | 'deny' | null, note: string | null) => run(async () => { d.setData(await api.put<PolicyListing>('/ai/policies', { ...row, feature, effect, note })); await invalidateAi(); });
  // Auswahl je Zeilenart; Ausnahmen gelten für Personen, Agenten (z. B. Morton nur in BAU) und Gruppen in einem Projekt
  const people = t.users.map((u) => ({ id: u.id, label: u.name }));
  const agentOpts = t.agents.map((a) => ({ id: a.id, label: a.name }));
  const targetGroups: { label: string | null; options: { id: string; label: string }[] }[] = add.kind === 'group' ? [{ label: null, options: t.groups.map((g) => ({ id: g.id, label: g.name })) }]
    : add.kind === 'project' ? [{ label: null, options: t.projects.map((p) => ({ id: p.id, label: p.label })) }]
    : add.kind === 'agent' ? [{ label: null, options: agentOpts }]
    : add.kind === 'exception' ? [{ label: 'Personen', options: people }, { label: 'Agenten', options: agentOpts }, { label: 'Gruppen', options: t.groups.map((g) => ({ id: `g:${g.id}`, label: `Gruppe ${g.name}` })) }]
    : [{ label: null, options: people }];
  const addRow = () => {
    const tid = add.target;
    const row: PolicyRow = add.kind === 'group' ? { projectId: null, userId: null, groupId: tid } : add.kind === 'project' ? { projectId: tid, userId: null, groupId: null }
      : add.kind === 'exception' ? { projectId: add.projectId, userId: tid.startsWith('g:') ? null : tid, groupId: tid.startsWith('g:') ? tid.slice(2) : null } : { projectId: null, userId: tid, groupId: null };
    setAdded([...added, row]);
    setAdd({ ...add, target: '' });
  };
  return (
    <div className="card">
      <div className="row between"><h2 style={{ margin: 0 }}>KI-Freigaben</h2>
        {killswitch
          ? <button className="btn sm" disabled={busy} onClick={() => void run(async () => { await api.put('/ai/settings', { enabled: true }); await d.reload(); await invalidateAi(); })}>KI wieder einschalten</button>
          : <button className="btn sm danger" disabled={busy} onClick={() => void dialog.confirm({ title: 'Notaus: KI abschalten', text: 'Alle KI-Funktionen im Mandanten sind sofort aus: Assistenz, Mail-KI, Agentenläufe und Chat mit Agenten, auch Verbindungstests. Ausnahmen gelten nicht. Läufe stehen als übersprungen im Protokoll.', confirmLabel: 'KI abschalten', danger: true }).then((ok) => { if (ok) void run(async () => { await api.put('/ai/settings', { enabled: false }); await d.reload(); await invalidateAi(); }); })}>Notaus: KI abschalten</button>}
      </div>
      {killswitch && <div className="notice danger mt"><strong>Notaus aktiv:</strong> KI ist im Mandanten abgeschaltet, auch gegen Ausnahmen.</div>}
      <p className="muted small">Regeln für Ort (alle Projekte oder ein Projekt), Wer (alle, Gruppe, Person, Agent) und Funktion. Ohne Regel wird geerbt; innerhalb einer Zeile gilt die Funktion vor der Kategorie vor „Alle“. Sperre gewinnt: Ist ein Projekt gesperrt, hilft eine Personenfreigabe nicht; eine Ausnahme gibt es nur als „Person in Projekt“. Die PL kann im Projekt weiter einschränken (Projekt-KI, „KI nutzen“, Agenten), der Notaus gilt immer. Ohne Regel erlaubt, außer „Eigene Agenten der PL“.</p>
      {error && <div className="error mb">{error}</div>}
      {stoppedAgents.length > 0 && <div className="notice mb small">
        <strong>Gestoppte Agenten der PL</strong> (Regel „Eigene Agenten der PL“):
        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{stoppedAgents.map((a) => <li key={a.id}>{a.name} · {a.projectLabel}{a.createdByName ? ` · angelegt von ${a.createdByName}` : ''} <button className="btn sm link" disabled={busy} title="Ausnahme für die PL in ihrem Projekt" onClick={() => void save({ projectId: a.projectId, userId: a.createdById, groupId: null }, 'pl.agents', 'allow', `Agent ${a.name} erlaubt`)}>erlauben</button><div className="muted">{a.reason}</div></li>)}</ul>
      </div>}
      <div className="row mb small"><label className="check"><input type="checkbox" checked={detailed} onChange={(e) => setDetailed(e.target.checked)} /> Funktionen einzeln</label><span className="muted">✓ erlaubt · ✕ gesperrt · · erbt; Klick ändert, • = mit Notiz</span></div>
      <div style={{ overflowX: 'auto' }}>
        <table className="table ai-matrix"><thead><tr><th>Wer / Ort</th>{cols.map((c) => <th key={c.key} className="small" title={c.key}>{c.label}</th>)}</tr></thead><tbody>
          {ROW_SECTIONS.map((sec) => {
            const list = [...rows.values()].filter((r) => kindOf(r) === sec.kind);
            if (!list.length) return null;
            return [<tr key={sec.kind} className="sec"><td colSpan={cols.length + 1}>{sec.label} <span className="muted" style={{ fontWeight: 400 }}>· {sec.hint}</span></td></tr>,
              ...list.map((r) => <tr key={rowKey(r)}><td className="small">{label(r)}</td>{cols.map((c) => { const x = ruleAt(r, c.key); return <td key={c.key}><button className={`ai-cell ${x?.effect ?? ''} ${x?.note ? 'note' : ''}`} disabled={busy} title={x ? `${x.effect === 'allow' ? 'erlaubt' : 'gesperrt'}${x.note ? `: ${x.note}` : ''}${x.setByName ? ` (${x.setByName})` : ''}` : 'erbt'} onClick={() => setCell({ row: r, label: label(r), feature: c.key, effect: x?.effect ?? null, note: x?.note ?? '' })}>{x ? (x.effect === 'allow' ? '✓' : '✕') : '·'}</button></td>; })}</tr>)];
          })}
        </tbody></table>
      </div>
      <div className="row small mt" style={{ flexWrap: 'wrap' }}>
        <span className="muted">Zeile hinzufügen:</span>
        <select aria-label="Zeilenart" value={add.kind} onChange={(e) => setAdd({ kind: e.target.value as RowKind, target: '', projectId: '' })} style={{ width: 'auto' }}>{ROW_SECTIONS.filter((x) => x.kind !== 'org').map((x) => <option key={x.kind} value={x.kind}>{x.label}</option>)}</select>
        {add.kind === 'exception' && <select aria-label="Projekt" value={add.projectId} onChange={(e) => setAdd({ ...add, projectId: e.target.value })} style={{ width: 'auto' }}><option value="">Projekt …</option>{t.projects.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>}
        <select aria-label="Wer" value={add.target} onChange={(e) => setAdd({ ...add, target: e.target.value })} style={{ width: 'auto' }}><option value="">{add.kind === 'exception' ? 'Person, Agent oder Gruppe …' : 'wählen …'}</option>
          {targetGroups.map((g) => { const opts = g.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>); return g.label ? (g.options.length ? <optgroup key={g.label} label={g.label}>{opts}</optgroup> : null) : opts; })}</select>
        <button className="btn sm" disabled={!add.target || (add.kind === 'exception' && !add.projectId)} onClick={addRow}>Hinzufügen</button>
      </div>
      <AiPolicyPreview targets={t} />
      {cell && (
        <Modal title={`${cell.label} · ${cols.find((c) => c.key === cell.feature)?.label ?? cell.feature}`} onClose={() => setCell(null)}>
          <div className="form">
            <div className="row">{([[null, 'erben'], ['allow', 'erlauben'], ['deny', 'sperren']] as const).map(([v, l]) => <label key={l} className="check"><input type="radio" name="ai-cell" checked={cell.effect === v} onChange={() => setCell({ ...cell, effect: v })} /> {l}</label>)}</div>
            {cell.effect && <label className="field"><span>Notiz (erscheint in der Begründung)</span><input type="text" maxLength={300} value={cell.note} placeholder="z. B. Datenschutz Bauherr" onChange={(e) => setCell({ ...cell, note: e.target.value })} /></label>}
            <div className="row"><button className="btn primary" disabled={busy} onClick={() => void save(cell.row, cell.feature, cell.effect, cell.note.trim() || null).then(() => setCell(null))}>Speichern</button><button className="btn" onClick={() => setCell(null)}>Abbrechen</button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Vorschau: Wirkung für eine Person oder einen Agenten (optional in einem Projekt), je Funktion mit Begründung und Spur. */
function AiPolicyPreview({ targets }: { targets: PolicyTargets }) {
  const [who, setWho] = useState('');
  const [projectId, setProjectId] = useState('');
  const eff = useData<{ subject: { name: string; kind: string }; project: { label: string } | null; features: { feature: string; label: string; decision: AiDecision }[] }>(who ? `/ai/policies/effective?userId=${who}${projectId ? `&projectId=${projectId}` : ''}` : null, [who, projectId]);
  return (
    <div className="mt" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
      <div className="row small" style={{ flexWrap: 'wrap' }}>
        <strong>Wirkung für</strong>
        <select value={who} onChange={(e) => setWho(e.target.value)} style={{ width: 'auto' }}><option value="">Person oder Agent …</option><optgroup label="Personen">{targets.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</optgroup><optgroup label="Agenten">{targets.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</optgroup></select>
        <span>in</span>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ width: 'auto' }}><option value="">ohne Projekt</option>{targets.projects.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
      </div>
      {eff.error && <div className="error small mt">{eff.error}</div>}
      {who && eff.data && <table className="table mt"><thead><tr><th>Funktion</th><th>Ergebnis</th><th>Begründung</th></tr></thead><tbody>
        {eff.data.features.map((f) => <tr key={f.feature}><td className="small">{f.label}<div className="muted"><code>{f.feature}</code></div></td>
          <td>{f.decision.allowed ? <span className="badge ok">erlaubt</span> : <span className="badge danger">{STAGE_LABEL[f.decision.stage] || 'gesperrt'}</span>}</td>
          <td className="small">{f.decision.reason}<details><summary className="muted">Spur</summary><ol style={{ margin: '2px 0 0', paddingLeft: 18 }}>{f.decision.trace.map((s, i) => <li key={i} style={s.ok ? undefined : { color: 'var(--danger)' }}>{s.ok ? '✓' : '✕'} {STAGE_LABEL[s.stage]}: {s.text}</li>)}</ol></details></td></tr>)}
      </tbody></table>}
    </div>
  );
}
