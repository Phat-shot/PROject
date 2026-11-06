import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { milestoneState } from '@projekttool/shared';
import { api, fmtDate, fmtDateTime } from '../../lib/api';
import { Button, IconButton, Modal, useAsync, useDialog } from '../../components/ui';
import { IconLock, IconX } from '../../components/icons';
import { useProject, type Milestone } from '../ProjectPage';
import { InlineText } from './TaskDrawer';
import { useCreate } from './create';
import { InlineCreate } from './BoardView';
import { DateInput } from '../../components/DateInput';

/** Teilprojekte und Meilensteine als Listen; bearbeitet wird in der Maske des Teilprojekts. Plan und Einstellungen gleich. */

export function useMembers() {
  const { detail, users } = useProject();
  return users.filter((u) => detail.members.some((m) => m.userId === u.id));
}

/** Rückfrage, ob direkt zugewiesene Arbeitspakete bei einem Wechsel der Verantwortung mitgehen; null = abgebrochen. */
export function useTransferQuestion() {
  const dialog = useDialog();
  return (count: number, from: string, to: string) =>
    dialog.choose<boolean>({ title: 'Direkt zugewiesene Arbeitspakete', text: `${count} Arbeitspaket(e) sind ${from} direkt zugewiesen. Auch an ${to} übertragen? Geerbte Zuständigkeiten wechseln in jedem Fall.`, options: [{ label: 'Mit übertragen', value: true, primary: true }, { label: 'Nur geerbte wechseln', value: false }] });
}

/**
 * Teilprojekte als kompakte Liste: Name, Verantwortung, Zeitraum, offene Arbeitspakete; Klick öffnet die Maske des
 * Teilprojekts (dort Felder, Beschreibung, Sichtbarkeit, Meilensteine, Arbeitspakete). Im Plan und in den Einstellungen gleich.
 */
export function SubprojectList() {
  const { detail, tasks, openSubproject } = useProject();
  const me = detail.project.myMembership;
  const canPlan = me.role === 'pl' || me.canEditPlan;
  const create = useCreate();
  const [adding, setAdding] = useState(false);
  const openOf = (id: string) => tasks.filter((x) => x.subprojectId === id && !x.parentId && !x.done && !x.archivedAt && !x.deletedAt).length;
  return (
    <>
      <div className="stack list-tight">
        {detail.subprojects.map((s) => (
          <button key={s.id} className="list-row" onClick={() => openSubproject(s.id)} title="Teilprojekt öffnen">
            <span className="grow"><strong>{s.name}</strong>{s.restricted && <span title="Eingeschränkt sichtbar"> <IconLock size={12} /><span className="sr-only">eingeschränkt sichtbar</span></span>}{s.description && <span className="muted small"> · {s.description.length > 80 ? `${s.description.slice(0, 80)} …` : s.description}</span>}</span>
            <span className="muted small">{s.responsible.name ?? '–'}{s.responsible.inherited ? ' (PL)' : ''}</span>
            <span className="muted small nowrap">{s.startDate || s.endDate ? `${fmtDate(s.startDate)} – ${fmtDate(s.endDate)}` : 'ohne Zeitraum'}</span>
            <span className="badge" title="offene Arbeitspakete">{openOf(s.id)}</span>
          </button>
        ))}
        {detail.subprojects.length === 0 && <p className="muted small">Noch keine Teilprojekte. Arbeitspakete stehen dann unter „Ohne Teilprojekt“.</p>}
      </div>
      {canPlan && <div className="mt"><InlineCreate open={adding} onOpen={() => setAdding(true)} onClose={() => setAdding(false)} label="+ Teilprojekt" placeholder="Name des Teilprojekts, Enter zum Anlegen" onCreate={(name) => create.subproject(name)} /></div>}
    </>
  );
}

/** Meilensteine nach Datum; Status (offen, bereit, erreicht) mit Bestätigen, Bearbeiten öffnet das Formular mit der AP-Auswahl. */
export function MilestoneList({ subprojectId }: { /** nur Meilensteine dieses Teilprojekts */ subprojectId?: string } = {}) {
  const { detail, reload, openSubproject } = useProject();
  const me = detail.project.myMembership;
  const canPlan = me.role === 'pl' || me.canEditPlan;
  const dialog = useDialog();
  const create = useCreate();
  const [edit, setEdit] = useState<Milestone | null>(null);
  const { error, run } = useAsync({ toast: true });
  const save = (m: Milestone, body: Record<string, unknown>) => run(async () => { await api.patch(`/projects/${detail.project.id}/milestones/${m.id}`, body); await reload(); });
  const remove = (m: Milestone) => void dialog.confirm({ title: 'Meilenstein löschen', text: `„${m.name}“ (${fmtDate(m.date)}) löschen?`, confirmLabel: 'Löschen', danger: true })
    .then((ok) => { if (ok) void run(async () => { await api.del(`/projects/${detail.project.id}/milestones/${m.id}`); await reload(); }); });
  // Plan-Link aus der Meldung „Meilenstein erreicht?“ (?ms=) öffnet das Formular
  const [params, setParams] = useSearchParams();
  const msParam = params.get('ms');
  useEffect(() => {
    if (!msParam || subprojectId) return;
    const m = detail.milestones.find((x) => x.id === msParam);
    if (m) setEdit(m);
    const next = new URLSearchParams(params); next.delete('ms'); setParams(next, { replace: true });
  }, [msParam]);
  const list = [...detail.milestones].filter((m) => !subprojectId || m.subprojectId === subprojectId).sort((a, b) => a.date.localeCompare(b.date));
  const t0 = new Date().toISOString().slice(0, 10);
  return (
    <>
      {error && <div className="error mb" role="alert">{error}</div>}
      <div className="stack list-tight">
        {list.map((m) => {
          const sp = detail.subprojects.find((s) => s.id === m.subprojectId);
          const st = milestoneState(m, t0);
          return (
            <div key={m.id} className={`list-row static ms-row ms-${st}`}>
              <span className={`ms-diamond ${m.reachedAt ? 'reached' : ''}`} aria-hidden="true" />
              <span className="grow">{canPlan ? <InlineText value={m.name} canEdit onSave={(name) => void save(m, { name })} /> : m.name}</span>
              <MilestoneStatus m={m} canPlan={canPlan} onSet={(reached) => void save(m, { reached })} />
              {canPlan ? <DateInput className="inline-date" aria-label={`Datum von ${m.name}`} value={m.date} onChange={(v) => { if (v) void save(m, { date: v }); }} /> : <span className="small nowrap">{fmtDate(m.date)}</span>}
              {!subprojectId && (canPlan ? <select className="inline-select" aria-label="Teilprojekt" value={m.subprojectId ?? ''} onChange={(e) => void save(m, { subprojectId: e.target.value || null })}><option value="">– Projekt –</option>{detail.subprojects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
                : sp ? <button className="btn sm link" onClick={() => openSubproject(sp.id)}>{sp.name}</button> : <span className="muted small">Projekt</span>)}
              <button className="btn sm link" title="Name, Datum, Status und verknüpfte Arbeitspakete" onClick={() => setEdit(m)}>{canPlan ? 'Bearbeiten' : 'Details'}</button>
              {canPlan && <IconButton label="Meilenstein löschen" size="sm" variant="link" onClick={() => remove(m)}><IconX /></IconButton>}
            </div>
          );
        })}
        {list.length === 0 && <p className="muted small">Noch keine Meilensteine.</p>}
      </div>
      {canPlan && <button className="btn sm link mt" onClick={() => void create.milestone(subprojectId)}>+ Meilenstein</button>}
      {edit && <MilestoneForm milestone={detail.milestones.find((x) => x.id === edit.id) ?? edit} onClose={() => setEdit(null)} />}
    </>
  );
}

/** Status-Chip eines Meilensteins: erreicht (mit Datum, wieder öffnen), bereit (alle APs erledigt: bestätigen), x/y Arbeitspakete. */
export function MilestoneStatus({ m, canPlan, onSet }: { m: Milestone; canPlan: boolean; onSet: (reached: boolean) => void }) {
  if (m.reachedAt) {
    const who = m.reachedBy?.name ? ` von ${m.reachedBy.name}` : ' (automatisch)';
    return <span className="row gap-1 nowrap"><span className="badge ok" title={`Erreicht am ${fmtDateTime(m.reachedAt)}${who}`}>erreicht {fmtDate(m.reachedAt.slice(0, 10))}</span>{canPlan && <button className="btn sm link" onClick={() => onSet(false)}>wieder öffnen</button>}</span>;
  }
  const total = m.tasksTotal ?? 0;
  const ready = total > 0 && m.tasksDone === total;
  return <span className="row gap-1 nowrap">
    {total > 0 && <span className={`badge ${ready ? 'warn' : ''}`} title="verknüpfte Arbeitspakete erledigt / gesamt">{m.tasksDone ?? 0}/{total} AP</span>}
    {canPlan && <button className={`btn sm ${ready ? 'primary' : 'link'}`} title={ready ? 'Alle verknüpften Arbeitspakete sind erledigt' : 'Meilenstein als erreicht markieren'} onClick={() => onSet(true)}>{ready ? 'Erreicht bestätigen' : 'erreicht'}</button>}
  </span>;
}

/** Meilenstein bearbeiten: Name, Datum, Teilprojekt, Status und verknüpfte Arbeitspakete (Suche nach Titel oder Kennung). */
export function MilestoneForm({ milestone, onClose }: { milestone: Milestone; onClose: () => void }) {
  const { detail, tasks, reload, reloadTasks } = useProject();
  const me = detail.project.myMembership;
  const canPlan = me.role === 'pl' || me.canEditPlan;
  const [f, setF] = useState({ name: milestone.name, date: milestone.date, subprojectId: milestone.subprojectId ?? '', reached: Boolean(milestone.reachedAt), taskIds: milestone.taskIds ?? [] });
  const [q, setQ] = useState('');
  const { busy, error, run } = useAsync();
  const key = detail.project.key;
  const sel = new Set(f.taskIds);
  const needle = q.trim().toLowerCase();
  const aps = tasks.filter((t) => !t.parentId && !t.deletedAt && (sel.has(t.id) || ((!t.archivedAt) && (!needle || t.title.toLowerCase().includes(needle) || `${key}-${t.number}`.toLowerCase().includes(needle)))))
    .sort((a, b) => Number(sel.has(b.id)) - Number(sel.has(a.id)) || a.number - b.number);
  const dirty = f.name !== milestone.name || f.date !== milestone.date || f.subprojectId !== (milestone.subprojectId ?? '') || f.reached !== Boolean(milestone.reachedAt) || JSON.stringify([...f.taskIds].sort()) !== JSON.stringify([...(milestone.taskIds ?? [])].sort());
  const toggle = (id: string) => setF({ ...f, taskIds: sel.has(id) ? f.taskIds.filter((x) => x !== id) : [...f.taskIds, id] });
  const doneN = f.taskIds.filter((id) => tasks.find((t) => t.id === id)?.done).length;
  return (
    <Modal title={`Meilenstein: ${milestone.name}`} onClose={onClose} dirty={dirty} wide>
      <div className="form cols-2">
        <label className="field"><span className="req">Name</span><input type="text" value={f.name} disabled={!canPlan} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="field"><span className="req">Datum</span><DateInput value={f.date} required disabled={!canPlan} showWeek onChange={(v) => setF({ ...f, date: v || f.date })} /></label>
        <label className="field"><span>Teilprojekt</span><select value={f.subprojectId} disabled={!canPlan} onChange={(e) => setF({ ...f, subprojectId: e.target.value })}><option value="">– Projekt –</option>{detail.subprojects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <div className="field"><span>Status</span>
          <label className="check"><input type="checkbox" checked={f.reached} disabled={!canPlan} onChange={(e) => setF({ ...f, reached: e.target.checked })} /> erreicht</label>
          {milestone.reachedAt && <span className="muted small">seit {fmtDateTime(milestone.reachedAt)}{milestone.reachedBy?.name ? ` · ${milestone.reachedBy.name}` : ' · automatisch'}</span>}
          {!milestone.reachedAt && milestone.reachSuggestedAt && <span className="small text-warn">Alle verknüpften Arbeitspakete sind erledigt: bitte bestätigen.</span>}
        </div>
      </div>
      <div className="field full mt"><span>Arbeitspakete zu diesem Meilenstein <span className="muted">· {f.taskIds.length} gewählt{f.taskIds.length ? `, ${doneN} erledigt` : ''}</span></span>
        <div className="pred-picker">
          <input type="text" placeholder="Titel oder Kennung suchen …" aria-label="Arbeitspakete suchen" value={q} onChange={(e) => setQ(e.target.value)} disabled={!canPlan} />
          <div className="list">
            {aps.length === 0 && <div className="muted small">Keine Treffer.</div>}
            {aps.map((t) => <label key={t.id} className={`check small ${sel.has(t.id) ? 'on' : ''}`}><input type="checkbox" checked={sel.has(t.id)} disabled={!canPlan} onChange={() => toggle(t.id)} /> <span className="tkey">{key}-{t.number}</span> {t.title}{t.done ? <span className="badge ok ml-1">erledigt</span> : t.dueDate ? <span className="muted"> · bis {fmtDate(t.dueDate)}</span> : null}</label>)}
          </div>
        </div>
        <span className="muted small">Sind alle gewählten Arbeitspakete erledigt, schlägt der Meilenstein „erreicht“ vor{detail.project.milestoneAutoReach ? ' (Projekteinstellung: wird automatisch erreicht)' : '; die PL bestätigt'}.</span>
      </div>
      {error && <div className="error mt" role="alert">{error}</div>}
      <div className="row mt">
        {canPlan && <Button variant="primary" loading={busy} disabled={!dirty || !f.name.trim() || !f.date} onClick={() => void run(async () => {
          await api.patch(`/projects/${detail.project.id}/milestones/${milestone.id}`, { name: f.name.trim(), date: f.date, subprojectId: f.subprojectId || null, taskIds: f.taskIds, ...(f.reached !== Boolean(milestone.reachedAt) ? { reached: f.reached } : {}) });
          await reload(); await reloadTasks(); onClose();
        })}>Speichern</Button>}
        <Button onClick={onClose}>{canPlan ? 'Abbrechen' : 'Schließen'}</Button>
      </div>
    </Modal>
  );
}
