import { useState } from 'react';
import type { ImportField, ImportResult } from '@projekttool/shared';
import { IMPORT_FIELDS } from '@projekttool/shared';
import { api, ApiError, toCsv } from '../../../lib/api';
import { Button, useAsync, useToast } from '../../../components/ui';
import { useProject } from '../../ProjectPage';

type Preview = ImportResult & { headers: string[]; mapping: ImportField[] };
const KIND_LABEL: Record<string, string> = { ap: 'Arbeitspaket', aufgabe: 'Aufgabe', item: 'Checklistenpunkt', subproject: 'Teilprojekt', skip: 'übersprungen' };

/** Datei als Text lesen (UTF-8; mit Ersatzzeichen: noch einmal als Windows-1252, wie Excel speichert). */
export function readFileText(file: Blob): Promise<string> {
  const read = (enc: string) => new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result ?? '')); r.onerror = () => reject(r.error); r.readAsText(file, enc); });
  return read('utf-8').then((t) => (t.includes('�') ? read('windows-1252') : t));
}

/** Beispieldatei im Format des Imports (Ebene 1/2/3) */
export const IMPORT_SAMPLE = toCsv(['Ebene', 'Titel', 'Beschreibung', 'Teilprojekt', 'Zuständig', 'Start', 'Deadline', 'Priorität', 'Labels'], [
  ['1', 'Hosting einrichten', 'Server und Domains', 'Technik', 'name@firma.de', '01.12.2026', '15.12.2026', 'hoch', 'Infrastruktur'],
  ['2', 'Angebote einholen', '', '', '', '', '05.12.2026', '', ''],
  ['3', 'Anbieter A anfragen', '', '', '', '', '', '', ''],
  ['3', 'Anbieter B anfragen', '', '', '', '', '', '', '']
]);

/**
 * CSV-Import (Projekt › Einstellungen › Daten): Datei wählen, Spalten zuordnen, Vorschau mit Fehlern je Zeile (Trockenlauf),
 * dann Import in einer Transaktion. Liest auch die CSV-Exporte von Board und Plan. Nur PL oder „Projektplan ändern“.
 */
export function ImportCard() {
  const { detail, reload, reloadTasks } = useProject();
  const me = detail.project.myMembership;
  const allowed = me.role === 'pl' || me.canEditPlan;
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const { busy, error, run, setError } = useAsync();
  const toast = useToast();
  if (!allowed) return <p className="muted small">Importieren darf die PL oder wer „Projektplan ändern“ darf.</p>;
  const check = (text: string, mapping: ImportField[] | null) => run(async () => {
    setPreview(await api.post<Preview>(`/projects/${detail.project.id}/import`, { csv: text, mapping, dryRun: true }));
  });
  const doImport = () => run(async () => {
    try {
      const r = await api.post<Preview>(`/projects/${detail.project.id}/import`, { csv, mapping: preview?.mapping ?? null, dryRun: false });
      toast.ok(`Importiert: ${r.created?.ap ?? 0} Arbeitspakete, ${r.created?.aufgabe ?? 0} Aufgaben, ${r.created?.item ?? 0} Checklistenpunkte.`);
      setCsv(null); setPreview(null); setFileName('');
      await reload(); await reloadTasks();
    } catch (e) {
      if (e instanceof ApiError && e.details && typeof e.details === 'object' && 'rows' in (e.details as object)) setPreview(e.details as Preview);
      throw e;
    }
  });
  const rows = preview ? (onlyProblems ? preview.rows.filter((r) => r.errors.length || r.warnings.length) : preview.rows) : [];
  return (
    <div className="stack import-card">
      <p className="muted small m-0">Arbeitspakete, Aufgaben und Checklistenpunkte aus einer CSV-Datei (Excel: „CSV UTF-8“). Die Ebene kommt aus der Spalte „Art“, „Ebene“ (1, 2, 3 oder 1.2.3) oder „Übergeordnet“ (Kennung einer Zeile darüber oder eines bestehenden Arbeitspakets). Der CSV-Export von Board und Plan lässt sich so wieder einlesen. Zuerst prüft ein Trockenlauf jede Zeile; importiert wird erst ohne Fehler, alles in einem Schritt.</p>
      <div className="row gap-2">
        <label className="btn sm file-btn">CSV-Datei wählen<input type="file" accept=".csv,text/csv,text/plain" aria-label="CSV-Datei wählen" onChange={(e) => {
          const f = e.target.files?.[0]; e.target.value = ''; if (!f) return;
          setError(null); setPreview(null); setFileName(f.name);
          void readFileText(f).then((t) => { setCsv(t); void check(t, null); });
        }} /></label>
        <a className="btn sm link" href={`data:text/csv;charset=utf-8,${encodeURIComponent(IMPORT_SAMPLE)}`} download="import-beispiel.csv">Beispieldatei</a>
        {fileName && <span className="muted small">{fileName}</span>}
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {preview && csv && <>
        <h3 className="m-0">Spalten zuordnen</h3>
        <div className="import-mapping">
          {preview.headers.map((h, i) => (
            <label key={i} className="field"><span>{h || `Spalte ${i + 1}`}</span>
              <select aria-label={`Zuordnung der Spalte ${h || i + 1}`} value={preview.mapping[i]} disabled={busy} onChange={(e) => { const m = [...preview.mapping]; m[i] = e.target.value as ImportField; void check(csv, m); }}>
                {IMPORT_FIELDS.map((f) => <option key={f.key} value={f.key} title={f.hint}>{f.label}</option>)}
              </select></label>
          ))}
        </div>
        <div className="row gap-2 small" role="status">
          <strong>Vorschau:</strong> {preview.counts.ap} Arbeitspakete, {preview.counts.aufgabe} Aufgaben, {preview.counts.item} Checklistenpunkte
          {preview.counts.subprojects > 0 && <> · {preview.counts.subprojects} neue Teilprojekte</>}{preview.counts.labels > 0 && <> · {preview.counts.labels} neue Labels</>}
          {preview.counts.errors > 0 ? <span className="badge danger">{preview.counts.errors} Zeile(n) mit Fehlern</span> : <span className="badge ok">keine Fehler</span>}
          <label className="check right"><input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> nur Zeilen mit Hinweisen</label>
        </div>
        <div className="table-wrap import-preview">
          <table className="table">
            <thead><tr><th>Zeile</th><th>Art</th><th>Titel</th><th>gehört zu</th><th>Hinweise</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.line} className={r.errors.length ? 'row-error' : r.warnings.length ? 'row-warn' : ''}>
                <td>{r.line}</td><td className="nowrap">{KIND_LABEL[r.kind] ?? r.kind}</td><td>{r.title || <span className="muted">–</span>}</td><td>{r.parentLine ? `Zeile ${r.parentLine}` : ''}</td>
                <td>{r.errors.map((e, i) => <div key={`e${i}`} className="text-danger small">{e}</div>)}{r.warnings.map((w, i) => <div key={`w${i}`} className="muted small">{w}</div>)}</td>
              </tr>))}
              {rows.length === 0 && <tr><td colSpan={5} className="muted small">Keine Zeilen mit Hinweisen.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="row gap-2">
          <Button variant="primary" loading={busy} disabled={preview.counts.errors > 0 || preview.rows.every((r) => r.kind === 'skip' || r.kind === 'subproject')} onClick={() => void doImport()}>Importieren</Button>
          <Button onClick={() => void check(csv, preview.mapping)} disabled={busy}>Erneut prüfen</Button>
          <Button variant="link" onClick={() => { setCsv(null); setPreview(null); setFileName(''); }}>Verwerfen</Button>
        </div>
      </>}
    </div>
  );
}
