import { useState } from 'react';
import { api } from '../../../lib/api';
import { Modal, roleLabel, useAsync, useDialog } from '../../../components/ui';
import { InviteCard } from '../InviteCard';
import type { Group, ProjectGroup } from '@projekttool/shared';
import { useProject, type MemberRow } from '../../ProjectPage';
import { useData } from '../../../lib/useData';
import { useProjectPolicy } from '../../../lib/useProjectPolicy';

/** Einzelrechte als Text (PL hat alle). */
export const rightsText = (m: { canEditPlan: boolean; canApprove: boolean; canFinalize: boolean; canUseAi: boolean }) =>
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
