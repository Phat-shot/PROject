import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, fmtDate } from '../../lib/api';
import { Modal, roleLabel, useAsync, useDialog } from '../../components/ui';
import { MilestonesTable, SubprojectsTable } from './planForms';
import { InviteCard } from './InviteCard';
import { AccountForm } from '../MailAccountsPage';
import { TrashCard } from './TrashCard';
import { ContactsCard } from './ContactsCard';
import { HealthDialog } from '../PortfolioPage';
import { PromptModal } from '../../components/ui';
import { InlineText } from './TaskDrawer';
import { LABEL_COLORS } from '@projekttool/shared';
import { useProject, type MemberRow } from '../ProjectPage';
import { useData } from '../../lib/useData';
import { useAuth } from '../../lib/auth';
import { FilterEditor, NewView, RightsEditor, type ViewRow } from './MailView';
import type { DocPage, DocTemplate, ReportingPolicy } from '@projekttool/shared';

export function MembersView() {
  const { detail, users, reload, tasks, reloadTasks } = useProject();
  const { timeTracking } = useAuth();
  const me = detail.project.myMembership;
  const [edit, setEdit] = useState<MemberRow | null>(null);
  const [invite, setInvite] = useState(false);
  const [columns, setColumns] = useState(false);
  const [health, setHealth] = useState(false);
  const [asTemplate, setAsTemplate] = useState(false);
  const [tplMsg, setTplMsg] = useState<string | null>(null);
  const { error, run } = useAsync();
  const dialog = useDialog();
  const nav = useNavigate();
  const isPl = me.role === 'pl';
  return (
    <div className="content settings">
      <nav className="section-nav">
        {[['allgemein', 'Allgemein'], ['mitglieder', 'Mitglieder'], ['kontakte', 'Kontakte'], ['planung', 'Planung'], ['board', 'Board'], ['projekt', 'Projekt'], ['eskalation', 'Eskalation'], ['reporting', 'Reporting'], ['mail', 'Mail-Ansichten'], ['papierkorb', 'Papierkorb']].map(([id, l]) => <a key={id} href={`#${id}`}>{l}</a>)}
        <Link to={`/projekte/${detail.project.id}/audit`}>Audit-Log</Link>
      </nav>
      <div className="card mb" id="allgemein">
        <h2>Allgemein</h2>
        <GeneralForm />
      </div>
      <div className="grid cols-2">
        <div className="stack">
          <div className="card" id="mitglieder">
            <div className="row between mb"><h2 style={{ margin: 0 }}>Mitglieder</h2>{isPl && <button className="btn primary sm" onClick={() => setInvite(true)}>Hinzufügen</button>}</div>
            {error && <div className="error mb">{error}</div>}
            <table className="table"><thead><tr><th>Name</th><th>Projektrolle</th><th>Einzelrechte</th><th /></tr></thead><tbody>
              {detail.members.map((m) => (
                <tr key={m.userId}>
                  <td>{m.name}<div className="muted small">{m.email}</div></td>
                  <td><span className={`badge ${m.role}`}>{roleLabel[m.role]}{m.role === 'pl' && (m.isDeputy ? ' (Stellvertretung)' : ' (verantwortlich)')}</span></td>
                  <td className="small muted">{m.role === 'pl' ? 'alle' : [m.canEditPlan && 'Projektplan ändern', m.canApprove && 'KI-Vorschläge freigeben', m.canFinalize && 'Final setzen / Versand', m.canUseAi && 'KI nutzen'].filter(Boolean).join(', ') || '–'}</td>
                  <td className="nowrap">{isPl && <><button className="btn sm link" onClick={() => setEdit(m)}>Rolle</button>{!(m.role === 'pl' && !m.isDeputy) && <button className="btn sm link" onClick={() => void dialog.confirm({ title: 'Mitglied entfernen', text: `${m.name} aus dem Projekt entfernen? Der Zugriff endet sofort, die Historie bleibt.`, confirmLabel: 'Entfernen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/projects/${detail.project.id}/members/${m.userId}`); await reload(); }); })}>Entfernen</button>}</>}</td>
                </tr>
              ))}
            </tbody></table>
            {isPl && <InviteCard />}
          </div>
          <div className="card" id="kontakte">
            <h2>Kontakte und Stakeholder</h2>
            <ContactsCard />
          </div>
          <div className="card" id="planung">
            <h2>Teilprojekte</h2>
            <p className="muted small">Verantwortung wird vom PL geerbt, solange keine Person gesetzt ist. Sichtbarkeit und Zugriff über „Sichtbarkeit“.</p>
            <SubprojectsTable />
            <h2 className="mt">Meilensteine</h2>
            <MilestonesTable />
          </div>
          <div className="card" id="board">
            <div className="row between mb"><h2 style={{ margin: 0 }}>Board</h2>{isPl && <button className="btn sm" onClick={() => setColumns(true)}>Spalten bearbeiten</button>}</div>
            <div className="row mb" style={{ gap: 6 }}>{detail.columns.map((c) => <span key={c.id} className="badge" title={c.kind}>{c.name}{c.wipLimit != null ? ` · WIP ${c.wipLimit}` : ''}</span>)}</div>
            <h3>Labels</h3>
            <LabelsCard />
          </div>
        </div>
        <div className="stack">
          <div className="card" id="projekt">
            <h2>Projekt</h2>
            <dl className="kv">
              <dt>Kürzel</dt><dd>{detail.project.key}</dd>
              <dt>Projekt-Mailadresse</dt><dd>{detail.project.mailAddress ?? <span className="muted">kein Projektkonto angebunden{isPl && <> · <Link to="/einstellungen/konfiguration">Konto anbinden</Link></>}</span>}{detail.project.mailAddress && <span className="muted small"> (aus dem Projektkonto)</span>}</dd>
              <dt>Status</dt><dd>{detail.project.status === 'active' ? 'aktiv' : 'archiviert'}</dd>
              <dt>Ampel</dt><dd><span className="row"><span className={`ampel small ${detail.project.health?.color ?? 'none'}`} />{detail.project.health?.color ? `${{ green: 'grün', yellow: 'gelb', red: 'rot' }[detail.project.health.color]}${detail.project.health.note ? ` · ${detail.project.health.note}` : ''}` : 'automatisch'}{isPl && <button className="btn sm link" onClick={() => setHealth(true)}>ändern</button>}</span></dd>
              {timeTracking && <><dt>Zeiterfassung</dt><dd>{isPl ? <label className="check"><input type="checkbox" checked={detail.project.timeTrackingEnabled} onChange={(e) => void run(async () => { await api.patch(`/projects/${detail.project.id}`, { timeTrackingEnabled: e.target.checked }); await reload(); })} /> aktiv (optionales Modul)</label> : detail.project.timeTrackingEnabled ? 'aktiv' : 'aus'}</dd>
              {(detail.project.timeTrackingEnabled || detail.project.budgetHours) && <><dt>Budget (Stunden)</dt><dd>{isPl ? <BudgetInput /> : detail.project.budgetHours ?? '–'}</dd></>}</>}
              {!timeTracking && <><dt>Zeiterfassung</dt><dd className="muted">mandantenweit deaktiviert (Verwaltung)</dd></>}
            </dl>
            {isPl && detail.project.status === 'active' && <div className="row mt">
              <button className="btn sm" title="Spalten, Labels, Teilprojekte, Meilensteine, Ordner und Regeln als Vorlage für neue Projekte" onClick={() => setAsTemplate(true)}>Als Vorlage speichern</button>
              {tplMsg && <span className="muted small">{tplMsg}</span>}
              <button className="btn sm danger" onClick={() => void dialog.confirm({ title: 'Projekt archivieren', text: 'Das Projekt wird nur noch lesend angezeigt, Mail-Ansichten werden getrennt, Eskalation und Reporting stoppen.', confirmLabel: 'Archivieren', danger: true }).then((ok) => { if (ok) void run(async () => { await api.post(`/projects/${detail.project.id}/archive`); await reload(); nav('/projekte'); }); })}>Archivieren</button>
            </div>}
          </div>
          <div className="card" id="eskalation">
            <h2>Eskalationsregeln</h2>
            <EscalationForm />
            <h3 className="mt">Erinnerungen an Externe</h3>
            <ReminderForm />
          </div>
          <div className="card" id="reporting">
            <h2>Reporting</h2>
            <ReportingForm />
          </div>
          <div className="card" id="mail">
            <h2>Mail-Ansichten und Filter</h2>
            <MailViewsCard />
          </div>
          <div className="card" id="papierkorb">
            <h2>Papierkorb</h2>
            <TrashCard />
          </div>
        </div>
      </div>
      {edit && <RoleForm member={edit} onClose={() => setEdit(null)} />}
      {invite && <RoleForm onClose={() => setInvite(false)} />}
      {columns && <ColumnsForm onClose={() => setColumns(false)} />}
      {health && <HealthDialog row={{ id: detail.project.id, name: detail.project.name, computed: 'green', health: detail.project.health ?? { color: null, note: null, updatedAt: null, updatedBy: null } }} onClose={() => setHealth(false)} onSaved={async () => { setHealth(false); await reload(); }} />}
      {asTemplate && <PromptModal title="Als Projektvorlage speichern" label="Name der Vorlage" value={`${detail.project.name} (Vorlage)`} hint="Übernommen werden Spalten, Labels, Teilprojekte und Meilensteine (relativ zum frühesten Termin), Doku-Ordner, Eskalations- und Erinnerungsregeln." submitLabel="Speichern" onClose={() => setAsTemplate(false)} onSubmit={(name) => { if (name) void run(async () => { await api.post(`/project-templates/from-project/${detail.project.id}`, { name }); setTplMsg(`Vorlage „${name}“ gespeichert.`); }); }} />}
    </div>
  );

  function RoleForm({ member, onClose }: { member?: MemberRow; onClose: () => void }) {
    const candidates = users.filter((u) => !detail.members.some((m) => m.userId === u.id));
    const [f, setF] = useState({ userId: member?.userId ?? candidates[0]?.id ?? '', role: member?.role ?? 'member', isDeputy: member?.isDeputy ?? true, canEditPlan: member?.canEditPlan ?? false, canApprove: member?.canApprove ?? false, canFinalize: member?.canFinalize ?? false, canUseAi: member?.canUseAi ?? true });
    const { busy, error, run } = useAsync();
    return (
      <Modal title={member ? `Rolle: ${member.name}` : 'Mitglied hinzufügen'} onClose={onClose}>
        <div className="form">
          {!member && <label className="field"><span>Benutzer des Mandanten</span><select value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}>{candidates.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}</select></label>}
          <label className="field"><span>Projektrolle</span><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as any })}><option value="pl">PL</option><option value="member">Mitglied</option><option value="reader">Leser</option></select></label>
          {f.role === 'pl' && <label className="check"><input type="checkbox" checked={f.isDeputy} onChange={(e) => setF({ ...f, isDeputy: e.target.checked })} /> Stellvertretung (zweiter PL). Ohne Haken wird diese Person verantwortlicher PL, der bisherige wird Stellvertretung.</label>}
          {f.role === 'member' && <>
            <strong className="small">Zusätzliche Rechte</strong>
            <label className="check"><input type="checkbox" checked={f.canEditPlan} onChange={(e) => setF({ ...f, canEditPlan: e.target.checked })} /> Projektplan, Meilensteine ändern</label>
            <label className="check"><input type="checkbox" checked={f.canApprove} onChange={(e) => setF({ ...f, canApprove: e.target.checked })} /> KI-Vorschläge freigeben</label>
            <label className="check"><input type="checkbox" checked={f.canFinalize} onChange={(e) => setF({ ...f, canFinalize: e.target.checked })} /> Dokument final setzen, Versand auslösen</label>
            <label className="check"><input type="checkbox" checked={f.canUseAi} onChange={(e) => setF({ ...f, canUseAi: e.target.checked })} /> KI nutzen</label>
          </>}
          {f.role === 'reader' && <label className="check"><input type="checkbox" checked={f.canUseAi} onChange={(e) => setF({ ...f, canUseAi: e.target.checked })} /> KI nutzen (nur Fragen)</label>}
          {error && <div className="error">{error}</div>}
          <div><button className="btn primary" disabled={busy || !f.userId} onClick={() => void run(async () => {
            const body: Record<string, unknown> = { ...f };
            const primary = detail.members.find((m) => m.role === 'pl' && !m.isDeputy);
            if (f.role === 'pl' && !f.isDeputy && primary && primary.userId !== f.userId) {
              const direct = tasks.filter((x) => !x.done && x.responsibleUserId === primary.userId).length + detail.subprojects.filter((s) => s.responsibleUserId === primary.userId).length;
              if (direct > 0) { const v = await dialog.choose({ title: 'Direkt zugewiesene Arbeitspakete', text: `${direct} Arbeitspaket(e)/Teilprojekt(e) sind ${primary.name} direkt  zugewiesen. Auch an die neue Projektleitung übertragen? Geerbte Zuständigkeiten wechseln in jedem Fall.`, options: [{ label: 'Mit übertragen', value: true, primary: true }, { label: 'Nur geerbte wechseln', value: false }] }); if (v === null) return; body.transferTasks = v; }
            }
            await api.put(`/projects/${detail.project.id}/members/${f.userId}`, body); await reload(); await reloadTasks(); onClose(); })}>Speichern</button></div>
        </div>
      </Modal>
    );
  }

  function ColumnsForm({ onClose }: { onClose: () => void }) {
    const { reloadTasks } = useProject();
    const [cols, setCols] = useState(detail.columns.map((c) => ({ id: c.id as string | undefined, name: c.name, isDone: c.isDone, kind: c.kind, wipLimit: c.wipLimit })));
    const KIND: Record<string, string> = { backlog: 'Geplant (noch nicht aktiv)', active: 'In Bearbeitung', parked: 'Zurückgestellt (ruht)', done: 'Erledigt' };
    const { busy, error, run } = useAsync();
    return (
      <Modal title="Board-Spalten" onClose={onClose}>
        <div className="stack">
          {cols.map((c, i) => <div key={i} className="row"><input type="text" value={c.name} onChange={(e) => setCols(cols.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} style={{ flex: 1 }} /><select value={c.kind} onChange={(e) => setCols(cols.map((x, j) => (j === i ? { ...x, kind: e.target.value as any, isDone: e.target.value === 'done' } : x)))} style={{ width: 'auto' }}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select><label className="small nowrap">WIP <input type="number" min={0} value={c.wipLimit ?? ''} placeholder="–" onChange={(e) => setCols(cols.map((x, j) => (j === i ? { ...x, wipLimit: e.target.value ? Number(e.target.value) : null } : x)))} style={{ width: 56 }} /></label><button className="btn sm link" onClick={() => setCols(cols.filter((_, j) => j !== i))}>✕</button></div>)}
          <button className="btn sm" onClick={() => setCols([...cols, { id: undefined, name: 'Neue Spalte', isDone: false, kind: 'active' as const, wipLimit: null }])}>+ Spalte</button>
          <p className="muted small">Spaltenart: „Geplant“ und „Zurückgestellt“ zählen nicht als Stillstand für die Eskalation. WIP-Limit färbt die Spalte rot, wenn mehr Arbeitspakete darin liegen.</p>
          {error && <div className="error">{error}</div>}
          <div><button className="btn primary" disabled={busy} onClick={() => void run(async () => { await api.put(`/projects/${detail.project.id}/columns`, { columns: cols }); await reload(); await reloadTasks(); onClose(); })}>Speichern</button></div>
        </div>
      </Modal>
    );
  }
}

function GeneralForm() {
  const { detail, reload } = useProject();
  const p = detail.project;
  const isPl = p.myMembership.role === 'pl';
  const [f, setF] = useState({ name: p.name, description: p.description ?? '', visibility: p.visibility });
  const { busy, error, run } = useAsync();
  const dirty = f.name !== p.name || f.description !== (p.description ?? '') || f.visibility !== p.visibility;
  if (!isPl) {
    return <dl className="kv"><dt>Name</dt><dd>{p.name}</dd><dt>Beschreibung</dt><dd>{p.description || '–'}</dd><dt>Sichtbarkeit</dt><dd>{p.visibility === 'org' ? 'alle Benutzer des Mandanten (lesend)' : 'nur Mitglieder'}</dd></dl>;
  }
  return (
    <div className="form">
      <div className="grid cols-2">
        <label className="field"><span>Name</span><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="field"><span>Sichtbarkeit</span>
          <select value={f.visibility} onChange={(e) => setF({ ...f, visibility: e.target.value as 'members' | 'org' })}>
            <option value="members">nur Mitglieder</option>
            <option value="org">alle Benutzer des Mandanten (lesend)</option>
          </select>
        </label>
      </div>
      <label className="field"><span>Beschreibung</span><textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      <p className="muted small">Sichtbarkeit „alle Benutzer“: Nicht-Mitglieder sehen Übersicht, Board, Plan und Doku lesend. Mail-Ansichten bleiben rechtegebunden, schreiben darf weiterhin nur, wer Mitglied ist.</p>
      {error && <div className="error">{error}</div>}
      <div><button className="btn primary sm" disabled={busy || !dirty || !f.name.trim()} onClick={() => void run(async () => { await api.patch(`/projects/${p.id}`, { name: f.name, description: f.description, visibility: f.visibility }); await reload(); })}>Speichern</button></div>
    </div>
  );
}

function ReminderForm() {
  const { detail, reload } = useProject();
  const me = detail.project.myMembership;
  const p = detail.project.reminders!;
  const [f, setF] = useState({ enabled: p.enabled, daysBefore: p.daysBefore.join(', '), overdueEveryDays: p.overdueEveryDays ?? '', includeInternal: p.includeInternal });
  const { busy, error, run } = useAsync();
  if (me.role !== 'pl') return <p className="small muted">{p.enabled ? `Externe Zuständige werden ${p.daysBefore.map((d) => d === 0 ? 'am Fälligkeitstag' : `${d} Tage vorher`).join(', ')}${p.overdueEveryDays ? ` und bei Verzug alle ${p.overdueEveryDays} Tage` : ''} per Mail erinnert.` : 'Keine automatischen Erinnerungen.'}</p>;
  return (
    <div className="form">
      <p className="muted small">Mail über das Projektkonto an externe Zuständige (Arbeitspaket mit Mail-Adresse); die Antwort landet über die Antwortadresse im Arbeitspaket. Je Arbeitspaket und Tag höchstens eine Mail.{!detail.project.mailAddress && <span style={{ color: 'var(--warn)' }}> Ohne Projektkonto wird nichts verschickt.</span>}</p>
      <label className="check"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Erinnerungen aktiv</label>
      <div className="row small"><span>Tage vor Fälligkeit</span><input type="text" value={f.daysBefore} onChange={(e) => setF({ ...f, daysBefore: e.target.value })} placeholder="3, 0" style={{ width: 90 }} /><span>(0 = am Tag selbst)</span></div>
      <div className="row small"><span>Bei Verzug alle</span><input type="number" min={1} max={30} value={f.overdueEveryDays} onChange={(e) => setF({ ...f, overdueEveryDays: e.target.value })} placeholder="–" style={{ width: 60 }} /><span>Tage (leer = nicht)</span></div>
      <label className="check"><input type="checkbox" checked={f.includeInternal} onChange={(e) => setF({ ...f, includeInternal: e.target.checked })} /> auch interne Zuständige per Mail erinnern</label>
      {error && <div className="error">{error}</div>}
      <div><button className="btn primary sm" disabled={busy} onClick={() => void run(async () => { await api.patch(`/projects/${detail.project.id}`, { reminders: { enabled: f.enabled, daysBefore: f.daysBefore.split(/[,;\s]+/).filter(Boolean).map(Number), overdueEveryDays: f.overdueEveryDays === '' ? null : Number(f.overdueEveryDays), includeInternal: f.includeInternal } }); await reload(); })}>Speichern</button></div>
    </div>
  );
}

function EscalationForm() {
  const { detail, users, reload } = useProject();
  const me = detail.project.myMembership;
  const p = detail.project.escalation!;
  const [f, setF] = useState({ enabled: p.enabled, d1: p.stageDays[0], d2: p.stageDays[1], d3: p.stageDays[2], staleDays: p.staleDays, contactUserId: p.contactUserId ?? '', contactEmail: p.contactEmail ?? '', externalMode: p.externalMode });
  const { busy, error, run } = useAsync();
  const members = users.filter((u) => u.active);
  if (me.role !== 'pl') {
    return <p className="small muted">Stufe 1 nach {p.stageDays[0]} Tagen Verzug oder {p.staleDays} Tagen Stillstand (Teilprojekt-Verantwortung), Stufe 2 nach {p.stageDays[1]} Tagen (PL), Stufe 3 nach {p.stageDays[2]} Tagen ({members.find((u) => u.id === p.contactUserId)?.name ?? p.contactEmail ?? 'kein Kontakt'}). Hohe Kritikalität halbiert die Fristen.</p>;
  }
  return (
    <div className="form">
      <p className="muted small">Verzug, Stillstand und Blockaden eskalieren entlang Zuständig → Teilprojekt-Verantwortung → PL → Eskalationskontakt. Hohe Kritikalität halbiert die Fristen.</p>
      <label className="check"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Eskalation aktiv</label>
      <div className="row small">
        <span>Stufe 1 nach</span><input type="number" min={0} value={f.d1} onChange={(e) => setF({ ...f, d1: Number(e.target.value) })} style={{ width: 60 }} />
        <span>Stufe 2 nach</span><input type="number" min={0} value={f.d2} onChange={(e) => setF({ ...f, d2: Number(e.target.value) })} style={{ width: 60 }} />
        <span>Stufe 3 nach</span><input type="number" min={0} value={f.d3} onChange={(e) => setF({ ...f, d3: Number(e.target.value) })} style={{ width: 60 }} /><span>Tagen Verzug</span>
      </div>
      <div className="row small"><span>„Hängt“ ab</span><input type="number" min={1} value={f.staleDays} onChange={(e) => setF({ ...f, staleDays: Number(e.target.value) })} style={{ width: 60 }} /><span>Tagen ohne Aktivität in einer aktiven Spalte</span></div>
      <label className="field"><span>Eskalationskontakt intern (z. B. Vorgesetzte/r, Auftraggeber im Haus)</span><select value={f.contactUserId} onChange={(e) => setF({ ...f, contactUserId: e.target.value })}><option value="">– keiner –</option>{members.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
      <label className="field"><span>Eskalationskontakt extern (Mail über Projektkonto)</span><input type="email" value={f.contactEmail} onChange={(e) => setF({ ...f, contactEmail: e.target.value })} placeholder="gf@kunde.de" /></label>
      {f.contactEmail && <label className="field"><span>Externe Eskalationsmail</span><select value={f.externalMode} onChange={(e) => setF({ ...f, externalMode: e.target.value as any })}><option value="proposal">als Entwurf zur Freigabe durch PL</option><option value="direct">direkt senden</option></select></label>}
      {error && <div className="error">{error}</div>}
      <div><button className="btn primary sm" disabled={busy} onClick={() => void run(async () => { await api.patch(`/projects/${detail.project.id}`, { escalation: { enabled: f.enabled, stageDays: [f.d1, f.d2, f.d3], staleDays: f.staleDays, contactUserId: f.contactUserId || null, contactEmail: f.contactEmail || null, externalMode: f.externalMode } }); await reload(); })}>Speichern</button></div>
    </div>
  );
}

function MailViewsCard() {
  const { detail, reload } = useProject();
  const [account, setAccount] = useState(false);
  const isPl = detail.project.myMembership.role === 'pl';
  const views = useData<{ views: ViewRow[] }>(`/projects/${detail.project.id}/mail/views`);
  const [newView, setNewView] = useState(false);
  const [rightsFor, setRightsFor] = useState<ViewRow | null>(null);
  const [filterFor, setFilterFor] = useState<ViewRow | null>(null);
  const f = (v: ViewRow) => { const x = v.filter; return [x.folders?.length && `Ordner ${x.folders.join(', ')}`, x.from?.length && `Von ${x.from.join(', ')}`, x.to?.length && `An ${x.to.join(', ')}`, x.subject?.length && `Betreff ${x.subject.join(', ')}`, x.keyword?.length && `Stichwort ${x.keyword.join(', ')}`, x.since && `ab ${x.since}`].filter(Boolean).join(' · ') || 'alle Mails des Kontos'; };
  return (
    <div>
      <p className="muted small">Eine Ansicht ist ein Filter auf ein Konto. Nur Treffer werden gespeichert. Rechte (Lesen, Entwurf, Senden, Arbeitspaket erzeugen) hängen an der Ansicht: je Person, Rolle oder Gruppe.</p>
      {views.data && views.data.views.length === 0 && <div className="empty">Noch keine Ansicht. Ohne Ansicht werden keine Mails geladen.</div>}
      {views.data && views.data.views.length > 0 && <table className="table"><thead><tr><th>Ansicht</th><th>Konto</th><th>Filter</th><th /></tr></thead><tbody>
        {views.data.views.map((v) => <tr key={v.id}><td>{v.name}</td><td className="small">{v.accountAddress}<div className="muted">{v.accountType === 'personal' ? 'persönlich' : v.accountType === 'org' ? 'Organisation' : 'Projektkonto'}</div></td><td className="small muted">{f(v)}</td>
          <td className="nowrap">{v.canManage && <><button className="btn sm link" onClick={() => setFilterFor(v)}>Filter</button><button className="btn sm link" onClick={() => setRightsFor(v)}>Rechte</button></>}</td></tr>)}
      </tbody></table>}
      {!detail.project.mailAddress && <p className="notice small">Kein Projektkonto: Nachfragen, Erinnerungen, PDF-Versand und Reporting brauchen eines.{isPl && <> <button className="btn sm primary" style={{ marginLeft: 6 }} onClick={() => setAccount(true)}>Projektkonto anbinden</button></>}</p>}
      <div className="row mt"><button className="btn sm" onClick={() => setNewView(true)}>+ Ansicht</button><Link className="btn sm link" to="/einstellungen/konfiguration">Konten verwalten</Link></div>
      {account && <AccountForm projects={[detail.project]} fixedProject={detail.project} onClose={() => setAccount(false)} onSaved={async () => { setAccount(false); await reload(); await views.reload(); }} />}
      {newView && <NewView onClose={() => setNewView(false)} onCreated={() => { setNewView(false); void views.reload(); }} />}
      {rightsFor && <RightsEditor view={rightsFor} onClose={() => setRightsFor(null)} onChanged={() => void views.reload()} />}
      {filterFor && <FilterEditor view={filterFor} onClose={() => setFilterFor(null)} onSaved={() => { setFilterFor(null); void views.reload(); }} />}
    </div>
  );
}

const WEEKDAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

function ReportingForm() {
  const { detail, reload } = useProject();
  const me = detail.project.myMembership;
  const p = detail.project.reporting!;
  const [f, setF] = useState({ ...p, recipientsText: p.recipients.join(', ') });
  const templates = useData<{ templates: DocTemplate[] }>('/docs/templates');
  const docs = useData<{ pages: DocPage[] }>(`/projects/${detail.project.id}/docs`);
  const { busy, error, run } = useAsync();
  const [last, setLast] = useState<string | null>(null);
  const tops = (docs.data?.pages ?? []).filter((x) => !x.parentPageId).sort((a, b) => a.title.localeCompare(b.title));
  const rhythm = p.interval === 'monthly' ? `monatlich am ${p.dayOfMonth}.` : `${p.interval === 'weekly' ? 'wöchentlich' : 'alle zwei Wochen'} am ${WEEKDAYS[p.weekday - 1]}`;
  const tplName = templates.data?.templates.find((t) => t.key === p.templateKey)?.name ?? p.templateKey;
  if (me.role !== 'pl') {
    return <p className="small muted">{p.enabled ? `„${tplName}“ ${rhythm} an ${p.recipients.join(', ') || 'niemanden'} (${p.mode === 'direct' ? 'direkt als PDF' : 'nach Prüfung durch PL'}).` : 'Kein automatisches Reporting.'}{p.lastRunOn && <> Zuletzt: {fmtDate(p.lastRunOn)}{p.lastPageId && <> · <Link to={`/projekte/${detail.project.id}/doku/${p.lastPageId}`}>Bericht</Link></>}.</>}</p>;
  }
  const save = (): Partial<ReportingPolicy> => ({ enabled: f.enabled, templateKey: f.templateKey, interval: f.interval, weekday: Number(f.weekday), dayOfMonth: Number(f.dayOfMonth), recipients: f.recipientsText.split(/[,;\s]+/).filter(Boolean), mode: f.mode, parentPageId: f.parentPageId || null });
  return (
    <div className="form">
      <p className="muted small">Im Rhythmus entsteht eine Seite aus der Vorlage mit Kennzahlen (Fortschritt, Verzug, Blockaden, Eskalationen, Meilensteine) und geht als PDF über das Projektkonto an den Empfängerkreis.</p>
      <label className="check"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Reporting aktiv</label>
      <div className="grid cols-2">
        <label className="field"><span>Vorlage</span><select value={f.templateKey} onChange={(e) => setF({ ...f, templateKey: e.target.value })}>{(templates.data?.templates ?? []).map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</select></label>
        <label className="field"><span>Ablage unter Oberseite</span><select value={f.parentPageId ?? ''} onChange={(e) => setF({ ...f, parentPageId: e.target.value })}><option value="">– Ordner „Berichte“ –</option>{tops.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select></label>
        <label className="field"><span>Rhythmus</span><select value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value as ReportingPolicy['interval'] })}><option value="weekly">wöchentlich</option><option value="biweekly">alle zwei Wochen</option><option value="monthly">monatlich</option></select></label>
        {f.interval === 'monthly'
          ? <label className="field"><span>Tag im Monat</span><input type="number" min={1} max={28} value={f.dayOfMonth} onChange={(e) => setF({ ...f, dayOfMonth: Number(e.target.value) })} /></label>
          : <label className="field"><span>Wochentag</span><select value={f.weekday} onChange={(e) => setF({ ...f, weekday: Number(e.target.value) })}>{WEEKDAYS.map((w, i) => <option key={w} value={i + 1}>{w}</option>)}</select></label>}
      </div>
      <label className="field"><span>Empfängerkreis (Mail-Adressen, durch Komma getrennt)</span><input type="text" value={f.recipientsText} onChange={(e) => setF({ ...f, recipientsText: e.target.value })} placeholder="gf@kunde.de, lenkungskreis@firma.de" /></label>
      <label className="field"><span>Versand</span><select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value as ReportingPolicy['mode'] })}><option value="proposal">als Entwurf, PL prüft und versendet</option><option value="direct">direkt final setzen und als PDF senden</option></select></label>
      {!detail.project.mailAddress && <p className="small" style={{ color: 'var(--warn)' }}>Kein Projektkonto angebunden, Versand ist erst danach möglich.</p>}
      {error && <div className="error">{error}</div>}
      {last && <div className="muted small">{last}</div>}
      <div className="row">
        <button className="btn primary sm" disabled={busy} onClick={() => void run(async () => { await api.patch(`/projects/${detail.project.id}`, { reporting: save() }); await reload(); setLast('Gespeichert.'); })}>Speichern</button>
        <button className="btn sm" disabled={busy} onClick={() => void run(async () => { await api.patch(`/projects/${detail.project.id}`, { reporting: save() }); const r = await api.post<{ result: { pageId: string; title: string; sent: boolean; to: string[]; error?: string } }>(`/projects/${detail.project.id}/reporting/run`); await reload(); setLast(r.result.sent ? `„${r.result.title}“ versendet an ${r.result.to.join(', ')}.` : `„${r.result.title}“ angelegt${r.result.error ? `, nicht versendet: ${r.result.error}` : ' (Entwurf zur Prüfung)'}.`); })}>Jetzt erzeugen</button>
        {p.lastRunOn && <span className="muted small">Zuletzt {fmtDate(p.lastRunOn)}{p.lastPageId && <> · <Link to={`/projekte/${detail.project.id}/doku/${p.lastPageId}`}>Bericht öffnen</Link></>}</span>}
      </div>
    </div>
  );
}

function LabelsCard() {
  const { detail, reload } = useProject();
  const isPl = detail.project.myMembership.role === 'pl';
  const dialog = useDialog();
  const { error, run } = useAsync();
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>('blue');
  const pid = detail.project.id;
  if (!isPl) return <div className="row" style={{ gap: 4 }}>{detail.labels.map((l) => <span key={l.id} className={`lbl full ${l.color}`}>{l.name}</span>)}{detail.labels.length === 0 && <span className="muted small">Keine Labels.</span>}</div>;
  return (
    <div className="stack">
      {error && <div className="error">{error}</div>}
      {detail.labels.map((l) => (
        <div key={l.id} className="row">
          <span className={`lbl full ${l.color}`} style={{ minWidth: 60, textAlign: 'center' }}>{l.name}</span>
          <InlineText value={l.name} canEdit onSave={(v) => run(async () => { await api.patch(`/projects/${pid}/labels/${l.id}`, { name: v }); await reload(); })} />
          <select className="inline-select" value={l.color} onChange={(e) => void run(async () => { await api.patch(`/projects/${pid}/labels/${l.id}`, { color: e.target.value }); await reload(); })}>{LABEL_COLORS.map((c) => <option key={c} value={c}>{c}</option>)}</select>
          <button className="btn sm link" title="Label löschen" onClick={() => void dialog.confirm({ title: 'Label löschen', text: `„${l.name}“ wird von allen Arbeitspaketen entfernt.`, confirmLabel: 'Löschen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/projects/${pid}/labels/${l.id}`); await reload(); }); })}>✕</button>
        </div>
      ))}
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return; void run(async () => { await api.post(`/projects/${pid}/labels`, { name: name.trim(), color }); setName(''); await reload(); }); }}>
        <input type="text" placeholder="Neues Label" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 160 }} />
        <select value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 'auto' }}>{LABEL_COLORS.map((c) => <option key={c} value={c}>{c}</option>)}</select>
        <button className="btn sm" disabled={!name.trim()}>Anlegen</button>
      </form>
    </div>
  );
}

function BudgetInput() {
  const { detail, reload } = useProject();
  const [v, setV] = useState(detail.project.budgetHours?.toString() ?? '');
  return <span className="row"><input type="number" min={0} value={v} onChange={(e) => setV(e.target.value)} style={{ width: 100 }} /><button className="btn sm" onClick={() => void api.patch(`/projects/${detail.project.id}`, { budgetHours: v ? Number(v) : null }).then(reload)}>Speichern</button></span>;
}

