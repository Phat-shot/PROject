import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../../lib/api';
import { PromptModal, useAsync, useDialog } from '../../../components/ui';
import { HealthDialog } from '../../PortfolioPage';
import { useProject } from '../../ProjectPage';
import { useAuth } from '../../../lib/auth';
import { useProjectPolicy } from '../../../lib/useProjectPolicy';
import { SettingsCard, ReadOnlyNote, useFlash } from '../../../components/settings/Settings';

/**
 * Projekt › Einstellungen › Allgemein: Name, Kürzel, Beschreibung, Sichtbarkeit, Status, Ampel, Zeiterfassung und Budget in einem
 * Formular mit einem Speichern; darunter die Aktionen „Als Vorlage speichern“ und „Archivieren“.
 */
export function GeneralTab() {
  const { detail, reload } = useProject();
  const { timeTracking } = useAuth();
  const p = detail.project;
  const isPl = p.myMembership.role === 'pl';
  const policy = useProjectPolicy(p);
  const [f, setF] = useState({ name: p.name, description: p.description ?? '', visibility: p.visibility, timeTrackingEnabled: p.timeTrackingEnabled, budgetHours: p.budgetHours == null ? '' : String(p.budgetHours) });
  const [health, setHealth] = useState(false);
  const [asTemplate, setAsTemplate] = useState(false);
  const { busy, error, run } = useAsync();
  const { msg, flash } = useFlash();
  const dialog = useDialog();
  const nav = useNavigate();
  const dirty = f.name !== p.name || f.description !== (p.description ?? '') || f.visibility !== p.visibility || f.timeTrackingEnabled !== p.timeTrackingEnabled || f.budgetHours !== (p.budgetHours == null ? '' : String(p.budgetHours));
  const healthText = p.health?.color ? `${{ green: 'grün', yellow: 'gelb', red: 'rot' }[p.health.color]}${p.health.note ? ` · ${p.health.note}` : ''}` : 'automatisch';
  return (
    <>
      <SettingsCard title="Projekt">
        {!isPl && <ReadOnlyNote who="PL" />}
        <div className="form">
          <div className="grid cols-2">
            <label className="field"><span>Name</span><input type="text" value={f.name} disabled={!isPl} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label className="field"><span>Kürzel</span><input type="text" value={p.key} readOnly title="Wird beim Anlegen festgelegt" /></label>
          </div>
          <label className="field"><span>Beschreibung</span><textarea value={f.description} disabled={!isPl} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
          <div className="grid cols-2">
            <label className="field"><span>Sichtbarkeit</span>
              <select value={f.visibility} disabled={!isPl || !policy.visibility.org} title={policy.visibility.org ? undefined : 'Persönliche Projekte sind nur für die Person und ihre Agenten sichtbar'} onChange={(e) => setF({ ...f, visibility: e.target.value as 'members' | 'org' })}>
                <option value="members">nur Mitglieder</option>
                {policy.visibility.org && <option value="org">alle Benutzer des Mandanten (lesend)</option>}
              </select>
              <span className="muted small">„Alle Benutzer“: Nicht-Mitglieder sehen Übersicht, Board, Plan und Doku lesend. Mail-Ansichten bleiben rechtegebunden, schreiben darf nur, wer Mitglied ist.</span></label>
            <div className="field"><span>Status und Ampel</span>
              <span className="row small"><span className="badge">{p.status === 'active' ? 'aktiv' : 'archiviert'}</span><span className={`ampel small ${p.health?.color ?? 'none'}`} />{healthText}{isPl && <button className="btn sm link" onClick={() => setHealth(true)}>Ampel ändern</button>}</span></div>
          </div>
          {timeTracking ? <div className="grid cols-2">
            <label className="check"><input type="checkbox" checked={f.timeTrackingEnabled} disabled={!isPl} onChange={(e) => setF({ ...f, timeTrackingEnabled: e.target.checked })} /> Zeiterfassung aktiv (optionales Modul)</label>
            {(f.timeTrackingEnabled || f.budgetHours) && <label className="field"><span>Budget (Stunden)</span><input type="number" min={0} value={f.budgetHours} disabled={!isPl} onChange={(e) => setF({ ...f, budgetHours: e.target.value })} style={{ width: 120 }} /></label>}
          </div> : <p className="muted small">Zeiterfassung ist mandantenweit deaktiviert (<Link to="/verwaltung/allgemein">Verwaltung › Allgemein</Link>).</p>}
          {error && <div className="error">{error}</div>}
          {isPl && <div className="row"><button className="btn primary sm" disabled={busy || !dirty || !f.name.trim()} onClick={() => void run(async () => { await api.patch(`/projects/${p.id}`, { name: f.name, description: f.description, visibility: f.visibility, timeTrackingEnabled: f.timeTrackingEnabled, budgetHours: f.budgetHours ? Number(f.budgetHours) : null }); await reload(); flash('Gespeichert.'); })}>Speichern</button>{msg && <span className="muted small">{msg}</span>}</div>}
        </div>
      </SettingsCard>
      {isPl && p.status === 'active' && <SettingsCard title="Aktionen">
        <div className="row">
          <button className="btn sm" title="Spalten, Labels, Teilprojekte, Meilensteine, Ordner und Regeln als Vorlage für neue Projekte" onClick={() => setAsTemplate(true)}>Als Vorlage speichern</button>
          <button className="btn sm danger" onClick={() => void dialog.confirm({ title: 'Projekt archivieren', text: 'Das Projekt wird nur noch lesend angezeigt, Mail-Ansichten werden getrennt, Eskalation und Reporting stoppen.', confirmLabel: 'Archivieren', danger: true }).then((ok) => { if (ok) void run(async () => { await api.post(`/projects/${p.id}/archive`); await reload(); nav('/projekte'); }); })}>Archivieren</button>
        </div>
        {policy.members.notice && <p className="notice small mt">{policy.members.notice}</p>}
      </SettingsCard>}
      {health && <HealthDialog row={{ id: p.id, name: p.name, computed: 'green', health: p.health ?? { color: null, note: null, updatedAt: null, updatedBy: null } }} onClose={() => setHealth(false)} onSaved={async () => { setHealth(false); await reload(); }} />}
      {asTemplate && <PromptModal title="Als Projektvorlage speichern" label="Name der Vorlage" value={`${p.name} (Vorlage)`} hint="Übernommen werden Spalten, Labels, Teilprojekte und Meilensteine (relativ zum frühesten Termin), Doku-Ordner, Eskalations- und Erinnerungsregeln." submitLabel="Speichern" onClose={() => setAsTemplate(false)} onSubmit={(name) => { if (name) void run(async () => { await api.post(`/project-templates/from-project/${p.id}`, { name }); flash(`Vorlage „${name}“ gespeichert.`); }); }} />}
    </>
  );
}
