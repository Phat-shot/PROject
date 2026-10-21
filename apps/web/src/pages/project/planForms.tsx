import { useState } from 'react';
import { api, fmtDate } from '../../lib/api';
import { useAsync, useDialog } from '../../components/ui';
import { useProject, type Milestone } from '../ProjectPage';
import { InlineText } from './TaskDrawer';
import { useCreate } from './create';
import { InlineCreate } from './BoardView';

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
      <div className="stack" style={{ gap: 2 }}>
        {detail.subprojects.map((s) => (
          <button key={s.id} className="list-row" onClick={() => openSubproject(s.id)} title="Teilprojekt öffnen">
            <span className="grow"><strong>{s.name}</strong>{s.restricted && <span title="Eingeschränkt sichtbar"> 🔒</span>}{s.description && <span className="muted small"> · {s.description.length > 80 ? `${s.description.slice(0, 80)} …` : s.description}</span>}</span>
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

/** Meilensteine nach Datum; mit Teilprojekt öffnet ein Klick dessen Maske, ohne lassen sie sich hier ändern. */
export function MilestoneList() {
  const { detail, reload, openSubproject } = useProject();
  const me = detail.project.myMembership;
  const canPlan = me.role === 'pl' || me.canEditPlan;
  const dialog = useDialog();
  const create = useCreate();
  const { error, run } = useAsync();
  const save = (m: Milestone, body: Record<string, unknown>) => run(async () => { await api.patch(`/projects/${detail.project.id}/milestones/${m.id}`, body); await reload(); });
  const list = [...detail.milestones].sort((a, b) => a.date.localeCompare(b.date));
  return (
    <>
      {error && <div className="error mb">{error}</div>}
      <div className="stack" style={{ gap: 2 }}>
        {list.map((m) => {
          const sp = detail.subprojects.find((s) => s.id === m.subprojectId);
          return (
            <div key={m.id} className="list-row static">
              <span>◆</span>
              <span className="grow">{canPlan ? <InlineText value={m.name} canEdit onSave={(name) => void save(m, { name })} /> : m.name}</span>
              {canPlan ? <input type="date" className="inline-date" value={m.date} onChange={(e) => { if (e.target.value) void save(m, { date: e.target.value }); }} /> : <span className="small nowrap">{fmtDate(m.date)}</span>}
              {canPlan ? <select className="inline-select" aria-label="Teilprojekt" value={m.subprojectId ?? ''} onChange={(e) => void save(m, { subprojectId: e.target.value || null })}><option value="">– Projekt –</option>{detail.subprojects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
                : sp ? <button className="btn sm link" onClick={() => openSubproject(sp.id)}>{sp.name}</button> : <span className="muted small">Projekt</span>}
              {canPlan && <button className="btn sm link" title="Meilenstein löschen" onClick={() => void dialog.confirm({ title: 'Meilenstein löschen', text: `„${m.name}“ (${fmtDate(m.date)}) löschen?`, confirmLabel: 'Löschen', danger: true }).then((ok) => { if (ok) void api.del(`/projects/${detail.project.id}/milestones/${m.id}`).then(reload); })}>✕</button>}
            </div>
          );
        })}
        {list.length === 0 && <p className="muted small">Noch keine Meilensteine.</p>}
      </div>
      {canPlan && <button className="btn sm link mt" onClick={() => void create.milestone()}>+ Meilenstein</button>}
    </>
  );
}
