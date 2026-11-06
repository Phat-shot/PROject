import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AGENT_FOLDER_ACCESS, type AgentFolderAccess, type AgentSources, type AgentSourcesPatch } from '@projekttool/shared';
import { api } from '../../../lib/api';
import { useData } from '../../../lib/useData';
import { Loading, useAsync } from '../../../components/ui';
import { ReadOnlyNote, SettingsCard } from '../../../components/settings/Settings';
import { useProject } from '../../ProjectPage';

/**
 * Quellen für den Agenten: was KI-Agenten im Projekt durchsuchen und lesen dürfen – je Doku-Ordner (samt Unterordnern; derselbe
 * Agent-Zugriff wie in der Doku: schreiben, nur lesen, kein Zugriff), je
 * eingebundenem Dateiquellen-Ordner und Mails des Projekts. Ausgeschlossenes sieht der Agent gar nicht (auch keine Titel); Menschen
 * sehen weiter alles. Die Rechte der Mail-Ansichten (Lesen und KI) gelten zusätzlich. Nur die PL ändert.
 * section: als Abschnitt in einer anderen Karte (persönliches Projekt: „Dein Assistent“), sonst eigene Karte.
 */
export function AgentSourcesCard({ section = false }: { section?: boolean }) {
  const { detail } = useProject();
  const pid = detail.project.id;
  const src = useData<AgentSources>(`/projects/${pid}/agent-sources`, [pid]);
  const { busy, error, run } = useAsync();
  const [data, setData] = useState<AgentSources | null>(null);
  const raw = data ?? src.data;
  // Fehlende Teile (ältere API) als leer behandeln
  const d: AgentSources | null = raw ? { canEdit: Boolean(raw.canEdit), folders: raw.folders ?? [], bindings: raw.bindings ?? [], mails: raw.mails ?? { enabled: true, views: 0 } } : null;
  const canEdit = Boolean(d?.canEdit);
  const save = (patch: AgentSourcesPatch) => run(async () => { setData(await api.patch<AgentSources>(`/projects/${pid}/agent-sources`, patch)); });
  const toggle = (label: string, checked: boolean, onChange: (v: boolean) => void, disabled = false, title?: string) => (
    <label className="check" title={title}>
      <input type="checkbox" aria-label={label} checked={checked} disabled={!canEdit || busy || disabled} onChange={(e) => onChange(e.target.checked)} /> {checked ? 'für KI-Agenten' : 'ausgeschlossen'}
    </label>
  );
  const body = !d ? (src.error ? <div className="error small">{src.error}</div> : <Loading />) : (
    <>
      {!canEdit && <ReadOnlyNote who="PL" />}
      {error && <div className="error small mb">{error}</div>}
      <h4 className="mt-0">Doku-Ordner</h4>
      {d.folders.length === 0 ? <p className="muted small">Keine Ordner. Seiten ohne Ordner sind für Agenten immer sichtbar.</p> : (
        <table className="table">
          <thead><tr><th>Ordner</th><th>Seiten</th><th>Agent</th></tr></thead>
          <tbody>{d.folders.map((f) => (
            <tr key={f.id}>
              <td style={{ paddingLeft: `${0.5 + f.depth * 1.25}rem` }}>{f.name}</td>
              <td>{f.pages}</td>
              <td>{f.inheritedOff
                ? <span className="muted small" title="Ein übergeordneter Ordner hat „kein Zugriff“">ausgeschlossen (über Oberordner)</span>
                : <select aria-label={`Zugriff der KI-Agenten auf Ordner ${f.name}`} value={f.agentAccess} disabled={!canEdit || busy} onChange={(e) => void save({ folders: [{ id: f.id, agentAccess: e.target.value as AgentFolderAccess }] })}>
                  {AGENT_FOLDER_ACCESS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      <h4>Dateiquellen</h4>
      {d.bindings.length === 0 ? <p className="muted small">Keine Dateiquelle eingebunden (<Link to={`/projekte/${pid}/einstellungen/dateien`}>Einstellungen › Dateien</Link>).</p> : (
        <table className="table">
          <thead><tr><th>Ordner</th><th>Quelle</th><th>Dateien</th><th>Agent</th></tr></thead>
          <tbody>{d.bindings.map((b) => (
            <tr key={b.id}>
              <td>{b.label}{!b.active && <span className="badge ml-1" title="Quelle deaktiviert oder nicht mehr freigegeben">ruht</span>}</td>
              <td>{b.sourceName}{b.subPath ? <span className="muted small"> · {b.subPath}</span> : null}</td>
              <td>{b.files}</td>
              <td>{toggle(`Dateiquelle ${b.label} für KI-Agenten`, b.agentEnabled, (v) => void save({ bindings: [{ id: b.id, agentEnabled: v }] }))}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      <h4>Mails</h4>
      <div className="row gap-1">
        {toggle('Mails für KI-Agenten durchsuchbar', d.mails.enabled, (v) => void save({ mails: v }))}
        <span className="muted small">{d.mails.views === 1 ? '1 Ansicht' : `${d.mails.views} Ansichten`}; zusätzlich gelten die Rechte je Ansicht (Lesen und KI).</span>
      </div>
    </>
  );
  const hint = 'Was KI-Agenten in diesem Projekt durchsuchen und lesen dürfen (Suche, Lesen, Projektdurchlauf). Ausgeschlossenes sieht der Agent gar nicht, auch keine Titel; für Menschen ändert sich nichts.';
  if (section) return <section aria-label="Quellen für den Agenten"><h3 className="mt">Quellen für den Agenten</h3><p className="muted small">{hint}</p>{body}</section>;
  return <SettingsCard title="Quellen für den Agenten" id="quellen" hint={hint}>{body}</SettingsCard>;
}
