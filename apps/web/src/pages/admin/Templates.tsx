import { useState } from 'react';
import type { DocTemplate, Group, ProjectTemplate } from '@projekttool/shared';
import { RichEditor } from '../../components/RichEditor';
import { api } from '../../lib/api';
import { useData } from '../../lib/useData';
import { useAsync, useDialog } from '../../components/ui';
import { ResourcesTable } from '../../components/Resources';

/** Ressourcen-Pool des Mandanten (Konzept 10): Räume, Geräte, Fahrzeuge, externe Personen; Freigabegruppe je Ressource, Sperrzeiten. */
export function PoolResourcesCard() {
  const groups = useData<{ groups: Group[] }>('/groups');
  return (
    <div className="card">
      <h2>Ressourcen-Pool</h2>
      <p className="muted small">Für alle Projekte buchbar. Mit Freigabegruppe bleiben Buchungen von Nicht-Mitgliedern der Gruppe vorläufig, bis die Gruppe bestätigt. Löschen geht nur ohne künftige Belegungen, sonst deaktivieren. Kalender › Belegung zeigt die Auslastung.</p>
      <ResourcesTable projectId={null} canEdit canDelete groups={groups.data?.groups ?? []} />
    </div>
  );
}

export function ProjectTemplatesCard() {
  const { data, reload } = useData<{ templates: ProjectTemplate[] }>('/project-templates');
  const dialog = useDialog();
  const { busy, error, run } = useAsync();
  return (
    <div className="card">
      <h2>Projektvorlagen</h2>
      <p className="muted small">Vorlagen entstehen aus bestehenden Projekten („Als Vorlage speichern“ in den Projekteinstellungen) und belegen neue Projekte mit Spalten, Labels, Teilprojekten, Meilensteinen, Doku-Ordnern und Regeln vor.</p>
      {error && <div className="error mb">{error}</div>}
      {data && data.templates.length === 0 && <div className="empty">Noch keine Vorlagen.</div>}
      {data && data.templates.length > 0 && <table className="table"><thead><tr><th>Name</th><th>Inhalt</th><th /></tr></thead><tbody>
        {data.templates.map((t) => <tr key={t.id}>
          <td><InlineName value={t.name} onSave={(name) => run(async () => { await api.patch(`/project-templates/${t.id}`, { name }); await reload(); })} />{t.description && <div className="muted small">{t.description}</div>}</td>
          <td className="small muted">{t.spec.columns?.length ?? 0} Spalten · {t.spec.subprojects?.length ?? 0} Teilprojekte · {t.spec.milestones?.length ?? 0} Meilensteine · {t.spec.labels?.length ?? 0} Labels · {t.spec.folders?.length ?? 0} Ordner</td>
          <td className="nowrap"><button className="btn sm link" disabled={busy} onClick={() => void dialog.confirm({ title: 'Vorlage löschen', text: `„${t.name}“ löschen? Bestehende Projekte bleiben unverändert.`, confirmLabel: 'Löschen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/project-templates/${t.id}`); await reload(); }); })}>✕</button></td>
        </tr>)}
      </tbody></table>}
    </div>
  );
}

function InlineName({ value, onSave }: { value: string; onSave: (v: string) => unknown }) {
  const [v, setV] = useState(value);
  return <input className="inline-text" type="text" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => { if (v.trim() && v.trim() !== value) onSave(v.trim()); else setV(value); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />;
}

export function TemplatesCard() {
  const { data, reload } = useData<{ templates: DocTemplate[] }>('/docs/templates');
  const [edit, setEdit] = useState<DocTemplate | null>(null);
  const [name, setName] = useState('');
  const [html, setHtml] = useState('');
  const [newKey, setNewKey] = useState('');
  const { busy, error, run } = useAsync();
  const open = (t: DocTemplate) => { setEdit(t); setName(t.name); setHtml(t.contentHtml || ''); };
  return (
    <div className="card">
      <h2>Vorlagen (Protokoll, Statusbericht, RAID-Log …)</h2>
      <p className="muted small">Vorlagen werden im selben Editor wie Seiten gepflegt; Platzhalter <code>{'{{datum}}'}</code> wird beim Anlegen ersetzt. Eingebaute Vorlagen lassen sich für den Mandanten überschreiben. Oberseiten legen fest, welche Vorlage ihre Unterseiten bekommen.</p>
      <div className="row mb">
        {data?.templates.map((t) => <button key={t.id} className={`chip ${edit?.key === t.key ? 'on' : ''}`} onClick={() => open(t)}>{t.name}</button>)}
        <span className="row small"><input type="text" placeholder="neuer Schlüssel, z. B. abnahme" value={newKey} onChange={(e) => setNewKey(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))} style={{ width: 200 }} /><button className="btn sm" disabled={!newKey} onClick={() => { setEdit({ id: '', key: newKey, name: '', contentMd: '', contentHtml: '<h1>Titel</h1><p></p>' }); setName(''); setHtml('<h1>Titel</h1><p></p>'); }}>+ Vorlage</button></span>
      </div>
      {edit && (
        <div className="form">
          <label className="field"><span>Name (Schlüssel: {edit.key})</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <RichEditor key={edit.key} html={html} onChange={setHtml} />
          {error && <div className="error">{error}</div>}
          <div className="row"><button className="btn primary sm" disabled={busy || !name} onClick={() => void run(async () => { await api.put(`/docs/templates/${edit.key}`, { name, contentHtml: html }); await reload(); })}>Speichern</button><button className="btn sm" onClick={() => setEdit(null)}>Schließen</button></div>
        </div>
      )}
    </div>
  );
}
