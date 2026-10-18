import { useEffect, useState } from 'react';
import type { AgentUser, AiProfile, AuditEntry, DocTemplate, Group, Invitation, OrgSettings, ProjectTemplate, User } from '@projekttool/shared';
import { Link } from 'react-router-dom';
import { RichEditor } from '../components/RichEditor';
import { api, downloadCsv, fmtDateTime } from '../lib/api';
import { useData } from '../lib/useData';
import { TopBar } from '../components/Layout';
import { Modal, useAsync, useDialog } from '../components/ui';
import { invalidateAi, useAiStatus } from '../lib/useAi';

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
            {users.data?.users.map((u) => <tr key={u.id}><td>{u.name}</td><td>{u.email}</td><td><span className="badge">{globalLabel[u.globalRole]}</span>{u.totpEnabled && <span className="badge ok" style={{ marginLeft: 4 }} title="Zweiter Faktor aktiv">2FA</span>}</td>
              <td className="nowrap">{u.totpEnabled && <button className="btn sm" disabled={busy} style={{ marginRight: 6 }} onClick={() => void dialog.confirm({ title: 'Zweiten Faktor zurücksetzen', text: `${u.name} meldet sich danach wieder nur mit dem Passwort an und kann den zweiten Faktor neu einrichten.`, confirmLabel: 'Zurücksetzen' }).then((ok) => { if (ok) void run(async () => { await api.post(`/users/${u.id}/totp/reset`); await users.reload(); }); })}>2FA zurücksetzen</button>}<button className="btn sm danger" disabled={busy} onClick={() => void dialog.confirm({ title: 'Benutzer deaktivieren', text: `${u.name} deaktivieren? Der Login endet, persönliche Mail-Konten werden getrennt, Zuständigkeiten fallen auf die Vererbung zurück.`, confirmLabel: 'Deaktivieren', danger: true }).then((ok) => { if (ok) void run(async () => { await api.post(`/users/${u.id}/deactivate`); await users.reload(); }); })}>Deaktivieren</button></td></tr>)}
          </tbody></table>
        </div>
        <GroupsCard users={users.data?.users ?? []} />
        <PdfStyleCard />
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
  const [f, setF] = useState({ name: '', description: '', idpName: '', memberIds: [] as string[] });
  const { busy, error, run } = useAsync();
  const dialog = useDialog();
  const open = (g: Group | null) => { setEdit(g ?? { id: '', name: '', description: '', memberIds: [] }); setF({ name: g?.name ?? '', description: g?.description ?? '', idpName: g?.idpName ?? '', memberIds: g?.memberIds ?? [] }); };
  return (
    <div className="card">
      <div className="row between"><h2 style={{ margin: 0 }}>Berechtigungsgruppen</h2><button className="btn sm" onClick={() => open(null)}>+ Gruppe</button></div>
      <p className="muted small">Gruppen bündeln Benutzer für Sichtbarkeit und Rechte: eingeschränkte Teilprojekte und Mail-Ansichten lassen sich an Gruppen freigeben.</p>
      {data && data.groups.length === 0 && <div className="empty">Noch keine Gruppen.</div>}
      {data && data.groups.length > 0 && <table className="table"><thead><tr><th>Gruppe</th><th>Mitglieder</th><th /></tr></thead><tbody>
        {data.groups.map((g) => <tr key={g.id}><td>{g.name}{g.idpName && <span className="badge" style={{ marginLeft: 6 }} title="Mitglieder kommen bei SSO-Anmeldung aus dieser Gruppe des Identitätsanbieters">SSO: {g.idpName}</span>}{g.description && <div className="muted small">{g.description}</div>}</td><td className="small">{g.memberIds.map((id) => users.find((u) => u.id === id)?.name).filter(Boolean).join(', ') || <span className="muted">–</span>}</td>
          <td className="nowrap"><button className="btn sm link" onClick={() => open(g)}>Bearbeiten</button><button className="btn sm link" onClick={() => void dialog.confirm({ title: 'Gruppe löschen', text: `„${g.name}“ löschen? Freigaben über diese Gruppe (Teilprojekte, Mail-Ansichten) enden.`, confirmLabel: 'Löschen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/groups/${g.id}`); await reload(); }); })}>✕</button></td></tr>)}
      </tbody></table>}
      {error && <div className="error mt">{error}</div>}
      {edit && (
        <Modal title={edit.id ? `Gruppe: ${edit.name}` : 'Neue Gruppe'} onClose={() => setEdit(null)}>
          <div className="form">
            <label className="field"><span>Name</span><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></label>
            <label className="field"><span>Beschreibung</span><input type="text" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
            <label className="field"><span>Gruppe beim Identitätsanbieter (SSO, optional)</span><input type="text" value={f.idpName} placeholder="z. B. PM-Team (Name aus dem Gruppen-Claim)" onChange={(e) => setF({ ...f, idpName: e.target.value })} /><span className="muted small">Bei jeder SSO-Anmeldung wird die Mitgliedschaft nach dieser Gruppe gesetzt oder entfernt.</span></label>
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
        <label className="check full"><input type="checkbox" checked={Boolean(v.personalProjects)} onChange={(e) => setF({ ...v, personalProjects: e.target.checked })} /> Alle Benutzer dürfen ein persönliches Projekt (Assistent) anlegen: nur die Person und KI-Agenten, Org-Admin ohne Inhalte und ohne Kontenverwaltung. Projektersteller dürfen es immer.</label>
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
  const [f, setF] = useState({ name: '', provider: 'local' as 'local' | 'anthropic', baseUrl: '', model: '', apiKey: '', thinkingOff: false, projectScope: 'all' as 'all' | 'selected' | 'none', projectIds: [] as string[] });
  const [budget, setBudget] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const dialog = useDialog();
  const { busy, error, run } = useAsync();
  if (!st) return null;
  const open = (p: AiProfile | 'new') => { setEdit(p); setF(p === 'new' ? { name: '', provider: 'local', baseUrl: '', model: '', apiKey: '', thinkingOff: false, projectScope: 'all', projectIds: [] } : { name: p.name, provider: p.provider, baseUrl: p.baseUrl ?? '', model: p.model, apiKey: '', thinkingOff: p.thinkingOff, projectScope: (p as any).projectScope ?? 'all', projectIds: (p as any).projectIds ?? [] }); };
  return (
    <div className="card">
      <div className="row between"><h2 style={{ margin: 0 }}>KI-Profile</h2><button className="btn primary sm" onClick={() => open('new')}>Profil anlegen</button></div>
      <p className="muted small">Jedes Profil ist eine KI: lokales LLM mit OpenAI-kompatibler API (vLLM, Ollama, LM Studio) oder Anthropic. Agenten bekommen je ein Profil (unten), Je Profil legst du fest, für welche Projekte es bereitsteht (alle, ausgewählte, keine); die PL wählt daraus die Projekt-KI, ohne Auswahl ist die KI dort aus. Eigene LLMs der Projekte erlaubst du unten. Regel vor KI: Vorschläge mit Freigabe, Agenten nur bei zugewiesenen Arbeitspaketen. Jede Anfrage steht im Audit mit Profil, Modell und Token.</p>
      {error && <div className="error mb">{error}</div>}
      {msg && <div className="success mb small">{msg}</div>}
      {st.profiles.length === 0 && <div className="empty mb">Noch kein Profil. Ohne Profil ist KI für den Mandanten aus.</div>}
      {st.profiles.length > 0 && <table className="table mb"><thead><tr><th>Name</th><th>Anbieter</th><th>Modell</th><th>Status</th><th /></tr></thead><tbody>
        {st.profiles.map((p) => <tr key={p.id} style={p.active ? undefined : { opacity: 0.6 }}><td>{p.name}{st.defaultProfileId === p.id && <span className="badge ok" style={{ marginLeft: 6 }} title="Vorbelegung für neue Agenten">Standard</span>}</td><td className="small">{p.provider === 'local' ? <>Lokales LLM<div className="muted">{p.baseUrl}</div></> : 'Anthropic'}</td><td className="small">{p.model}{p.provider === 'local' && p.thinkingOff && <div><span className="badge" title="Denkmodus aus: enable_thinking = false">Denkmodus aus</span></div>}<div className="muted">{{ all: 'alle Projekte', selected: `${(p as any).projectIds?.length ?? 0} ausgewählte Projekte`, none: 'nur Agenten des Org-Admins' }[((p as any).projectScope ?? 'all') as 'all' | 'selected' | 'none']}</div></td><td className="small">{!p.active ? <span className="badge">inaktiv</span> : p.provider === 'anthropic' && !p.hasKey ? <span className="badge warn">Schlüssel fehlt</span> : <span className="badge ok">bereit</span>}</td>
          <td className="nowrap"><button className="btn sm" disabled={busy} onClick={() => void run(async () => { const r = await api.post<{ model: string; reply: string }>(`/ai/profiles/${p.id}/test`); setMsg(`${p.name}: ${r.model} antwortet „${r.reply}“.`); })}>Testen</button>{' '}
            <button className="btn sm" onClick={() => open(p)}>Bearbeiten</button>{' '}
            {st.defaultProfileId !== p.id && <><button className="btn sm" disabled={busy} onClick={() => void run(async () => { await api.put('/ai/settings', { defaultProfileId: p.id }); await invalidateAi(); })}>Als Standard</button>{' '}</>}
            <button className="btn sm danger" disabled={busy} onClick={() => void dialog.confirm({ title: 'Profil löschen', text: `„${p.name}“ löschen? Agenten und Projekte, die es nutzen, verlieren ihre KI, bis ein anderes Profil zugewiesen ist.`, confirmLabel: 'Löschen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/ai/profiles/${p.id}`); await invalidateAi(); }); })}>Löschen</button></td></tr>)}
      </tbody></table>}
      <div className="row small"><span className="muted">Tagesbudget je Agent (Läufe):</span><input type="number" min={0} max={1000} value={budget ?? st.agentDailyBudget} onChange={(e) => setBudget(Number(e.target.value))} style={{ width: 90 }} /><button className="btn sm" disabled={busy || budget == null} onClick={() => void run(async () => { await api.put('/ai/settings', { agentDailyBudget: budget }); setBudget(null); await invalidateAi(); setMsg('Budget gespeichert.'); })}>Speichern</button></div>
      <PlAgentPolicy st={st} onSaved={async () => { await invalidateAi(); setMsg('Regel für eigene Agenten gespeichert.'); }} />
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
              <span className="muted small">Für Modelle mit Thinking (z. B. Qwen): schneller, weniger Token, keine abgeschnittenen Antworten. Sendet <code>chat_template_kwargs.enable_thinking = false</code> (vLLM, llama.cpp).</span>
            </div>}
            <ScopeEditor scope={f.projectScope} projectIds={f.projectIds} onChange={(projectScope, projectIds) => setF({ ...f, projectScope, projectIds })} />
            {error && <div className="error full">{error}</div>}
            <div className="full row">
              <button className="btn primary" disabled={busy || !f.name.trim() || (f.provider === 'local' ? !f.baseUrl || !f.model : false)} onClick={() => void run(async () => { const body = { name: f.name, provider: f.provider, baseUrl: f.baseUrl || null, model: f.model || st.models[0], apiKey: f.apiKey || undefined, thinkingOff: f.provider === 'local' && f.thinkingOff, projectScope: f.projectScope, projectIds: f.projectIds }; if (edit === 'new') await api.post('/ai/profiles', body); else await api.patch(`/ai/profiles/${edit.id}`, body); setEdit(null); await invalidateAi(); })}>{edit === 'new' ? 'Anlegen' : 'Speichern'}</button>
              {edit !== 'new' && <button className="btn" disabled={busy} onClick={() => void run(async () => { await api.patch(`/ai/profiles/${edit.id}`, { active: !edit.active }); setEdit(null); await invalidateAi(); })}>{edit.active ? 'Deaktivieren' : 'Aktivieren'}</button>}
              <button className="btn" onClick={() => setEdit(null)}>Abbrechen</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Eigene Agenten der PL: erlauben, freigegebene KI-Profile, höchstes Tagesbudget je Agent (nie über dem Mandantenwert). */
function PlAgentPolicy({ st, onSaved }: { st: NonNullable<ReturnType<typeof useAiStatus>>; onSaved: () => Promise<void> }) {
  const cur = { enabled: st.plAgents?.enabled ?? false, maxBudget: st.plAgents?.maxBudget ?? 20, ownLlm: st.ownLlm ?? 'personal' };
  const [f, setF] = useState<typeof cur | null>(null);
  const v = f ?? cur;
  const { busy, error, run } = useAsync();
  return (
    <div className="mt" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
      <label className="field"><span>Eigenes LLM in Projekten einbinden (durch die PL)</span><select value={v.ownLlm} onChange={(e) => setF({ ...v, ownLlm: e.target.value as any })} style={{ width: 'auto' }}><option value="off">nicht erlaubt</option><option value="personal">nur in persönlichen Projekten</option><option value="all">in allen Projekten</option></select></label>
      <label className="check mt"><input type="checkbox" checked={v.enabled} onChange={(e) => setF({ ...v, enabled: e.target.checked })} /> PL dürfen eigene Agenten für ihr Projekt anlegen</label>
      {v.enabled && <div className="small mt">
        <div className="row"><span className="muted">Höchstes Tagesbudget je Agent:</span><input type="number" min={0} max={st.agentDailyBudget} value={v.maxBudget} onChange={(e) => setF({ ...v, maxBudget: Number(e.target.value) })} style={{ width: 90 }} /><span className="muted">(Mandant: {st.agentDailyBudget})</span></div>
        <p className="muted">Eigene Agenten laufen auf den im Projekt verfügbaren LLMs (Freigabe je Profil oben, eigenes LLM des Projekts). Sie gehören zum Projekt: nur dort einsetzbar, Chat nur für Mitglieder. Du siehst sie unten und kannst sie deaktivieren, aber nicht ihre Inhalte oder Läufe.</p>
      </div>}
      {error && <div className="error small">{error}</div>}
      <button className="btn sm mt" disabled={busy || !f} onClick={() => void run(async () => { await api.put('/ai/settings', { plAgents: { enabled: v.enabled, maxBudget: v.maxBudget }, ownLlm: v.ownLlm }); setF(null); await onSaved(); })}>Speichern</button>
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
