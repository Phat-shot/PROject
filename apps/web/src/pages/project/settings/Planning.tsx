import { useState } from 'react';
import { api } from '../../../lib/api';
import { Modal, useAsync, useDialog } from '../../../components/ui';
import { MilestoneList, SubprojectList } from '../planForms';
import { ResourcesTable } from '../../../components/Resources';
import { LABEL_COLORS, PLANNING_DEPTHS } from '@projekttool/shared';
import { InlineText } from '../TaskDrawer';
import { useProject } from '../../ProjectPage';
import { SettingsCard, ReadOnlyNote } from '../../../components/settings/Settings';
import { IconX } from '../../../components/icons';

function LabelsCard() {
  const { detail, reload } = useProject();
  const isPl = detail.project.myMembership.role === 'pl';
  const dialog = useDialog();
  const { error, run } = useAsync();
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>('blue');
  const pid = detail.project.id;
  if (!isPl) return <div className="row gap-1">{detail.labels.map((l) => <span key={l.id} className={`lbl full ${l.color}`}>{l.name}</span>)}{detail.labels.length === 0 && <span className="muted small">Keine Labels.</span>}</div>;
  return (
    <div className="stack">
      {error && <div className="error">{error}</div>}
      {detail.labels.map((l) => (
        <div key={l.id} className="row">
          <span className={`lbl full ${l.color} min-w-60 text-center`}>{l.name}</span>
          <InlineText value={l.name} canEdit onSave={(v) => run(async () => { await api.patch(`/projects/${pid}/labels/${l.id}`, { name: v }); await reload(); })} />
          <select className="inline-select" value={l.color} onChange={(e) => void run(async () => { await api.patch(`/projects/${pid}/labels/${l.id}`, { color: e.target.value }); await reload(); })}>{LABEL_COLORS.map((c) => <option key={c} value={c}>{c}</option>)}</select>
          <button className="btn sm link" title="Label löschen" onClick={() => void dialog.confirm({ title: 'Label löschen', text: `„${l.name}“ wird von allen Arbeitspaketen entfernt.`, confirmLabel: 'Löschen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/projects/${pid}/labels/${l.id}`); await reload(); }); })} aria-label="Label löschen"><IconX /></button>
        </div>
      ))}
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return; void run(async () => { await api.post(`/projects/${pid}/labels`, { name: name.trim(), color }); setName(''); await reload(); }); }}>
        <input className="w-160" type="text" placeholder="Neues Label" value={name} onChange={(e) => setName(e.target.value)} />
        <select className="w-auto" value={color} onChange={(e) => setColor(e.target.value)}>{LABEL_COLORS.map((c) => <option key={c} value={c}>{c}</option>)}</select>
        <button className="btn sm" disabled={!name.trim()}>Anlegen</button>
      </form>
    </div>
  );
}

/** Board-Spalten: Name, Art (wirkt auf die Eskalation), WIP-Limit, Reihenfolge. */
export function ColumnsForm({ onClose }: { onClose: () => void }) {
  const { detail, reload, reloadTasks } = useProject();
  const [cols, setCols] = useState(detail.columns.map((c) => ({ id: c.id as string | undefined, name: c.name, isDone: c.isDone, kind: c.kind, wipLimit: c.wipLimit })));
  const KIND: Record<string, string> = { backlog: 'Geplant (noch nicht aktiv)', active: 'In Bearbeitung', waiting: 'Wartet (mit Frist, danach Zurückgestellt)', parked: 'Zurückgestellt (ruht)', done: 'Erledigt' };
  const { busy, error, run } = useAsync();
  return (
    <Modal title="Board-Spalten" onClose={onClose}>
      <div className="stack">
        {cols.map((c, i) => <div key={i} className="row"><input className="grow" type="text" value={c.name} onChange={(e) => setCols(cols.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /><select className="w-auto" value={c.kind} onChange={(e) => setCols(cols.map((x, j) => (j === i ? { ...x, kind: e.target.value as any, isDone: e.target.value === 'done' } : x)))}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select><label className="small nowrap">WIP <input className="w-56" type="number" min={0} value={c.wipLimit ?? ''} placeholder="–" onChange={(e) => setCols(cols.map((x, j) => (j === i ? { ...x, wipLimit: e.target.value ? Number(e.target.value) : null } : x)))} /></label><button className="btn sm link" onClick={() => setCols(cols.filter((_, j) => j !== i))} aria-label="Entfernen"><IconX /></button></div>)}
        <button className="btn sm" onClick={() => setCols([...cols, { id: undefined, name: 'Neue Spalte', isDone: false, kind: 'active' as const, wipLimit: null }])}>+ Spalte</button>
        <p className="muted small">Spaltenart: „Geplant“ und „Zurückgestellt“ zählen nicht als Stillstand für die Eskalation. WIP-Limit färbt die Spalte rot, wenn mehr Arbeitspakete darin liegen.</p>
        {error && <div className="error">{error}</div>}
        <div><button className="btn primary" disabled={busy} onClick={() => void run(async () => { await api.put(`/projects/${detail.project.id}/columns`, { columns: cols }); await reload(); await reloadTasks(); onClose(); })}>Speichern</button></div>
      </div>
    </Modal>
  );
}


/** Planungstiefe: wie Schritte eines Arbeitspakets angelegt werden (Menschen und KI-Agenten); Regel im KI-Sheet, Durchsetzung bei Agentenläufen. */
function PlanningDepthCard() {
  const { detail, reload } = useProject();
  const isPl = detail.project.myMembership.role === 'pl';
  const { busy, error, run } = useAsync();
  const value = detail.project.planningDepth ?? 'auto';
  return (
    <div className="stack">
      {!isPl && <ReadOnlyNote who="PL" />}
      <label className="field"><span>Planungstiefe</span>
        <select value={value} disabled={!isPl || busy} aria-label="Planungstiefe" onChange={(e) => void run(async () => { await api.patch(`/projects/${detail.project.id}`, { planningDepth: e.target.value }); await reload(); })}>
          {PLANNING_DEPTHS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
        </select>
      </label>
      <ul className="small muted m-0">{PLANNING_DEPTHS.map((d) => <li key={d.key}><strong>{d.label}:</strong> {d.hint}</li>)}</ul>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/** Projekt › Einstellungen › Planung und Board: Teilprojekte, Meilensteine, Spalten, Labels, Ressourcen des Projekts. */
export function PlanningTab() {
  const { detail } = useProject();
  const isPl = detail.project.myMembership.role === 'pl';
  const [columns, setColumns] = useState(false);
  return (
    <>
      <SettingsCard title="Planungstiefe" hint="Aufgabe oder Checklistenpunkt? Gilt für KI-Agenten verbindlich (das System setzt die Regel bei ihren Läufen um und vermerkt es im Log) und als Leitlinie für das Team. Verschieben und Umwandeln geht jederzeit im Arbeitspaket.">
        <PlanningDepthCard />
      </SettingsCard>
      <SettingsCard title="Teilprojekte" hint="Klick öffnet die Maske: Verantwortung (sonst die PL), Zeitraum, Beschreibung, Sichtbarkeit, Meilensteine und Arbeitspakete. Auch über den Kopf der Swimlane im Board und die Zeile im Plan.">
        <SubprojectList />
      </SettingsCard>
      <SettingsCard title="Meilensteine" hint="Nach Datum; mit Teilprojekt auch in dessen Maske.">
        <MilestoneList />
      </SettingsCard>
      <SettingsCard title="Board" action={isPl && <button className="btn sm" onClick={() => setColumns(true)}>Spalten bearbeiten</button>}>
        <div className="row mb gap-2">{detail.columns.map((c) => <span key={c.id} className="badge" title={c.kind}>{c.name}{c.wipLimit != null ? ` · WIP ${c.wipLimit}` : ''}</span>)}</div>
        <h3>Labels</h3>
        {!isPl && <ReadOnlyNote who="PL (anlegen dürfen alle Mitglieder im Board)" />}
        <LabelsCard />
        {columns && <ColumnsForm onClose={() => setColumns(false)} />}
      </SettingsCard>
      <SettingsCard title="Ressourcen des Projekts" hint="Gerüste, Geräte, Räume oder externe Personen (Elektriker) nur für dieses Projekt; Pool-Ressourcen des Mandanten pflegt die Verwaltung. Buchungen im Kalender (Modus „Belegung“), am Arbeitspaket oder an der Besprechung; Konflikte übersteuern nur PL oder „Projektplan ändern“.">
        <ResourcesTable projectId={detail.project.id} canEdit={detail.project.myMembership.role !== 'reader'} canDelete={isPl} />
      </SettingsCard>
    </>
  );
}
