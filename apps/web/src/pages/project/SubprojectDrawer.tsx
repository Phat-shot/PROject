import { useState } from 'react';
import type { Group, Subproject } from '@projekttool/shared';
import { api, fmtDate, today } from '../../lib/api';
import { useData } from '../../lib/useData';
import { Drawer, Initials, useAsync, useDialog } from '../../components/ui';
import { useProject } from '../ProjectPage';
import { InlineText, TextArea } from './TaskDrawer';
import { CopyMoveDialog } from './CopyMove';
import { MilestoneList, useMembers, useTransferQuestion } from './planForms';
import { useCreate } from './create';
import { InlineCreate } from './BoardView';
import { IconLock, IconX } from '../../components/icons';
import { DateInput } from '../../components/DateInput';

/**
 * Maske eines Teilprojekts, aufgebaut wie die des Arbeitspakets: Kopf mit Name und Aktionen, Felder (Verantwortung, Zeitraum),
 * Beschreibung, Sichtbarkeit (PL), Meilensteine und Arbeitspakete. Geöffnet aus dem Swimlane-Kopf im Board, der Zeile im Plan
 * und den Projekteinstellungen (?sp=).
 */
export function SubprojectDrawer({ subprojectId, onClose }: { subprojectId: string; onClose: () => void }) {
  const { detail, tasks, reload, reloadTasks, openTask } = useProject();
  const dialog = useDialog();
  const askTransfer = useTransferQuestion();
  const members = useMembers();
  const create = useCreate();
  const { busy, error, run } = useAsync();
  const [copyMove, setCopyMove] = useState<'copy' | 'move' | null>(null);
  const [adding, setAdding] = useState(false);
  const s = detail.subprojects.find((x) => x.id === subprojectId);
  const me = detail.project.myMembership;
  const isPl = me.role === 'pl';
  const canPlan = isPl || me.canEditPlan;
  if (!s) return <Drawer title="Teilprojekt" onClose={onClose}><div className="muted">Teilprojekt nicht gefunden oder nicht sichtbar.</div></Drawer>;

  const pid = detail.project.id;
  const save = (body: Record<string, unknown>) => run(async () => {
    if ('responsibleUserId' in body) {
      const direct = tasks.filter((x) => x.subprojectId === s.id && !x.done && x.responsibleUserId && x.responsibleUserId === s.responsible.userId);
      const newName = members.find((u) => u.id === body.responsibleUserId)?.name ?? 'den PL';
      if (direct.length > 0) { const v = await askTransfer(direct.length, s.responsible.name ?? 'der bisherigen Verantwortung', newName); if (v === null) return; body.transferTasks = v; }
    }
    await api.patch(`/projects/${pid}/subprojects/${s.id}`, body);
    await reload(); await reloadTasks();
  });
  const aps = tasks.filter((x) => x.subprojectId === s.id && !x.parentId && !x.archivedAt && !x.deletedAt).sort((a, b) => Number(a.done) - Number(b.done) || (a.dueDate ?? '9').localeCompare(b.dueDate ?? '9'));
  const open = aps.filter((x) => !x.done);
  const overdue = open.filter((x) => x.dueDate && x.dueDate < today()).length;
  const colName = (id: string) => detail.columns.find((c) => c.id === id)?.name ?? '';
  // Mit Haken gehen die Arbeitspakete samt Aufgaben in den Papierkorb (wiederherstellbar), sonst stehen sie unter „Ohne Teilprojekt“
  const remove = () => void dialog.form({ title: 'Teilprojekt löschen', text: `„${s.name}“ löschen? Ohne Haken bleiben die Arbeitspakete erhalten und stehen danach unter „Ohne Teilprojekt“.`, submitLabel: 'Löschen', danger: true,
    fields: aps.length ? [{ key: 'tasks', type: 'checkbox', label: `Auch die ${aps.length} zugeordneten Arbeitspakete löschen (mit Aufgaben, in den Papierkorb)` }] : [] })
    .then((v) => { if (v) void run(async () => { await api.del(`/projects/${pid}/subprojects/${s.id}${v.tasks === '1' ? '?tasks=delete' : ''}`); await reload(); await reloadTasks(); onClose(); }); });

  return (
    <Drawer onClose={onClose}
      title={<span className="row gap-2"><span className="badge" title="Teilprojekt">TP</span>{canPlan ? <InlineText value={s.name} canEdit onSave={(name) => name.trim() && save({ name: name.trim() })} /> : s.name}{s.restricted && <span title="Eingeschränkt sichtbar"><IconLock size={12} /></span>}</span>}
      actions={canPlan ? <>
        <button className="btn sm" title="Teilprojekt mit Arbeitspaketen kopieren, hier oder in ein anderes Projekt" onClick={() => setCopyMove('copy')}>Kopieren</button>
        <button className="btn sm" title="In ein anderes Projekt verschieben" onClick={() => setCopyMove('move')}>Verschieben</button>
        {isPl && <button className="btn sm danger" onClick={remove}>Löschen</button>}
      </> : undefined}>
      {error && <div className="error mb">{error}</div>}
      <div className="row small mb gap-2 wrap">
        <span className="badge">{open.length} offen</span><span className="badge">{aps.length - open.length} erledigt</span>{overdue > 0 && <span className="badge warn">{overdue} überfällig</span>}
      </div>
      <div className="form cols-3">
        <label className="field"><span>Verantwortlich</span>
          <select value={s.responsibleUserId ?? ''} disabled={!canPlan || busy} onChange={(e) => void save({ responsibleUserId: e.target.value || null })}>
            <option value="">{s.responsible.inherited ? `${s.responsible.name ?? 'PL'} (geerbt vom PL)` : '– geerbt vom PL –'}</option>
            {members.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select></label>
        <label className="field"><span>Start</span><DateInput value={s.startDate ?? ''} disabled={!canPlan || busy} onChange={(v) => void save({ startDate: v || null })} /></label>
        <label className="field"><span>Ende</span><DateInput value={s.endDate ?? ''} disabled={!canPlan || busy} onChange={(v) => void save({ endDate: v || null })} /></label>
      </div>
      <TextArea label="Beschreibung (Ziel, Abgrenzung)" value={s.description ?? ''} canEdit={canPlan} empty="Keine Beschreibung. Ziel und Abgrenzung helfen dem Team und den Agenten bei der Zuordnung." onSave={async (description) => { await save({ description: description || null }); }} />
      <Visibility s={s} isPl={isPl} onSave={save} />

      <h3 className="mt">Meilensteine</h3>
      <MilestoneList subprojectId={s.id} />

      <h3 className="mt">Arbeitspakete <span className="count">{open.length}/{aps.length}</span></h3>
      {aps.length === 0 && <p className="muted small">Noch keine.</p>}
      <div className="stack gap-1">
        {aps.map((x) => (
          <div key={x.id} className="row gap-1 items-center">
            <button className={`list-row grow ${x.done ? 'is-done' : ''}`} onClick={() => openTask(x.id)}>
              <span className="tkey">{detail.project.key}-{x.number}</span>
              <span className="grow">{x.title}</span>
              <span className="muted small">{colName(x.columnId)}</span>
              {x.dueDate && <span className={`small ${!x.done && x.dueDate < today() ? 'overdue' : 'muted'}`}>{fmtDate(x.dueDate)}</span>}
              {x.responsible.name && <Initials name={x.responsible.name} />}
            </button>
            {me.role !== 'reader' && <select className="inline-select" value={s.id} title="Einem anderen Teilprojekt zuordnen" aria-label={`Teilprojekt von ${detail.project.key}-${x.number}`} disabled={busy}
              onChange={(e) => void run(async () => { await api.post(`/tasks/${x.id}/reparent`, { parentId: null, subprojectId: e.target.value || null }); await reloadTasks(); })}>
              <option value="">– keines –</option>{detail.subprojects.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>}
          </div>
        ))}
      </div>
      {me.role !== 'reader' && <div className="mt"><InlineCreate open={adding} onOpen={() => setAdding(true)} onClose={() => setAdding(false)} label="+ Arbeitspaket" placeholder="Titel eingeben, Enter zum Anlegen" onCreate={(title) => create.task({ title, subprojectId: s.id })} /></div>}
      {copyMove && <CopyMoveDialog kind="subproject" op={copyMove} detail={detail} subproject={s} tasks={aps} onClose={() => setCopyMove(null)} onDone={async () => { await reload(); await reloadTasks(); }} />}
    </Drawer>
  );
}

/** Sichtbarkeit: eingeschränkt (nur PL, Verantwortliche und benannte Benutzer und Gruppen); ändern nur die PL, sofort gespeichert. */
function Visibility({ s, isPl, onSave }: { s: Subproject; isPl: boolean; onSave: (b: Record<string, unknown>) => unknown }) {
  const members = useMembers();
  const groups = useData<{ groups: Group[] }>(isPl ? '/groups' : null);
  if (!isPl) return <p className="muted small mt">{s.restricted ? <><IconLock size={12} /> Eingeschränkt sichtbar (PL, Verantwortliche und benannte Personen und Gruppen).</> : 'Für alle Projektmitglieder sichtbar.'}</p>;
  const toggle = (k: 'accessUserIds' | 'accessGroupIds', id: string) => onSave({ [k]: s[k].includes(id) ? s[k].filter((x) => x !== id) : [...s[k], id] });
  return (
    <div className="mt stack gap-1">
      <label className="check"><input type="checkbox" checked={s.restricted} onChange={(e) => onSave({ restricted: e.target.checked })} /> Eingeschränkt sichtbar <span className="muted small">(nur PL, Verantwortliche und die hier benannten Benutzer und Gruppen)</span></label>
      {s.restricted && <div className="grid cols-2">
        <div className="field"><span>Benutzer</span><div className="stack gap-1">{members.map((u) => <label key={u.id} className="check small"><input type="checkbox" checked={s.accessUserIds.includes(u.id)} onChange={() => toggle('accessUserIds', u.id)} /> {u.name}</label>)}</div></div>
        <div className="field"><span>Gruppen</span><div className="stack gap-1">{(groups.data?.groups ?? []).map((g) => <label key={g.id} className="check small"><input type="checkbox" checked={s.accessGroupIds.includes(g.id)} onChange={() => toggle('accessGroupIds', g.id)} /> {g.name}</label>)}{groups.data && groups.data.groups.length === 0 && <span className="muted small">Keine Gruppen.</span>}</div></div>
      </div>}
    </div>
  );
}
