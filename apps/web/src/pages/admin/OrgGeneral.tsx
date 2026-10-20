import { useState } from 'react';
import type { OrgSettings } from '@projekttool/shared';
import { api } from '../../lib/api';
import { useData } from '../../lib/useData';
import { useAsync } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useFlash } from '../../components/settings/Settings';

/** Mandant: Darstellung der PDFs (Kopfzeile, Akzentfarbe, Fußzeile) und Module (Zeiterfassung, persönliche Projekte). Ein Formular, ein Speichern. */
export function OrgGeneralCard() {
  const { data, reload } = useData<{ name: string; settings: OrgSettings }>('/org/settings');
  const [f, setF] = useState<OrgSettings | null>(null);
  const { busy, error, run } = useAsync();
  const { msg, flash } = useFlash();
  const { refresh: refreshAuth } = useAuth();
  const v = f ?? data?.settings ?? {};
  if (!data) return null;
  return (
    <div className="card">
      <h2>Mandant: Darstellung und Module</h2>
      <p className="muted small">Gilt für alle PDFs des Mandanten: Kopfzeile, Akzentfarbe für Überschriften und Tabellenköpfe, Fußzeile. Inhalt und Gliederung kommen aus der Seite bzw. Vorlage.</p>
      <div className="form cols-2">
        <label className="field"><span>Firmenname in der Kopfzeile</span><input type="text" value={v.company ?? ''} placeholder={data.name} onChange={(e) => setF({ ...v, company: e.target.value })} /></label>
        <label className="field"><span>Akzentfarbe</span><span className="row"><input type="color" value={v.accentColor ?? '#1f5eff'} onChange={(e) => setF({ ...v, accentColor: e.target.value })} style={{ width: 48, padding: 0, height: 32 }} /><input type="text" value={v.accentColor ?? '#1f5eff'} onChange={(e) => setF({ ...v, accentColor: e.target.value })} style={{ width: 110 }} /></span></label>
        <label className="field full"><span>Fußzeile</span><input type="text" value={v.footerText ?? ''} placeholder="z. B. Vertraulich · nur für Projektbeteiligte" onChange={(e) => setF({ ...v, footerText: e.target.value })} /></label>
        <label className="check full"><input type="checkbox" checked={v.timeTracking !== false} onChange={(e) => setF({ ...v, timeTracking: e.target.checked })} /> Zeiterfassung mandantenweit aktiv (aus = Zeiten, Aufwand und Buchungen werden in allen Projekten ausgeblendet; Daten bleiben erhalten)</label>
        <label className="check full"><input type="checkbox" checked={Boolean(v.personalProjects)} onChange={(e) => setF({ ...v, personalProjects: e.target.checked })} /> Alle Benutzer dürfen ein persönliches Projekt (Assistent) anlegen: nur die Person und KI-Agenten, Org-Admin ohne Inhalte und ohne Kontenverwaltung. Projektersteller dürfen es immer.</label>
        {error && <div className="error full">{error}</div>}
        <div className="full"><button className="btn primary sm" disabled={busy || !f} onClick={() => void run(async () => { await api.put('/org/settings', f); setF(null); await reload(); await refreshAuth(); flash('Gespeichert.'); })}>Speichern</button>{msg && <span className="muted small" style={{ marginLeft: 8 }}>{msg}</span>}</div>
      </div>
    </div>
  );
}