import { useState } from 'react';
import type { Group, Subproject } from '@projekttool/shared';
import { api, fmtDate } from '../../lib/api';
import { useData } from '../../lib/useData';
import { Modal, useAsync, useDialog } from '../../components/ui';
import { useProject, type Milestone } from '../ProjectPage';
import { InlineText } from './TaskDrawer';

/**
 * Teilprojekte und Meilensteine: Tabellen mit Inline-Bearbeitung und Formulare.
 * Werden im Plan und in den Projekteinstellungen gleich verwendet.
 */

function useMembers() {
  const { detail, users } = useProject();
  return users.filter((u) => detail.members.some((m) => m.userId === u.id));
}

/** Rückfrage, ob direkt zugewiesene Arbeitspakete bei einem Wechsel der Verantwortung mitgehen; null = abgebrochen. */
export function useTransferQuestion() {
  const dialog = useDialog();
  return (count: number, from: string, to: string) =>
    dialog.choose<boolean>({ title: 'Direkt zugewiesene Arbeitspakete', text: `${count} Arbeitspaket(e) sind ${from} direkt zugewiesen. Auch an ${to} übertragen? Geerbte Zuständigkeiten wechseln in jedem Fall.`, options: [{ label: 'Mit übertragen', value: true, primary: true }, { label: 'Nur geerbte wechseln', value: false }] });
}

export function SubprojectsTable() {
  const { detail } = useProject();
  const me = detail.project.myMembership;
  const canPlan = me.role === 'pl' || me.canEditPlan;
  const [newSp, setNewSp] = useState(false);
  return (
    <>
      <table className="table"><thead><tr><th>Name</th><th>Verantwortlich</th><th>Zeitraum</th><th /></tr></thead><tbody>
        {detail.subprojects.map((s) => <SubRow key={s.id} s={s} canPlan={canPlan} />)}
        {detail.subprojects.length === 0 && <tr><td colSpan={4} className="muted small">Noch keine Teilprojekte. Arbeitspakete stehen dann unter „Ohne Teilprojekt“.</td></tr>}
      </tbody></table>
      {canPlan && <button className="btn sm mt" onClick={() => setNewSp(true)}>+ Teilprojekt</button>}
      {newSp && <SubprojectForm onClose={() => setNewSp(false)} />}
    </>
  );
}

function SubRow({ s, canPlan }: { s: Subproject; canPlan: boolean }) {
  const { detail, tasks, reload, reloadTasks } = useProject();
  const me = detail.project.myMembership;
  const dialog = useDialog();
  const askTransfer = useTransferQuestion();
  const members = useMembers();
  const [edit, setEdit] = useState(false);
  const save = async (body: Record<string, unknown>) => {
    if ('responsibleUserId' in body) {
      const direct = tasks.filter((x) => x.subprojectId === s.id && !x.done && x.responsibleUserId && x.responsibleUserId === s.responsible.userId);
      const newName = members.find((u) => u.id === body.responsibleUserId)?.name ?? 'den PL';
      if (direct.length > 0) { const v = await askTransfer(direct.length, s.responsible.name ?? 'der bisherigen Verantwortung', newName); if (v === null) return; body.transferTasks = v; }
    }
    await api.patch(`/projects/${detail.project.id}/subprojects/${s.id}`, body); await reload(); await reloadTasks();
  };
  if (!canPlan) {
    return (
      <tr>
        <td>{s.name}{s.restricted && <span className="badge" title="Eingeschränkt sichtbar" style={{ marginLeft: 6 }}>🔒</span>}</td>
        <td>{s.responsible.name ?? '–'}{s.responsible.inherited && <span className="muted small"> (geerbt vom PL)</span>}</td>
        <td className="nowrap">{fmtDate(s.startDate)} – {fmtDate(s.endDate)}</td><td />
      </tr>
    );
  }
  return (
    <tr className="inline-row">
      <td><span className="row" style={{ gap: 4 }}><InlineText value={s.name} canEdit onSave={(name) => void save({ name })} />{s.restricted && <span className="badge" title="Eingeschränkt sichtbar">🔒</span>}</span></td>
      <td><select className="inline-select" value={s.responsibleUserId ?? ''} onChange={(e) => void save({ responsibleUserId: e.target.value || null })}><option value="">{s.responsible.inherited ? `${s.responsible.name ?? 'PL'} (geerbt vom PL)` : '– geerbt vom PL –'}</option>{members.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></td>
      <td className="nowrap"><input type="date" className="inline-date" value={s.startDate ?? ''} onChange={(e) => void save({ startDate: e.target.value || null })} /> – <input type="date" className="inline-date" value={s.endDate ?? ''} onChange={(e) => void save({ endDate: e.target.value || null })} /></td>
      <td className="nowrap">
        {me.role === 'pl' && <button className="btn sm link" title="Sichtbarkeit, Zugriff" onClick={() => setEdit(true)}>Sichtbarkeit</button>}
        {me.role === 'pl' && <button className="btn sm link" title="Teilprojekt löschen" onClick={() => void dialog.confirm({ title: 'Teilprojekt löschen', text: `„${s.name}“ löschen? Die Arbeitspakete bleiben erhalten und stehen danach unter „Ohne Teilprojekt“.`, confirmLabel: 'Löschen', danger: true }).then((ok) => { if (ok) void api.del(`/projects/${detail.project.id}/subprojects/${s.id}`).then(async () => { await reload(); await reloadTasks(); }); })}>✕</button>}
        {edit && <SubprojectForm existing={s} onClose={() => setEdit(false)} />}
      </td>
    </tr>
  );
}

export function SubprojectForm({ existing, onClose }: { existing?: Subproject; onClose: () => void }) {
  const { detail, tasks, reload, reloadTasks } = useProject();
  const me = detail.project.myMembership;
  const askTransfer = useTransferQuestion();
  const members = useMembers();
  const [f, setF] = useState({ name: existing?.name ?? '', responsibleUserId: existing?.responsibleUserId ?? '', startDate: existing?.startDate ?? '', endDate: existing?.endDate ?? '', restricted: existing?.restricted ?? false, accessUserIds: existing?.accessUserIds ?? [], accessGroupIds: existing?.accessGroupIds ?? [] });
  const { busy, error, run } = useAsync();
  const groups = useData<{ groups: Group[] }>(me.role === 'pl' ? '/groups' : null);
  const toggle = (k: 'accessUserIds' | 'accessGroupIds', id: string) => setF({ ...f, [k]: f[k].includes(id) ? f[k].filter((x) => x !== id) : [...f[k], id] });
  return (
    <Modal title={existing ? 'Teilprojekt bearbeiten' : 'Neues Teilprojekt'} onClose={onClose}>
      <div className="form cols-2">
        <label className="field full"><span>Name</span><input type="text" value={f.name} autoFocus onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="field full"><span>Verantwortlich (Benutzer oder PL; keine eigene Rolle)</span><select value={f.responsibleUserId} onChange={(e) => setF({ ...f, responsibleUserId: e.target.value })}><option value="">– geerbt vom PL –</option>{members.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        <label className="field"><span>Start</span><input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></label>
        <label className="field"><span>Ende</span><input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></label>
        {me.role === 'pl' && <div className="full stack">
          <label className="check"><input type="checkbox" checked={f.restricted} onChange={(e) => setF({ ...f, restricted: e.target.checked })} /> Eingeschränkt sichtbar: nur PL, Verantwortliche und die hier benannten Benutzer und Gruppen sehen Teilprojekt und Arbeitspakete</label>
          {f.restricted && <div className="grid cols-2">
            <div className="field"><span>Benutzer</span><div className="stack" style={{ gap: 2 }}>{members.map((u) => <label key={u.id} className="check small"><input type="checkbox" checked={f.accessUserIds.includes(u.id)} onChange={() => toggle('accessUserIds', u.id)} /> {u.name}</label>)}</div></div>
            <div className="field"><span>Gruppen</span><div className="stack" style={{ gap: 2 }}>{(groups.data?.groups ?? []).map((g) => <label key={g.id} className="check small"><input type="checkbox" checked={f.accessGroupIds.includes(g.id)} onChange={() => toggle('accessGroupIds', g.id)} /> {g.name} <span className="muted">({g.memberIds.length})</span></label>)}{groups.data && groups.data.groups.length === 0 && <span className="muted small">Keine Gruppen. Der Org-Admin legt sie in der Verwaltung an.</span>}</div></div>
          </div>}
        </div>}
        {error && <div className="error full">{error}</div>}
        <div className="row full"><button className="btn primary" disabled={busy || !f.name} onClick={() => void run(async () => {
          const body: Record<string, unknown> = { name: f.name, responsibleUserId: f.responsibleUserId || null, startDate: f.startDate || null, endDate: f.endDate || null };
          if (me.role === 'pl') { body.restricted = f.restricted; body.accessUserIds = f.accessUserIds; body.accessGroupIds = f.accessGroupIds; }
          if (existing && (f.responsibleUserId || null) !== (existing.responsibleUserId ?? null)) {
            const oldEff = existing.responsible.userId;
            const newName = members.find((u) => u.id === f.responsibleUserId)?.name ?? 'den PL';
            const direct = tasks.filter((x) => x.subprojectId === existing.id && !x.done && x.responsibleUserId && x.responsibleUserId === oldEff);
            if (direct.length > 0) { const v = await askTransfer(direct.length, existing.responsible.name ?? 'der bisherigen Verantwortung', newName); if (v === null) return; body.transferTasks = v; }
          }
          if (existing) await api.patch(`/projects/${detail.project.id}/subprojects/${existing.id}`, body); else await api.post(`/projects/${detail.project.id}/subprojects`, body);
          await reload(); await reloadTasks(); onClose();
        })}>Speichern</button></div>
      </div>
    </Modal>
  );
}

export function MilestonesTable() {
  const { detail, reload } = useProject();
  const me = detail.project.myMembership;
  const canPlan = me.role === 'pl' || me.canEditPlan;
  const dialog = useDialog();
  const [newMs, setNewMs] = useState(false);
  const { error, run } = useAsync();
  const save = (m: Milestone, body: Record<string, unknown>) => run(async () => { await api.patch(`/projects/${detail.project.id}/milestones/${m.id}`, body); await reload(); });
  return (
    <>
      {error && <div className="error mb">{error}</div>}
      <table className="table"><thead><tr><th>Name</th><th>Datum</th><th>Teilprojekt</th><th /></tr></thead><tbody>
        {detail.milestones.map((m) => canPlan ? (
          <tr key={m.id} className="inline-row">
            <td><InlineText value={m.name} canEdit onSave={(name) => void save(m, { name })} /></td>
            <td className="nowrap"><input type="date" className="inline-date" value={m.date} onChange={(e) => { if (e.target.value) void save(m, { date: e.target.value }); }} /></td>
            <td><select className="inline-select" value={m.subprojectId ?? ''} onChange={(e) => void save(m, { subprojectId: e.target.value || null })}><option value="">– keines –</option>{detail.subprojects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></td>
            <td><button className="btn sm link" title="Meilenstein löschen" onClick={() => void dialog.confirm({ title: 'Meilenstein löschen', text: `„${m.name}“ (${fmtDate(m.date)}) löschen?`, confirmLabel: 'Löschen', danger: true }).then((ok) => { if (ok) void api.del(`/projects/${detail.project.id}/milestones/${m.id}`).then(reload); })}>✕</button></td>
          </tr>
        ) : (
          <tr key={m.id}><td>{m.name}</td><td className="nowrap">{fmtDate(m.date)}</td><td className="muted">{detail.subprojects.find((s) => s.id === m.subprojectId)?.name ?? '–'}</td><td /></tr>
        ))}
        {detail.milestones.length === 0 && <tr><td colSpan={4} className="muted small">Noch keine Meilensteine.</td></tr>}
      </tbody></table>
      {canPlan && <button className="btn sm mt" onClick={() => setNewMs(true)}>+ Meilenstein</button>}
      {newMs && <MilestoneForm onClose={() => setNewMs(false)} />}
    </>
  );
}

export function MilestoneForm({ onClose }: { onClose: () => void }) {
  const { detail, reload } = useProject();
  const [f, setF] = useState({ name: '', date: '', subprojectId: '' });
  const { busy, error, run } = useAsync();
  return (
    <Modal title="Neuer Meilenstein" onClose={onClose}>
      <div className="form">
        <label className="field"><span>Name</span><input type="text" value={f.name} autoFocus onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="field"><span>Datum</span><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
        <label className="field"><span>Teilprojekt</span><select value={f.subprojectId} onChange={(e) => setF({ ...f, subprojectId: e.target.value })}><option value="">– keines –</option>{detail.subprojects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        {error && <div className="error">{error}</div>}
        <div><button className="btn primary" disabled={busy || !f.name || !f.date} onClick={() => void run(async () => { await api.post(`/projects/${detail.project.id}/milestones`, { name: f.name, date: f.date, subprojectId: f.subprojectId || null }); await reload(); onClose(); })}>Anlegen</button></div>
      </div>
    </Modal>
  );
}
