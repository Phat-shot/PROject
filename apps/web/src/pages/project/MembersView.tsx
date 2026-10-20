import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, fmtDate } from '../../lib/api';
import { Modal, roleLabel, useAsync, useDialog } from '../../components/ui';
import { MilestonesTable, SubprojectsTable } from './planForms';
import { InviteCard } from './InviteCard';
import { AccountForm, OAuthStartDialog, kindLabel, useLabel } from '../MailAccountsPage';
import { useAiStatus } from '../../lib/useAi';
import { TrashCard } from './TrashCard';
import { ContactsCard } from './ContactsCard';
import { ResourcesTable } from '../../components/Resources';
import { HealthDialog } from '../PortfolioPage';
import { PromptModal } from '../../components/ui';
import { AgentPolicyEditor, EffectivePolicyText, modeLabel } from '../../components/AgentPolicy';
import type { AgentPolicy, EffectiveAgentPolicy } from '@projekttool/shared';
import { AGENT_MODES } from '@projekttool/shared';
import { InlineText } from './TaskDrawer';
import { AI_FEATURES, LABEL_COLORS } from '@projekttool/shared';
import { useProject, type MemberRow } from '../ProjectPage';
import { useData } from '../../lib/useData';
import { useAuth } from '../../lib/auth';
import { FilterEditor, NewView, RightsEditor, type ViewRow } from './MailView';
import { AiFolderDialog } from './MailAi';
import { ProjectNotifyCard } from '../../components/NotifyRules';
import type { AgentUser, AiFeatureDef, DocPage, DocTemplate, Group, MailAccount, ProjectGroup, ReportingPolicy } from '@projekttool/shared';
import { useProjectPolicy } from '../../lib/useProjectPolicy';

export function MembersView() {
  const { detail, reload } = useProject();
  const { timeTracking } = useAuth();
  const me = detail.project.myMembership;
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
        {[['allgemein', 'Allgemein'], ['mitglieder', 'Mitglieder'], ['kontakte', 'Kontakte'], ['planung', 'Planung'], ['board', 'Board'], ['projekt', 'Projekt'], ['ki', 'KI'], ['eskalation', 'Eskalation'], ['kommunikation', 'Kommunikation'], ['reporting', 'Reporting'], ['mail', 'Mail-Ansichten'], ['aussen', 'Außenkommunikation'], ['papierkorb', 'Papierkorb']].map(([id, l]) => <a key={id} href={`#${id}`}>{l}</a>)}
        <Link to={`/projekte/${detail.project.id}/audit`}>Audit-Log</Link>
      </nav>
      <div className="card mb" id="allgemein">
        <h2>Allgemein</h2>
        <GeneralForm />
      </div>
      <div className="grid cols-2">
        <div className="stack">
          <MembersCard />
          <ProjectAiCard />
          <div className="card" id="kontakte">
            <h2>Kontakte und Stakeholder</h2>
            <ContactsCard />
          </div>
          <div className="card" id="ressourcen">
            <h2>Ressourcen des Projekts</h2>
            <p className="muted small">Gerüste, Geräte, Räume oder externe Personen (Elektriker) nur für dieses Projekt; Pool-Ressourcen des Mandanten pflegt die Verwaltung. Buchungen im Kalender (Modus „Belegung“), am Arbeitspaket oder an der Besprechung; Konflikte übersteuern nur PL oder „Projektplan ändern“.</p>
            <ResourcesTable projectId={detail.project.id} canEdit={detail.project.myMembership.role !== 'reader'} canDelete={isPl} />
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
              <dt>KI</dt><dd><a href="#ki">LLM, Agenten, Projektagent, Policy</a></dd>
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
          <div className="card" id="kommunikation">
            <h2>Kommunikation</h2>
            <ProjectNotifyCard projectId={detail.project.id} members={detail.members} />
          </div>
          <div className="card" id="reporting">
            <h2>Reporting</h2>
            <ReportingForm />
          </div>
          <div className="card" id="mail">
            <h2>Mail-Ansichten und Filter</h2>
            <MailViewsCard />
          </div>
          <div className="card" id="aussen">
            <h2>Außenkommunikation</h2>
            <ExternalCard />
          </div>
          <div className="card" id="papierkorb">
            <h2>Papierkorb</h2>
            <TrashCard />
          </div>
        </div>
      </div>
      {columns && <ColumnsForm onClose={() => setColumns(false)} />}
      {health && <HealthDialog row={{ id: detail.project.id, name: detail.project.name, computed: 'green', health: detail.project.health ?? { color: null, note: null, updatedAt: null, updatedBy: null } }} onClose={() => setHealth(false)} onSaved={async () => { setHealth(false); await reload(); }} />}
      {asTemplate && <PromptModal title="Als Projektvorlage speichern" label="Name der Vorlage" value={`${detail.project.name} (Vorlage)`} hint="Übernommen werden Spalten, Labels, Teilprojekte und Meilensteine (relativ zum frühesten Termin), Doku-Ordner, Eskalations- und Erinnerungsregeln." submitLabel="Speichern" onClose={() => setAsTemplate(false)} onSubmit={(name) => { if (name) void run(async () => { await api.post(`/project-templates/from-project/${detail.project.id}`, { name }); setTplMsg(`Vorlage „${name}“ gespeichert.`); }); }} />}
    </div>
  );

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

/** Einzelrechte als Text (PL hat alle). */
const rightsText = (m: { canEditPlan: boolean; canApprove: boolean; canFinalize: boolean; canUseAi: boolean }) =>
  [m.canEditPlan && 'Projektplan ändern', m.canApprove && 'Freigeben', m.canFinalize && 'Final setzen / Versand', m.canUseAi && 'KI nutzen'].filter(Boolean).join(', ') || '–';

/**
 * Mitglieder mit Herkunft (Regel M): ein Direkteintrag überschreibt alle Gruppen, zwischen Gruppen gilt die höchste Rolle,
 * Einzelrechte werden addiert. Darunter die Gruppen im Projekt (nicht in persönlichen Projekten).
 */
export function MembersCard() {
  const { detail, reload } = useProject();
  const me = detail.project.myMembership;
  const isPl = me.role === 'pl';
  // Die verantwortliche PL übergibt ihre Rolle nur selbst; die Stellvertretung ändert deren Mitgliedschaft nicht
  const isPrimary = isPl && !me.isDeputy;
  const [edit, setEdit] = useState<MemberRow | null>(null);
  const [invite, setInvite] = useState(false);
  const [group, setGroup] = useState<ProjectGroup | 'new' | null>(null);
  const { error, run } = useAsync();
  const dialog = useDialog();
  const pid = detail.project.id;
  const policy = useProjectPolicy(detail.project);
  const groups = detail.groups ?? [];
  const groupsOf = (userId: string) => groups.filter((g) => g.memberIds.includes(userId));
  const groupLabel = (g: ProjectGroup) => `${g.name} (${roleLabel[g.role]})`;
  const remove = (m: MemberRow) => {
    const stays = groupsOf(m.userId);
    void dialog.confirm({ title: 'Mitglied entfernen', text: stays.length ? `${m.name} bleibt über ${stays.map(groupLabel).join(', ')} Mitglied; der Direkteintrag entfällt.` : `${m.name} aus dem Projekt entfernen? Der Zugriff endet sofort, die Historie bleibt.`, confirmLabel: 'Entfernen', danger: true })
      .then((ok) => { if (ok) void run(async () => { await api.del(`/projects/${pid}/members/${m.userId}`); await reload(); }); });
  };
  return (
    <div className="card" id="mitglieder">
      <div className="row between mb"><h2 style={{ margin: 0 }}>Mitglieder</h2>{isPl && <span className="row">{policy.members.groups && <button className="btn sm" onClick={() => setGroup('new')}>Gruppe hinzufügen</button>}<button className="btn primary sm" onClick={() => setInvite(true)}>Hinzufügen</button></span>}</div>
      {error && <div className="error mb">{error}</div>}
      <table className="table"><thead><tr><th>Name</th><th>Projektrolle</th><th>Einzelrechte</th><th>Herkunft</th><th /></tr></thead><tbody>
        {detail.members.map((m) => {
          const primaryRow = m.role === 'pl' && !m.isDeputy;
          const via = groupsOf(m.userId);
          return (
            <tr key={m.userId}>
              <td>{m.name}<div className="muted small">{m.email}</div></td>
              <td><span className={`badge ${m.role}`}>{roleLabel[m.role]}{m.role === 'pl' && (m.userId === detail.project.agentUserId ? ' (Projektagent)' : m.isDeputy ? ' (Stellvertretung)' : ' (verantwortlich)')}</span>{m.kind === 'agent' && <span className="badge" style={{ marginLeft: 4 }} title={m.agentCanMail === false ? 'KI-Agent, Mails nur als Entwurf' : 'KI-Agent, darf Mails senden'}>KI-Agent{m.agentCanMail === false ? ' · ohne Mail' : ''}</span>}</td>
              <td className="small muted">{m.role === 'pl' ? 'alle' : rightsText(m)}</td>
              <td className="small">{m.origin === 'group'
                ? <span title="Mitglied über Gruppen des Projekts: höchste Rolle, Einzelrechte addiert">über {via.map((g) => g.name).join(', ') || 'Gruppe'}</span>
                : <>direkt{via.length > 0 && <div className="muted">überschreibt {via.map(groupLabel).join(', ')}{isPl && !primaryRow && <> · <button className="btn sm link" onClick={() => void run(async () => { await api.del(`/projects/${pid}/members/${m.userId}`); await reload(); })}>Gruppenrechte übernehmen</button></>}</div>}</>}</td>
              <td className="nowrap">{isPl && <>{(isPrimary || !primaryRow) && <button className="btn sm link" title={m.origin === 'group' ? 'Als Direkteintrag festlegen (überschreibt die Gruppen)' : undefined} onClick={() => setEdit(m)}>Rolle</button>}{!primaryRow && m.origin !== 'group' && <button className="btn sm link" onClick={() => remove(m)}>Entfernen</button>}</>}</td>
            </tr>
          );
        })}
      </tbody></table>
      {policy.members.notice && <p className="notice small mt">{policy.members.notice}</p>}
      <MyRights />
      {policy.members.groups && (isPl || groups.length > 0) && <>
        <h3 className="mt">Gruppen im Projekt</h3>
        {groups.length === 0
          ? <p className="muted small">Noch keine Gruppen. Eine Gruppe macht ihre Personen zu Mitgliedern oder Lesern (höchste Rolle zählt, Einzelrechte addieren sich); ein Direkteintrag überschreibt die Gruppen. PL und Stellvertretung sind immer einzelne Personen.</p>
          : <table className="table"><thead><tr><th>Gruppe</th><th>Rolle</th><th>Einzelrechte</th><th /></tr></thead><tbody>
            {groups.map((g) => <tr key={g.groupId}>
              <td>{g.name}<div className="muted small">{g.memberIds.length} {g.memberIds.length === 1 ? 'Person' : 'Personen'}</div></td>
              <td><span className={`badge ${g.role}`}>{roleLabel[g.role]}</span></td>
              <td className="small muted">{rightsText(g)}</td>
              <td className="nowrap">{isPl && <><button className="btn sm link" onClick={() => setGroup(g)}>Rechte</button><button className="btn sm link" onClick={() => void dialog.confirm({ title: 'Gruppe entfernen', text: `„${g.name}“ aus dem Projekt entfernen? Personen ohne Direkteintrag und ohne weitere Gruppe verlieren den Zugriff.`, confirmLabel: 'Entfernen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/projects/${pid}/groups/${g.groupId}`); await reload(); }); })}>Entfernen</button></>}</td>
            </tr>)}
          </tbody></table>}
      </>}
      {isPl && policy.members.invitations && <InviteCard />}
      {edit && <RoleForm member={edit} onClose={() => setEdit(null)} />}
      {invite && <RoleForm onClose={() => setInvite(false)} />}
      {group && <GroupForm group={group === 'new' ? null : group} onClose={() => setGroup(null)} />}
    </div>
  );
}

/**
 * Eigene Rechte im Projekt: Rolle, Einzelrechte und je KI-Funktion erlaubt oder die Begründung (KI-Freigaben, aus
 * /projects/:id/ai/capabilities). Leser sehen nur die Auskunftsfunktionen, Funktionen der PL nur die PL.
 */
export function MyRights() {
  const { detail, ai } = useProject();
  const me = detail.project.myMembership;
  const features = (AI_FEATURES as readonly AiFeatureDef[]).filter((f) => f.who !== 'agent' && !f.later
    && (me.role === 'pl' || (!f.key.startsWith('pl.') && (me.role !== 'reader' || f.key === 'assist.ask' || f.key === 'agent.chat'))));
  return (
    <>
      <h3 className="mt">Deine Rechte</h3>
      <p className="small">{roleLabel[me.role]}{me.role === 'pl' && (me.isDeputy ? ' (Stellvertretung)' : ' (verantwortlich)')} · Einzelrechte: {me.role === 'pl' ? 'alle' : rightsText(me)}</p>
      {!ai ? <p className="muted small">KI-Freigaben werden geladen …</p>
        : <table className="table"><thead><tr><th>KI-Funktion</th><th>Für dich</th></tr></thead><tbody>
          {features.map((f) => {
            const c = ai.features[f.key as keyof typeof ai.features];
            return <tr key={f.key}><td>{f.label}</td><td className="small">{!c ? <span className="muted">–</span> : c.allowed ? <span className="badge ok">erlaubt</span> : <span className="muted">gesperrt: {c.reason}</span>}</td></tr>;
          })}
        </tbody></table>}
    </>
  );
}

/** Gruppe ins Projekt aufnehmen oder ihre Rechte ändern (Rolle Leser oder Mitglied, Einzelrechte nur für Mitglieder). */
function GroupForm({ group, onClose }: { group: ProjectGroup | null; onClose: () => void }) {
  const { detail, reload } = useProject();
  const all = useData<{ groups: Group[] }>('/groups');
  const options = (all.data?.groups ?? []).filter((g) => (group ? g.id === group.groupId : !(detail.groups ?? []).some((x) => x.groupId === g.id)));
  const [f, setF] = useState({ groupId: group?.groupId ?? '', role: group?.role ?? 'member', canEditPlan: group?.canEditPlan ?? false, canApprove: group?.canApprove ?? false, canFinalize: group?.canFinalize ?? false, canUseAi: group?.canUseAi ?? true });
  const { busy, error, run } = useAsync();
  const groupId = f.groupId || options[0]?.id || '';
  return (
    <Modal title={group ? `Gruppe: ${group.name}` : 'Gruppe hinzufügen'} onClose={onClose}>
      <div className="form">
        {!group && <label className="field"><span>Gruppe</span><select value={groupId} onChange={(e) => setF({ ...f, groupId: e.target.value })}>{options.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.memberIds.length})</option>)}</select></label>}
        {!group && all.data && options.length === 0 && <div className="muted small">Keine weitere Gruppe vorhanden. Gruppen legt die Verwaltung an.</div>}
        <label className="field"><span>Rolle der Gruppe</span><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as 'member' | 'reader', canUseAi: e.target.value === 'member' })}><option value="member">Mitglied</option><option value="reader">Leser</option></select></label>
        {f.role === 'member' && <>
          <strong className="small">Zusätzliche Rechte</strong>
          <label className="check"><input type="checkbox" checked={f.canEditPlan} onChange={(e) => setF({ ...f, canEditPlan: e.target.checked })} /> Projektplan, Meilensteine ändern</label>
          <label className="check"><input type="checkbox" checked={f.canApprove} onChange={(e) => setF({ ...f, canApprove: e.target.checked })} /> Freigeben (KI-Vorschläge, Workflow-Schritte, Bestätigungen)</label>
          <label className="check"><input type="checkbox" checked={f.canFinalize} onChange={(e) => setF({ ...f, canFinalize: e.target.checked })} /> Dokument final setzen, Versand auslösen</label>
        </>}
        <label className="check"><input type="checkbox" checked={f.canUseAi} onChange={(e) => setF({ ...f, canUseAi: e.target.checked })} /> {f.role === 'reader' ? 'KI nutzen (nur Fragen)' : 'KI nutzen'}</label>
        <p className="muted small">Personen mit Direkteintrag behalten ihre eigenen Rechte. Bei mehreren Gruppen gilt die höchste Rolle, Einzelrechte addieren sich. KI-Agenten werden nie über Gruppen Mitglied.</p>
        {error && <div className="error">{error}</div>}
        <div><button className="btn primary" disabled={busy || !groupId} onClick={() => void run(async () => {
          const { groupId: _g, ...rights } = f; void _g;
          await api.put(`/projects/${detail.project.id}/groups/${groupId}`, rights); await reload(); onClose();
        })}>Speichern</button></div>
      </div>
    </Modal>
  );
}

function RoleForm({ member, onClose }: { member?: MemberRow; onClose: () => void }) {
  const { detail, users, reload, tasks, reloadTasks } = useProject();
  const me = detail.project.myMembership;
  const isPrimary = me.role === 'pl' && !me.isDeputy;
  const dialog = useDialog();
  // Agenten anderer Projekte (von deren PL angelegt) sind nicht wählbar; nach Projektregel ggf. nur Agenten
  // Agenten nur, wenn sie hier einsetzbar sind (Einsatz, LLM im Projekt freigegeben; Konzept LLM/Agenten 2.2); die anderen mit Grund darunter
  const agentInfo = useData<{ orgAgents: { id: string; name: string; usable: boolean; reason: string | null; member: boolean }[] }>(member ? null : `/projects/${detail.project.id}/agents`);
  const unusable = (agentInfo.data?.orgAgents ?? []).filter((a) => !a.member && !a.usable);
  const candidates = users.filter((u) => !detail.members.some((m) => m.userId === u.id) && (!u.agentProjectId || u.agentProjectId === detail.project.id) && (!useProjectPolicy(detail.project).members.onlyOwnerAndAgents || u.kind === 'agent') && !(u.kind === 'agent' && unusable.some((a) => a.id === u.id)));
  const [f, setF] = useState({ userId: member?.userId ?? candidates[0]?.id ?? '', role: member?.role ?? 'member', isDeputy: member?.isDeputy ?? true, canEditPlan: member?.canEditPlan ?? false, canApprove: member?.canApprove ?? false, canFinalize: member?.canFinalize ?? false, canUseAi: member?.canUseAi ?? true });
  const { busy, error, run } = useAsync();
  const picked = users.find((u) => u.id === f.userId);
  const isAgent = (member?.kind ?? picked?.kind) === 'agent';
  const [agentCanMail, setAgentCanMail] = useState(member?.agentCanMail ?? true);
  return (
    <Modal title={member ? `${member.origin === 'group' ? 'Direkteintrag' : 'Rolle'}: ${member.name}` : 'Mitglied hinzufügen'} onClose={onClose}>
      <div className="form">
        {member?.origin === 'group' && <div className="notice small">Mitglied über {(detail.groups ?? []).filter((g) => g.memberIds.includes(member.userId)).map((g) => g.name).join(', ') || 'eine Gruppe'}. Speichern legt einen Direkteintrag an; er überschreibt die Rechte aus den Gruppen, bis du „Gruppenrechte übernehmen“ wählst.</div>}
        {!member && <label className="field"><span>Benutzer des Mandanten</span><select value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}>{candidates.map((u) => <option key={u.id} value={u.id}>{u.name}{u.kind === 'agent' ? ' · KI-Agent' : ` (${u.email})`}</option>)}</select></label>}
        {!member && unusable.length > 0 && <div className="muted small">Nicht einsetzbar: {unusable.map((a) => `${a.name} (${a.reason})`).join('; ')}</div>}
        {isAgent && <div className="notice small">KI-Agent: handelt bei Arbeitspaketen und Aufgaben, für die er zuständig ist (direkt oder geerbt, z. B. als Teilprojekt-Verantwortung), und schreibt Log-Einträge unter seinem Namen. Als stellvertretende PL plant er im ganzen Projekt (Teilprojekte, Arbeitspakete, Aufgaben, Zuweisungen, Termine), verwaltet aber keine Mitglieder, Rechte oder Einstellungen und legt keine Projekte an.<label className="field" style={{ marginTop: 6 }}><span>Rolle</span><select value={f.role === 'pl' ? 'pl' : 'member'} onChange={(e) => setF({ ...f, role: e.target.value as any })}><option value="member">Mitglied</option><option value="pl">Stellvertretende PL</option></select></label><label className="check" style={{ marginTop: 6 }}><input type="checkbox" checked={agentCanMail} onChange={(e) => setAgentCanMail(e.target.checked)} /> darf Mails über das Projektkonto senden (sonst nur Entwürfe zur Freigabe)</label><label className="check"><input type="checkbox" checked={f.canFinalize} onChange={(e) => setF({ ...f, canFinalize: e.target.checked })} /> darf Doku-Seiten final setzen und an den Verteiler senden</label></div>}
        {/* „KI nutzen“ je Rolle vorbelegt: Mitglied an, Leser aus */}
        {!isAgent && <label className="field"><span>Projektrolle</span><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as any, canUseAi: e.target.value !== 'reader' })}><option value="pl">PL</option><option value="member">Mitglied</option><option value="reader">Leser</option></select></label>}
        {!isAgent && f.role === 'pl' && (isPrimary
          ? <label className="check"><input type="checkbox" checked={f.isDeputy} onChange={(e) => setF({ ...f, isDeputy: e.target.checked })} /> Stellvertretung (zweiter PL). Ohne Haken wird diese Person verantwortlicher PL, der bisherige wird Stellvertretung.</label>
          : <div className="muted small">Als Stellvertretung (zweiter PL). Die verantwortliche PL übergibt ihre Rolle nur selbst.</div>)}
        {!isAgent && f.role === 'member' && <>
          <strong className="small">Zusätzliche Rechte</strong>
          <label className="check"><input type="checkbox" checked={f.canEditPlan} onChange={(e) => setF({ ...f, canEditPlan: e.target.checked })} /> Projektplan, Meilensteine ändern</label>
          <label className="check"><input type="checkbox" checked={f.canApprove} onChange={(e) => setF({ ...f, canApprove: e.target.checked })} /> Freigeben (KI-Vorschläge, Workflow-Schritte, Bestätigungen)</label>
          <label className="check"><input type="checkbox" checked={f.canFinalize} onChange={(e) => setF({ ...f, canFinalize: e.target.checked })} /> Dokument final setzen, Versand auslösen</label>
          <label className="check"><input type="checkbox" checked={f.canUseAi} onChange={(e) => setF({ ...f, canUseAi: e.target.checked })} /> KI nutzen</label>
        </>}
        {!isAgent && f.role === 'reader' && <label className="check"><input type="checkbox" checked={f.canUseAi} onChange={(e) => setF({ ...f, canUseAi: e.target.checked })} /> KI nutzen (nur Fragen)</label>}
        {error && <div className="error">{error}</div>}
        <div><button className="btn primary" disabled={busy || !f.userId} onClick={() => void run(async () => {
          const isDeputy = isPrimary ? f.isDeputy : true;
          const body: Record<string, unknown> = isAgent ? { role: f.role === 'pl' ? 'pl' : 'member', isDeputy: true, agentCanMail, canFinalize: f.canFinalize } : { ...f, isDeputy };
          const primary = detail.members.find((m) => m.role === 'pl' && !m.isDeputy);
          if (f.role === 'pl' && !isDeputy && primary && primary.userId !== f.userId) {
            const direct = tasks.filter((x) => !x.done && x.responsibleUserId === primary.userId).length + detail.subprojects.filter((s) => s.responsibleUserId === primary.userId).length;
            if (direct > 0) { const v = await dialog.choose({ title: 'Direkt zugewiesene Arbeitspakete', text: `${direct} Arbeitspaket(e)/Teilprojekt(e) sind ${primary.name} direkt  zugewiesen. Auch an die neue Projektleitung übertragen? Geerbte Zuständigkeiten wechseln in jedem Fall.`, options: [{ label: 'Mit übertragen', value: true, primary: true }, { label: 'Nur geerbte wechseln', value: false }] }); if (v === null) return; body.transferTasks = v; }
          }
          await api.put(`/projects/${detail.project.id}/members/${f.userId}`, body); await reload(); await reloadTasks(); onClose(); })}>Speichern</button></div>
      </div>
    </Modal>
  );
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

/**
 * Außenkommunikation (Informationsgrenze für Externe): externes Profil, das Externe über das Projekt erfahren dürfen (Name
 * nach außen, Adresse, Zufahrt, Ansprechpartner für Externe), und die Prüfstufe für Agenten-Mails an Nicht-Interne.
 */
export function ExternalCard() {
  const { detail, reload } = useProject();
  const ai = useAiStatus();
  const isPl = detail.project.myMembership.role === 'pl';
  const p = detail.project.externalProfile ?? {};
  const init = () => ({ name: p.name ?? '', address: p.address ?? '', access: p.access ?? '', contacts: (p.contacts ?? []).map((c) => ({ name: c.name, email: c.email, role: c.role ?? '' })) });
  const [f, setF] = useState(init);
  const { busy, error, run } = useAsync();
  const guard = ai?.externalGuard === 'check' ? 'nur prüfen (ohne Neuformulierung)' : 'neu formulieren und prüfen';
  const intro = <p className="muted small">KI-Agenten schreiben Externen nur, was zu deren Aufgabe gehört: Außenbeschreibung des AP, Log-Einträge „für Externe sichtbar“, freigegebene Seiten und dieses Profil. Prüfstufe (Verwaltung › KI): <strong>{guard}</strong>. Der erste Kontakt zu einer Adresse ohne Bezug zum AP geht immer als Entwurf; Angehaltenes steht unter <Link to={`/projekte/${detail.project.id}/mail/freigaben`}>Mail › Freigaben</Link>.</p>;
  if (!isPl) {
    return <>{intro}<dl className="kv"><dt>Name nach außen</dt><dd>{p.name || '–'}</dd><dt>Adresse</dt><dd>{p.address || '–'}</dd><dt>Zufahrt, Hinweise</dt><dd>{p.access || '–'}</dd><dt>Ansprechpartner</dt><dd>{p.contacts?.length ? p.contacts.map((c) => `${c.name}${c.role ? ` (${c.role})` : ''}${c.email ? ` <${c.email}>` : ''}`).join('; ') : 'keiner (Verweis an „die Projektleitung“)'}</dd></dl></>;
  }
  const setContact = (i: number, k: 'name' | 'email' | 'role', v: string) => setF({ ...f, contacts: f.contacts.map((c, j) => (j === i ? { ...c, [k]: v } : c)) });
  return (
    <div className="form">
      {intro}
      <label className="field"><span>Name nach außen (statt des internen Projektnamens)</span><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="z. B. Neubau Firmensitz" /></label>
      <label className="field"><span>Adresse</span><input type="text" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></label>
      <label className="field"><span>Zufahrt und Hinweise für Externe</span><textarea value={f.access} onChange={(e) => setF({ ...f, access: e.target.value })} /></label>
      <div className="field"><span>Ansprechpartner für Externe (dürfen in Mails nach außen genannt werden; an sie verweist der Agent Fragen außerhalb der Aufgabe)</span>
        {f.contacts.map((c, i) => (
          <div key={i} className="row mb">
            <input type="text" placeholder="Name" value={c.name} onChange={(e) => setContact(i, 'name', e.target.value)} style={{ flex: 1 }} />
            <input type="email" placeholder="Mail" value={c.email} onChange={(e) => setContact(i, 'email', e.target.value)} style={{ flex: 1 }} />
            <input type="text" placeholder="Rolle" value={c.role} onChange={(e) => setContact(i, 'role', e.target.value)} style={{ width: 120 }} />
            <button className="btn sm link" onClick={() => setF({ ...f, contacts: f.contacts.filter((_, j) => j !== i) })}>✕</button>
          </div>
        ))}
        <div><button className="btn sm" onClick={() => setF({ ...f, contacts: [...f.contacts, { name: '', email: '', role: '' }] })}>Ansprechpartner hinzufügen</button></div>
      </div>
      {error && <div className="error">{error}</div>}
      <div><button className="btn primary sm" disabled={busy} onClick={() => void run(async () => { await api.put(`/projects/${detail.project.id}/external-profile`, f); await reload(); })}>Speichern</button></div>
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

/** Konten des Projekts: Projektbindungen mit Standard-Ausgangskonto, angebotene Konten der Organisation, Anbinden eigener oder verwalteter Konten. */
function ProjectAccountsCard({ onCreate, onOauth, providers }: { onCreate: () => void; onOauth: (p: { key: 'microsoft' | 'google'; label: string; mailProvider: 'graph' | 'imap' }) => void; providers: { key: 'microsoft' | 'google'; label: string; mailProvider: 'graph' | 'imap' }[] }) {
  const { detail, reload } = useProject();
  const { user } = useAuth();
  const isPl = detail.project.myMembership.role === 'pl';
  const data = useData<{ accounts: MailAccount[]; bindable: MailAccount[] }>(`/projects/${detail.project.id}/mail/accounts`);
  const [bindId, setBindId] = useState('');
  const { busy, error, run } = useAsync();
  const dialog = useDialog();
  const refresh = async () => { await data.reload(); await reload(); };
  const accounts = data.data?.accounts ?? [];
  const bindable = data.data?.bindable ?? [];
  return (
    <div className="mt" id="konten">
      <h3>Postfächer des Projekts</h3>
      <p className="muted small">Antwortadresse (Plus-Code), Absender für Agenten, Einladungen, Erinnerungen, Berichte und Workflows. Genau eines ist Standard für ausgehende Mails. Die PL legt ein <strong>Projektpostfach</strong> an oder holt ein <strong>zentrales Postfach</strong> der Organisation (vom Org-Admin angeboten oder für alle Projekte freigegeben) bzw. ein eigenes Konto ins Projekt; das Org-Postfach bleibt den Systemmails vorbehalten.</p>
      {error && <div className="error small">{error}</div>}
      {accounts.length === 0 && <p className="notice small">Kein Projektkonto: Nachfragen, Erinnerungen, PDF-Versand und Reporting brauchen eines.</p>}
      {accounts.length > 0 && <table className="table"><thead><tr><th>Standard</th><th>Konto</th><th>Art</th><th /></tr></thead><tbody>
        {accounts.map((a) => <tr key={a.id}>
          <td><input type="radio" name="default-account" checked={Boolean(a.isDefault)} disabled={!isPl || busy} title={isPl ? 'Als Standard für ausgehende Mails setzen' : 'Standard-Ausgangskonto'} onChange={() => void run(async () => { await api.put(`/projects/${detail.project.id}/mail/default-account`, { accountId: a.id }); await refresh(); })} /></td>
          <td>{a.name}<div className="muted small">{a.address}{a.offered && <span className="badge" style={{ marginLeft: 6 }} title="Vom Org-Admin angeboten; wird nie automatisch Standard">angeboten</span>}</div></td>
          <td className="small">{kindLabel(a, user?.id, [detail.project])}</td>
          <td className="nowrap">{isPl && <button className="btn sm link" disabled={busy} onClick={() => { const u = a.uses?.find((x) => x.use === 'project' && x.projectId === detail.project.id); if (u) void dialog.confirm({ title: 'Projektbindung lösen', text: `${a.address} nicht mehr als Projektkonto nutzen? Ansichten darüber verschwinden, Kopien in Arbeitspaketen bleiben.`, confirmLabel: 'Lösen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/mail/accounts/${a.id}/uses/${u.id}`); await refresh(); }); }); }}>Bindung lösen</button>}</td>
        </tr>)}
      </tbody></table>}
      {isPl && <div className="row mt">
        <button className="btn sm primary" onClick={onCreate}>Neues Projektpostfach anbinden</button>
        {providers.map((p) => <button key={p.key} className="btn sm" onClick={() => onOauth(p)}>Mit {p.label} verbinden</button>)}
        {bindable.length > 0 && <>
          <select value={bindId} onChange={(e) => setBindId(e.target.value)} style={{ width: 'auto' }}><option value="">– vorhandenes Postfach ins Projekt holen –</option>{bindable.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.address}) · {kindLabel(a, user?.id, [detail.project])}{(a.uses ?? []).filter((u) => u.use === 'project').length ? ` · in ${(a.uses ?? []).filter((u) => u.use === 'project').map(useLabel).join(', ')}` : ''}</option>)}</select>
          <button className="btn sm" disabled={!bindId || busy} onClick={() => void run(async () => { await api.post(`/mail/accounts/${bindId}/uses`, { use: 'project', projectId: detail.project.id }); setBindId(''); await refresh(); })}>Binden</button>
        </>}
      </div>}
    </div>
  );
}

function MailViewsCard() {
  const { detail, reload } = useProject();
  const [account, setAccount] = useState(false);
  const oauth = useData<{ providers: { key: 'microsoft' | 'google'; label: string; mailProvider: 'graph' | 'imap' }[] }>('/oauth/providers');
  const [oauthStart, setOauthStart] = useState<{ key: 'microsoft' | 'google'; label: string; mailProvider: 'graph' | 'imap' } | null>(null);
  const isPl = detail.project.myMembership.role === 'pl';
  const views = useData<{ views: ViewRow[] }>(`/projects/${detail.project.id}/mail/views`);
  const [newView, setNewView] = useState(false);
  const [rightsFor, setRightsFor] = useState<ViewRow | null>(null);
  const [filterFor, setFilterFor] = useState<ViewRow | null>(null);
  const [aiFolder, setAiFolder] = useState(false);
  const { busy, error, run } = useAsync();
  const agents = detail.members.filter((m) => m.kind === 'agent');
  const setAi = (v: ViewRow, body: { aiProcess?: boolean; agentUserId?: string | null }) => run(async () => { await api.patch(`/mail/views/${v.id}`, body); await views.reload(); });
  const f = (v: ViewRow) => { const x = v.filter; return [x.folders?.length && `Ordner ${x.folders.join(', ')}`, x.from?.length && `Von ${x.from.join(', ')}`, x.to?.length && `An ${x.to.join(', ')}`, x.subject?.length && `Betreff ${x.subject.join(', ')}`, x.keyword?.length && `Stichwort ${x.keyword.join(', ')}`, x.since && `ab ${x.since}`].filter(Boolean).join(' · ') || 'alle Mails des Kontos'; };
  return (
    <div>
      <p className="muted small">Eine Ansicht ist ein Filter auf ein Konto. Nur Treffer werden gespeichert. Rechte (Lesen, Entwurf, Senden, Arbeitspaket erzeugen) hängen an der Ansicht: je Person, Rolle oder Gruppe.</p>
      {views.data && views.data.views.length === 0 && <div className="empty">Noch keine Ansicht. Ohne Ansicht werden keine Mails geladen.</div>}
      {error && <div className="error small">{error}</div>}
      {views.data && views.data.views.length > 0 && <table className="table"><thead><tr><th>Ansicht</th><th>Konto</th><th>Filter</th><th title="Ein Agent bearbeitet neue Mails der Ansicht: als stellvertretende PL direkt, als Mitglied Vorschläge; „Ordner“ heißt: jede Mail dort sofort">Agent</th><th /></tr></thead><tbody>
        {views.data.views.map((v) => <tr key={v.id}><td>{v.name}</td><td className="small">{v.accountAddress}<div className="muted">{v.accountType === 'personal' ? 'persönlich' : v.accountType === 'org' ? 'Organisation' : 'Projektkonto'}</div></td><td className="small muted">{f(v)}</td>
          <td className="small">{(() => {
            const may = v.canManage && (v.accountType === 'personal' || isPl);
            const projectAgent = v.accountType === 'project' && detail.project.agentUserId && detail.project.agentMail !== 'off' ? agents.find((a) => a.userId === detail.project.agentUserId) : null;
            const label = (a: { name: string; role: string }) => `${a.name} (${a.role === 'pl' ? 'stellv. PL: legt direkt an' : 'Mitglied: schlägt vor'})`;
            if (!may) return <span className="muted">{v.agentName ? `${v.agentName}${v.aiProcess ? ' · Ordner' : ''}` : projectAgent ? `Projektagent ${projectAgent.name}` : '–'}</span>;
            return <>
              <select value={v.agentUserId ?? ''} disabled={busy} style={{ width: 'auto' }} onChange={(e) => void setAi(v, { agentUserId: e.target.value || null })}><option value="">{projectAgent ? `– Projektagent ${projectAgent.name} –` : '– kein Agent –'}</option>{agents.map((a) => <option key={a.userId} value={a.userId}>{label(a)}</option>)}</select>
              <label className="check" title="Jede Mail, die in diesem Ordner landet, bearbeitet der Agent sofort (Ordner „KI Bearbeiten“)"><input type="checkbox" checked={Boolean(v.aiProcess)} disabled={busy || (!v.aiProcess && !v.agentUserId && !projectAgent)} onChange={(e) => void setAi(v, { aiProcess: e.target.checked })} /> Ordner: sofort bearbeiten</label>
            </>;
          })()}</td>
          <td className="nowrap">{v.canManage && <><button className="btn sm link" onClick={() => setFilterFor(v)}>Filter</button><button className="btn sm link" onClick={() => setRightsFor(v)}>Rechte</button></>}</td></tr>)}
      </tbody></table>}
      <ProjectAccountsCard onCreate={() => setAccount(true)} onOauth={(p) => setOauthStart(p)} providers={oauth.data?.providers ?? []} />
      {oauthStart && <OAuthStartDialog provider={oauthStart} projects={[detail.project]} fixedProject={detail.project} onClose={() => setOauthStart(null)} />}
      <div className="row mt"><button className="btn sm" onClick={() => setNewView(true)}>+ Ansicht</button><button className="btn sm" disabled={agents.length === 0} title={agents.length ? 'Ordner im Konto, dessen Mails ein Agent sofort bearbeitet (als stellv. PL direkt, als Mitglied Vorschläge)' : 'Erst einen KI-Agenten als Mitglied aufnehmen'} onClick={() => setAiFolder(true)}>Ordner „KI Bearbeiten“ einrichten</button><Link className="btn sm link" to="/einstellungen/konfiguration">Konten verwalten</Link></div>
      {aiFolder && <AiFolderDialog onClose={() => setAiFolder(false)} onDone={() => { setAiFolder(false); void views.reload(); }} />}
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


type ProjectLlms = { available: { id: string; name: string; provider: string; model: string; own: boolean }[]; own: { id: string; name: string; provider: 'local' | 'anthropic'; model: string; baseUrl: string | null; hasKey: boolean; active: boolean; adminBlocked: boolean; thinkingOff: boolean; tokensIn: number; tokensOut: number; lastUsedAt: string | null }[]; canAddOwn: boolean; addOwnReason?: string | null; ownLlmAllowed?: boolean };

/** Projekt-KI: eines der im Projekt verfügbaren LLMs (vom Org-Admin freigegeben oder eigenes); ohne Auswahl sind die KI-Funktionen aus. */
/**
 * Projektagent (#52): ein KI-Agent als dritte PL-Rolle (stellvertretende Projektleitung). Mit Mail-Modus bearbeitet er neue Mails der
 * Projektkonten selbst oder schlägt vor; der Ordner „KI Bearbeiten“ bleibt für Konten ohne Projektagent und für Agenten mit kleinerer Rolle.
 */
function ProjectAgentSelect({ readOnly = false }: { readOnly?: boolean }) {
  const { detail, reload } = useProject();
  const { busy, error, run } = useAsync();
  const agents = detail.members.filter((m) => m.kind === 'agent');
  const cur = agents.find((a) => a.userId === detail.project.agentUserId);
  const mode = detail.project.agentMail ?? 'off';
  const MODE: Record<string, string> = { off: 'nur Rolle (Mails nur über Ordner „KI Bearbeiten“ oder Agent je Ansicht)', triage: 'schlägt zu neuen Mails der Projektkonten nur vor', process: 'bearbeitet neue Mails der Projektkonten direkt (als stellvertretende PL)' };
  if (readOnly) return <>{cur ? `${cur.name} · ${MODE[mode]}` : <span className="muted">keiner</span>}</>;
  const set = (agentUserId: string | null, agentMail: string) => void run(async () => { await api.put(`/projects/${detail.project.id}/agent`, { agentUserId, agentMail }); await reload(); });
  return <span className="stack" style={{ gap: 4 }}>
    <span className="row">
      <select value={cur?.userId ?? ''} disabled={busy} style={{ width: 'auto' }} onChange={(e) => set(e.target.value || null, mode)}><option value="">keiner</option>{agents.map((a) => <option key={a.userId} value={a.userId}>{a.name}</option>)}</select>
      {cur && <select value={mode} disabled={busy} style={{ width: 'auto' }} title="Mails der Projektkonten" onChange={(e) => set(cur.userId, e.target.value)}>{Object.entries(MODE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}
    </span>
    <span className="muted small">{agents.length === 0 ? 'Zuerst einen KI-Agenten als Mitglied aufnehmen.' : 'Der Projektagent ist stellvertretende Projektleitung; die KI-Freigabe „Projektagent bearbeitet Mails der Projektkonten“ muss es erlauben. Was ihm unklar ist, fragt er nach (Mail-Rückfrage).'}</span>
    {error && <span className="error small">{error}</span>}</span>;
}

/** Mail-Rückfrage (#51): wie der Projektagent mit offenen Punkten aus neuen Mails umgeht; Vorgabe vom Mandanten (Verwaltung). */
function MailInquirySelect({ readOnly = false }: { readOnly?: boolean }) {
  const { detail, reload } = useProject();
  const { busy, error, run } = useAsync();
  const v = detail.project.mailInquiry ?? { mode: 'ask_pl', waitHours: 48, inherited: true };
  const LABEL: Record<string, string> = { ask_pl: 'PL fragen (Karte: klar / im Projekt fragen / beim Absender rückfragen)', ask_project: 'im Projekt fragen', ask_sender: 'beim Absender rückfragen', off: 'aus (offene Punkte nur im Log)' };
  const [hours, setHours] = useState<string | null>(null);
  if (readOnly) return <>{LABEL[v.mode]} · Frist {v.waitHours} h{v.inherited && <span className="muted small"> (Vorgabe des Mandanten)</span>}</>;
  const save = (mode: string, waitHours: number) => void run(async () => { await api.patch(`/projects/${detail.project.id}`, { mailInquiry: { mode, waitHours } }); setHours(null); await reload(); });
  return <span className="stack" style={{ gap: 4 }}>
    <span className="row">
      <select value={v.inherited ? '' : v.mode} disabled={busy} style={{ width: 'auto' }} onChange={(e) => { if (!e.target.value) void run(async () => { await api.patch(`/projects/${detail.project.id}`, { mailInquiry: null }); await reload(); }); else save(e.target.value, v.waitHours); }}>
        <option value="">wie Mandant ({LABEL[v.mode]})</option>{Object.entries(LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      {!v.inherited && v.mode !== 'off' && <label className="row small" style={{ gap: 4 }}>Frist <input type="number" min={1} max={720} value={hours ?? String(v.waitHours)} style={{ width: 70 }} onChange={(e) => setHours(e.target.value)} onBlur={() => { const h = Number(hours); if (hours !== null && Number.isInteger(h) && h >= 1 && h <= 720 && h !== v.waitHours) save(v.mode, h); else setHours(null); }} /> h</label>}
    </span>
    <span className="muted small">Nennt die Mail-KI zu einer neuen Mail offene Punkte, fragt der Projektagent nach, statt zu raten. Ohne Projektagent stehen sie im Log des Arbeitspakets.</span>
    {error && <span className="error small">{error}</span>}</span>;
}

/**
 * Agenten-Policy des Projekts (Konzept 6): Selbstständigkeit und zu bestätigende Schritte für alle Agenten im Projekt, Grenzen für
 * Agenten und Arbeitspakete, Workflow-Schritte. Vorgabe und Grenzen des Mandanten gelten darüber.
 */
function ProjectAgentPolicy({ readOnly = false }: { readOnly?: boolean }) {
  const { detail, reload } = useProject();
  const d = useData<{ effective: EffectiveAgentPolicy; project: AgentPolicy; org: AgentPolicy; agents: { userId: string; name: string; policy: AgentPolicy | null }[]; canEdit: boolean }>(`/projects/${detail.project.id}/agent-policy`);
  const [open, setOpen] = useState(false);
  const { error, run } = useAsync();
  if (!d.data) return null;
  const agents = d.data.agents;
  return <span className="stack" style={{ gap: 4 }}>
    <span className="row"><EffectivePolicyText e={d.data.effective} />{!readOnly && <button className="btn sm link" onClick={() => setOpen((o) => !o)}>{open ? 'schließen' : 'ändern'}</button>}</span>
    {open && <AgentPolicyEditor value={d.data.project} limits workflows inheritFrom="Mandant" effective={d.data.effective} onSave={async (v) => { await api.put(`/projects/${detail.project.id}/agent-policy`, v); setOpen(false); await d.reload(); await reload(); }} />}
    {agents.length > 0 && <span className="small stack" style={{ gap: 2 }}>{agents.map((a) => <span key={a.userId} className="row" style={{ gap: 6 }}><span className="muted">{a.name}:</span>{readOnly ? <span>{a.policy?.mode ? modeLabel(a.policy.mode) : 'erbt'}</span> : <select value={a.policy?.mode ?? ''} style={{ width: 'auto' }} onChange={(e) => void run(async () => { await api.put(`/projects/${detail.project.id}/members/${a.userId}/agent-policy`, e.target.value ? { mode: e.target.value } : null); await d.reload(); })}><option value="">erbt vom Projekt</option>{AGENT_MODES.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</select>}</span>)}</span>}
    <span className="muted small">Grundmenge (Log, Tasks, Doku-Entwürfe, interner Chat, Fragen) ist immer frei; Angehaltenes legt der Agent der PL als Karte vor. Je Arbeitspaket lässt sich die Selbstständigkeit im Arbeitspaket setzen, der Zugriff auf Doku-Ordner am Ordner.</span>
    {detail.project.agentUserId && <ProjectReview readOnly={readOnly} scope={d.data.effective.scope} />}
    {error && <span className="error small">{error}</span>}</span>;
}

/** Projektdurchlauf (Konzept 6.6): Stand des Überblicks, Steckbrief des Projektagenten und der Knopf „Projektdurchlauf jetzt“ (nur mit Reichweite „ganzes Projekt“). */
function ProjectReview({ readOnly, scope }: { readOnly: boolean; scope: 'task' | 'project' }) {
  const { detail } = useProject();
  const d = useData<{ digest: { structure: string; brief: string | null; builtAt: string | null; lastReview: { at: string; status: string; error: string | null } | null; reviewAt: string } | null }>(`/projects/${detail.project.id}/digest`);
  const [msg, setMsg] = useState('');
  const { busy, error, run } = useAsync();
  const dg = d.data?.digest;
  if (!dg) return null;
  return <span className="stack small" style={{ gap: 2 }}>
    <span className="row" style={{ gap: 6 }}><span className="muted">Projektdurchlauf:</span>
      {scope === 'project' ? <>werktags {dg.reviewAt}{dg.lastReview && <span className="muted">· zuletzt {fmtDate(dg.lastReview.at)}{dg.lastReview.status === 'skipped' ? ' (unverändert, kein LLM-Aufruf)' : dg.lastReview.status === 'error' ? ` (Fehler: ${dg.lastReview.error ?? ''})` : ''}</span>}
        {!readOnly && <button className="btn sm" disabled={busy} onClick={() => void run(async () => { const r = await api.post<{ run: { status: string; error?: string; actions: { type: string }[] } }>(`/projects/${detail.project.id}/agent-review`); setMsg(`${r.run.status === 'skipped' ? 'übersprungen' : `${r.run.actions.length} Aktion${r.run.actions.length === 1 ? '' : 'en'}`}${r.run.error ? ` · ${r.run.error}` : ''}`); await d.reload(); })}>Projektdurchlauf jetzt</button>}</> : <span className="muted">aus (Reichweite „zugewiesene Arbeitspakete“)</span>}
    </span>
    {msg && <span>{msg}</span>}
    {dg.brief && <details><summary className="muted">Steckbrief des Projektagenten</summary><div style={{ whiteSpace: 'pre-wrap' }}>{dg.brief}</div></details>}
    {error && <span className="error">{error}</span>}
  </span>;
}

/** Projekteinstellungen › KI (Konzept LLM/Agenten 3.2): LLM der Assistenz, eigene LLMs, Agenten im Projekt, eigene Agenten, Projektagent, Mail-Rückfrage, Policy. */
function ProjectAiCard() {
  const { detail } = useProject();
  const isPl = detail.project.myMembership.role === 'pl';
  const llms = useData<ProjectLlms>(`/projects/${detail.project.id}/llms`);
  return (
    <div className="card" id="ki">
      <div className="row between mb"><h2 style={{ margin: 0 }}>KI</h2><Link className="btn sm link" to="/hilfe/ki-agenten" title="KI-Handbuch">Hilfe</Link></div>
      <p className="muted small">LLMs und Agenten stellt die Organisation bereit (Einsatz je LLM und Agent); die PL wählt und nimmt auf. Ein Agent läuft hier nur, wenn sein LLM für dieses Projekt freigegeben ist.</p>
      <dl className="kv">
        <dt title="Für Zusammenfassen, Essenz, Frage ans Projekt, Statusbericht">LLM der Assistenz</dt><dd><ProjectAiSelect readOnly={!isPl} /></dd>
        <dt>Verfügbare LLMs</dt><dd className="small">{!llms.data ? '…' : llms.data.available.length === 0 ? <span className="muted">keins für dieses Projekt freigegeben{llms.data.canAddOwn ? ' – unten ein eigenes einbinden' : ' (Org-Admin: Verwaltung › KI › LLMs: Einsatz)'}</span> : llms.data.available.map((l) => <span key={l.id} className="badge" style={{ marginRight: 4 }} title={`${l.provider === 'local' ? 'Lokal' : 'Anthropic'} · ${l.model}`}>{l.name} · {l.own ? 'eigenes LLM' : 'Organisation'}</span>)}</dd>
        <dt>Projektagent</dt><dd><ProjectAgentSelect readOnly={!isPl} /></dd>
        <dt>Mail-Rückfrage</dt><dd><MailInquirySelect readOnly={!isPl} /></dd>
        <dt>Agenten-Policy</dt><dd><ProjectAgentPolicy readOnly={!isPl} /></dd>
      </dl>
      <ProjectAgentsInProject />
      <OwnLlmCard embedded />
      <ProjectAgentsCard embedded />
    </div>
  );
}

/** Agenten, die Mitglied sind: Rolle, LLM, läuft hier oder Grund; Aufnahme von Org-Agenten mit Einsetzbarkeit. */
function ProjectAgentsInProject() {
  const { detail, reload } = useProject();
  const isPl = detail.project.myMembership.role === 'pl';
  const d = useData<{ inProject: { id: string; name: string; role: string; profileName: string | null; own: boolean; usable: boolean; reason: string | null }[]; orgAgents: { id: string; name: string; persona: string | null; profileName: string | null; member: boolean; usable: boolean; reason: string | null }[] }>(`/projects/${detail.project.id}/agents`);
  const [pick, setPick] = useState('');
  const [role, setRole] = useState<'member' | 'pl'>('member');
  const { busy, error, run } = useAsync();
  if (!d.data) return null;
  const free = d.data.orgAgents.filter((a) => !a.member);
  const usable = free.filter((a) => a.usable);
  return (
    <div className="mt">
      <h3>Agenten im Projekt</h3>
      {d.data.inProject.length === 0 ? <div className="empty">Noch kein Agent im Projekt.</div> : <table className="table"><thead><tr><th>Agent</th><th>Rolle</th><th>LLM</th><th>Status</th></tr></thead><tbody>
        {d.data.inProject.map((a) => <tr key={a.id}><td>{a.name}{a.own && <span className="muted small"> · eigener Agent</span>}{detail.project.agentUserId === a.id && <span className="badge" style={{ marginLeft: 6 }}>Projektagent</span>}</td><td className="small">{a.role === 'pl' ? 'stellv. PL' : 'Mitglied'}</td><td className="small">{a.profileName ?? <span className="muted">kein LLM</span>}</td><td className="small">{a.usable ? <span className="badge ok">läuft</span> : <span className="badge warn" title={a.reason ?? ''}>läuft nicht</span>}{!a.usable && <div className="muted">{a.reason}</div>}</td></tr>)}
      </tbody></table>}
      {isPl && free.length > 0 && <div className="row mt small">
        <span className="muted">Agent der Organisation aufnehmen:</span>
        <select value={pick} disabled={busy || usable.length === 0} style={{ width: 'auto' }} onChange={(e) => setPick(e.target.value)}><option value="">{usable.length ? '– wählen –' : '– keiner einsetzbar –'}</option>{usable.map((a) => <option key={a.id} value={a.id}>{a.name}{a.profileName ? ` · ${a.profileName}` : ''}</option>)}</select>
        <select value={role} disabled={busy} style={{ width: 'auto' }} onChange={(e) => setRole(e.target.value as 'member' | 'pl')}><option value="member">Mitglied (schlägt vor)</option><option value="pl">stellv. PL (legt direkt an)</option></select>
        <button className="btn sm" disabled={busy || !pick} onClick={() => void run(async () => { await api.put(`/projects/${detail.project.id}/members/${pick}`, { role, agentCanMail: true }); setPick(''); await d.reload(); await reload(); })}>Aufnehmen</button>
      </div>}
      {isPl && free.some((a) => !a.usable) && <div className="muted small mt">Nicht einsetzbar: {free.filter((a) => !a.usable).map((a) => `${a.name} (${a.reason})`).join('; ')}</div>}
      {error && <div className="error small">{error}</div>}
    </div>
  );
}

function ProjectAiSelect({ readOnly = false }: { readOnly?: boolean }) {
  const { detail, reload } = useProject();
  const d = useData<ProjectLlms>(`/projects/${detail.project.id}/llms`);
  const { busy, error, run } = useAsync();
  if (!d.data) return null;
  const avail = d.data.available;
  const cur = avail.find((p) => p.id === detail.project.aiProfileId);
  if (readOnly) return <>{cur?.name ?? <span className="muted">{detail.project.aiProfileId ? 'nicht mehr verfügbar' : 'aus'}</span>}</>;
  return <span className="row"><select value={cur ? cur.id : ''} disabled={busy} style={{ width: 'auto' }} onChange={(e) => void run(async () => { await api.patch(`/projects/${detail.project.id}`, { aiProfileId: e.target.value || null }); await reload(); })}><option value="">aus</option>{avail.map((p) => <option key={p.id} value={p.id}>{p.name}{p.own ? ' (eigenes LLM)' : ''}</option>)}</select>
    {detail.project.aiProfileId && !cur && <span className="muted small">bisheriges LLM nicht mehr verfügbar</span>}
    {avail.length === 0 && <span className="muted small">Kein LLM für dieses Projekt freigegeben{d.data.canAddOwn ? '; unten ein eigenes einbinden' : ' (Org-Admin)'}.</span>}
    {error && <span className="error small">{error}</span>}</span>;
}

/** Eigene LLMs des Projekts (PL): nur hier nutzbar, Schlüssel verschlüsselt; der Org-Admin sieht Name, Anbieter, Adresse und Verbrauch und kann sperren. */
function OwnLlmCard({ embedded = false }: { embedded?: boolean }) {
  const { detail, reload } = useProject();
  const d = useData<ProjectLlms>(`/projects/${detail.project.id}/llms`);
  const [edit, setEdit] = useState<ProjectLlms['own'][number] | 'new' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const { busy, error, run } = useAsync();
  // Sichtbar, wenn der Mandant eigene LLMs für diese Projektart erlaubt; sperren die KI-Freigaben, nennt der Knopf den Grund
  if (!d.data || (!d.data.canAddOwn && !d.data.ownLlmAllowed && d.data.own.length === 0)) return null;
  const base = `/projects/${detail.project.id}/llms`;
  return (
    <div className={embedded ? 'mt' : 'card'} id="llm">
      <div className="row between mb">{embedded ? <h3 style={{ margin: 0 }}>Eigenes LLM</h3> : <h2 style={{ margin: 0 }}>Eigenes LLM</h2>}{(d.data.canAddOwn || d.data.ownLlmAllowed) && <button className="btn primary sm" disabled={!d.data.canAddOwn} title={d.data.addOwnReason ?? undefined} onClick={() => setEdit('new')}>Einbinden</button>}</div>
      {!d.data.canAddOwn && d.data.ownLlmAllowed && d.data.addOwnReason && <div className="notice small mb">{d.data.addOwnReason}</div>}
      <p className="muted small">Ein eigenes LLM (lokal, OpenAI-kompatibel, oder Anthropic) nur für dieses Projekt: für die Projekt-KI und eigene Agenten. Der Schlüssel liegt verschlüsselt; der Org-Admin sieht Name, Anbieter, Adresse und Verbrauch und kann es sperren.</p>
      {error && <div className="error small">{error}</div>}
      {msg && <div className="success small">{msg}</div>}
      {d.data.own.length > 0 && <table className="table"><tbody>{d.data.own.map((l) => <tr key={l.id} style={l.active && !l.adminBlocked ? undefined : { opacity: 0.6 }}>
        <td>{l.name}<div className="muted small">{l.provider === 'local' ? l.baseUrl : 'Anthropic'} · {l.model}</div></td>
        <td className="small">{l.adminBlocked ? <span className="badge danger">vom Org-Admin gesperrt</span> : l.active ? <span className="badge ok">aktiv</span> : <span className="badge">inaktiv</span>}<div className="muted">{(l.tokensIn + l.tokensOut).toLocaleString('de-DE')} Token</div></td>
        <td className="nowrap"><button className="btn sm" disabled={busy} onClick={() => void run(async () => { const r = await api.post<{ model: string; reply: string }>(`${base}/${l.id}/test`); setMsg(`${l.name}: ${r.model} antwortet „${r.reply}“.`); })}>Testen</button> <button className="btn sm link" onClick={() => setEdit(l)}>Bearbeiten</button> <button className="btn sm link" disabled={busy} onClick={() => void run(async () => { await api.del(`${base}/${l.id}`); await d.reload(); await reload(); })}>Entfernen</button></td></tr>)}</tbody></table>}
      {edit && <OwnLlmForm llm={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await d.reload(); await reload(); }} />}
    </div>
  );

  function OwnLlmForm({ llm, onClose, onSaved }: { llm: ProjectLlms['own'][number] | null; onClose: () => void; onSaved: () => Promise<void> }) {
    const [f, setF] = useState({ name: llm?.name ?? '', provider: llm?.provider ?? 'local' as 'local' | 'anthropic', baseUrl: llm?.baseUrl ?? '', model: llm?.model ?? '', apiKey: '', thinkingOff: llm?.thinkingOff ?? false, active: llm?.active ?? true });
    const f2 = useAsync();
    return (
      <Modal title={llm ? `LLM: ${llm.name}` : 'Eigenes LLM einbinden'} onClose={onClose}>
        <div className="form">
          <label className="field"><span>Name</span><input type="text" value={f.name} autoFocus onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="z. B. Qwen auf meiner 3090" /></label>
          <label className="field"><span>Anbieter</span><select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value as any })}><option value="local">Lokales LLM (OpenAI-kompatibel: vLLM, Ollama, LM Studio)</option><option value="anthropic">Anthropic</option></select></label>
          {f.provider === 'local' && <label className="field"><span>Adresse der API</span><input type="url" value={f.baseUrl} placeholder="http://llm.intern:8000/v1" onChange={(e) => setF({ ...f, baseUrl: e.target.value })} /></label>}
          <label className="field"><span>Modell</span><input type="text" value={f.model} placeholder={f.provider === 'local' ? 'z. B. Qwen/Qwen3-32B' : 'claude-sonnet-5-5'} onChange={(e) => setF({ ...f, model: e.target.value })} /></label>
          <label className="field"><span>Schlüssel{llm?.hasKey ? ' · gesetzt, leer = unverändert' : f.provider === 'local' ? ' (optional)' : ''}</span><input type="password" autoComplete="new-password" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} /></label>
          {f.provider === 'local' && <label className="check"><input type="checkbox" checked={f.thinkingOff} onChange={(e) => setF({ ...f, thinkingOff: e.target.checked })} /> Denkmodus aus</label>}
          {llm && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> aktiv</label>}
          {f2.error && <div className="error">{f2.error}</div>}
          <div className="row"><button className="btn primary" disabled={f2.busy || !f.name.trim() || !f.model.trim() || (f.provider === 'local' && !f.baseUrl)} onClick={() => void f2.run(async () => { const body = { name: f.name, provider: f.provider, baseUrl: f.provider === 'local' ? f.baseUrl : null, model: f.model, apiKey: f.apiKey || undefined, thinkingOff: f.provider === 'local' && f.thinkingOff, ...(llm ? { active: f.active } : {}) }; if (llm) await api.patch(`${base}/${llm.id}`, body); else await api.post(base, body); await onSaved(); })}>{llm ? 'Speichern' : 'Einbinden'}</button><button className="btn" onClick={onClose}>Abbrechen</button></div>
        </div>
      </Modal>
    );
  }
}

/** Eigene KI-Agenten des Projekts: legt die PL an (wenn der Mandant es erlaubt), nur hier einsetzbar, nur freigegebene KI-Profile. */
function ProjectAgentsCard({ embedded = false }: { embedded?: boolean }) {
  const { detail, reload } = useProject();
  const d = useData<{ agents: AgentUser[]; policy: { enabled: boolean; maxBudget: number; profiles: { id: string; name: string }[] }; canManage: boolean; manageReason?: string | null }>(`/projects/${detail.project.id}/agents`);
  const [edit, setEdit] = useState<AgentUser | 'new' | null>(null);
  const isPl = detail.project.myMembership.role === 'pl';
  // Für die PL immer sichtbar: ohne Freigabe (KI-Freigaben, Regel „Eigene Agenten der PL“) mit Begründung statt ohne Knopf
  if (!d.data || (!isPl && d.data.agents.length === 0)) return null;
  const { agents, policy, canManage } = d.data;
  return (
    <div className={embedded ? 'mt' : 'card'} id="agenten">
      <div className="row between mb">{embedded ? <h3 style={{ margin: 0 }}>Eigene KI-Agenten</h3> : <h2 style={{ margin: 0 }}>Eigene KI-Agenten</h2>}{isPl && <button className="btn primary sm" disabled={!canManage} title={d.data.manageReason ?? undefined} onClick={() => setEdit('new')}>Agent anlegen</button>}</div>
      {isPl && !canManage && d.data.manageReason && <div className="notice small mb">{d.data.manageReason}</div>}
      <p className="muted small">Agenten nur für dieses Projekt. Sie arbeiten wie andere Agenten (Zuständigkeit, Planung, Mail-Vorschläge), auf einem im Projekt verfügbaren LLM und mit höchstens {policy.maxBudget} Läufen am Tag. Der Org-Admin sieht sie und kann sie deaktivieren, aber keine Inhalte.</p>
      {agents.length === 0 ? <div className="empty">Noch keiner.</div> : <table className="table"><tbody>
        {agents.map((a) => <tr key={a.id} style={a.active ? undefined : { opacity: 0.6 }}><td>{a.name}{!a.active && <span className="badge" style={{ marginLeft: 6 }}>deaktiviert</span>}<div className="muted small">{a.persona ?? 'Standardstil'}</div></td><td className="small">{policy.profiles.find((p) => p.id === a.aiProfileId)?.name ?? '–'} · {a.dailyBudget ?? policy.maxBudget}/Tag</td><td className="small">{a.runs} Läufe</td><td>{canManage && <button className="btn sm link" onClick={() => setEdit(a)}>Bearbeiten</button>}</td></tr>)}
      </tbody></table>}
      {edit && <AgentForm agent={edit === 'new' ? null : edit} policy={policy} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await d.reload(); await reload(); }} />}
    </div>
  );

  function AgentForm({ agent, policy, onClose, onSaved }: { agent: AgentUser | null; policy: { maxBudget: number; profiles: { id: string; name: string }[] }; onClose: () => void; onSaved: () => Promise<void> }) {
    const [f, setF] = useState({ name: agent?.name ?? '', persona: agent?.persona ?? '', signature: agent?.signature ?? '', aiProfileId: agent?.aiProfileId ?? policy.profiles[0]?.id ?? '', dailyBudget: agent?.dailyBudget ?? policy.maxBudget, role: 'member' as 'member' | 'pl', thinkingMode: agent?.thinkingMode ?? null, agentCanMail: false });
    const { busy, error, run } = useAsync();
    const body = { name: f.name, persona: f.persona || null, signature: f.signature || null, aiProfileId: f.aiProfileId || null, dailyBudget: f.dailyBudget, thinkingMode: f.thinkingMode };
    return (
      <Modal title={agent ? `Agent: ${agent.name}` : 'Agent anlegen'} onClose={onClose}>
        <div className="form">
          <label className="field"><span>Name</span><input type="text" value={f.name} maxLength={80} autoFocus onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="z. B. Morton" /></label>
          <label className="field"><span>Persona (Schreibstil, eine Zeile)</span><input type="text" value={f.persona} maxLength={300} onChange={(e) => setF({ ...f, persona: e.target.value })} placeholder="z. B. freundlich, knapp, duzt" /></label>
          <label className="field"><span>Unterschrift für Mails (frei; leer = „Name (KI-Agent, Projekt KEY)“)</span><textarea rows={3} maxLength={500} value={f.signature} onChange={(e) => setF({ ...f, signature: e.target.value })} /></label>
          <div className="grid cols-2">
            <label className="field"><span>LLM (im Projekt verfügbar)</span><select value={f.aiProfileId} onChange={(e) => setF({ ...f, aiProfileId: e.target.value })}>{policy.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label className="field"><span>Tagesbudget (höchstens {policy.maxBudget})</span><input type="number" min={0} max={policy.maxBudget} value={f.dailyBudget} onChange={(e) => setF({ ...f, dailyBudget: Number(e.target.value) })} /></label>
          </div>
          <label className="field"><span>Denkmodus</span><select value={f.thinkingMode ?? ''} onChange={(e) => setF({ ...f, thinkingMode: (e.target.value || null) as any })}><option value="">wie Profil</option><option value="off">aus</option><option value="on">an</option></select></label>
          {!agent && <>
            <label className="field"><span>Rolle im Projekt</span><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as any })}><option value="member">Mitglied</option><option value="pl">Stellvertretende PL (plant im ganzen Projekt)</option></select></label>
            <label className="check"><input type="checkbox" checked={f.agentCanMail} onChange={(e) => setF({ ...f, agentCanMail: e.target.checked })} /> darf Mails über das Projektkonto senden (sonst Entwürfe zur Freigabe)</label>
          </>}
          {policy.profiles.length === 0 && <div className="notice small">Im Projekt ist kein LLM verfügbar: Freigabe durch den Org-Admin oder eigenes LLM einbinden.</div>}
          {error && <div className="error">{error}</div>}
          <div className="row">
            <button className="btn primary" disabled={busy || !f.name.trim() || !f.aiProfileId} onClick={() => void run(async () => { if (agent) await api.patch(`/projects/${detail.project.id}/agents/${agent.id}`, body); else await api.post(`/projects/${detail.project.id}/agents`, { ...body, role: f.role, agentCanMail: f.agentCanMail }); await onSaved(); })}>{agent ? 'Speichern' : 'Anlegen'}</button>
            {agent && <button className="btn" disabled={busy} onClick={() => void run(async () => { await api.patch(`/projects/${detail.project.id}/agents/${agent.id}`, { active: !agent.active }); await onSaved(); })}>{agent.active ? 'Deaktivieren' : 'Aktivieren'}</button>}
            <button className="btn" onClick={onClose}>Abbrechen</button>
          </div>
        </div>
      </Modal>
    );
  }
}
