import { useState } from 'react';
import type { OrgSettings, MailInquiry } from '@projekttool/shared';
import { api } from '../../lib/api';
import { useData } from '../../lib/useData';
import { useAsync } from '../../components/ui';
import { invalidateAi, useAiStatus } from '../../lib/useAi';
import { SettingsCard, useFlash } from '../../components/settings/Settings';

const WEEKDAY_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/**
 * Verwaltung › Mail › Vorgaben: Mail-Rückfrage (Vorgabe für Projekte, überschreibbar), Außenprüfung für Agenten-Mails an Nicht-Interne
 * und Arbeitszeitfenster für Mails nach außen (beides Sperre: gilt für alle Projekte). Formulare mit Speichern je Abschnitt.
 */
export function MailDefaultsCard() {
  return (
    <SettingsCard title="Vorgaben für Mails" hint="Was für alle Projekte gilt. Die Mail-Rückfrage überschreibt jedes Projekt unter Einstellungen › Mail; Außenprüfung und Arbeitszeitfenster gelten überall.">
      <MailInquiryDefault />
      <ExternalGuardForm />
      <ExternalWindowForm />
    </SettingsCard>
  );
}

const INQUIRY_LABEL: Record<string, string> = { ask_pl: 'PL fragen (klar / im Projekt fragen / beim Absender rückfragen)', ask_project: 'im Projekt fragen', ask_sender: 'beim Absender rückfragen', off: 'aus (nur Log)' };

function MailInquiryDefault() {
  const { data, reload } = useData<{ name: string; settings: OrgSettings }>('/org/settings');
  const [f, setF] = useState<MailInquiry | null>(null);
  const { busy, error, run } = useAsync();
  const { msg, flash } = useFlash();
  const v: MailInquiry = f ?? data?.settings.mailInquiry ?? { mode: 'ask_pl', waitHours: 48 };
  if (!data) return null;
  return (
    <>
      <h3>Mail-Rückfrage (Vorgabe für Projekte)</h3>
      <p className="muted small">Nennt die Mail-KI zu einer neuen Mail offene Punkte, fragt der Projektagent nach, statt zu raten. Projekte ohne eigene Einstellung übernehmen diesen Wert.</p>
      <div className="form cols-2">
        <label className="field"><span>Offene Punkte aus neuen Mails</span><select value={v.mode} onChange={(e) => setF({ ...v, mode: e.target.value as MailInquiry['mode'] })}>{Object.entries(INQUIRY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="field"><span>Frist der Rückfrage (Stunden, danach Weitergabe über die Kette)</span><input type="number" min={1} max={720} value={v.waitHours} onChange={(e) => setF({ ...v, waitHours: Number(e.target.value) })} /></label>
        {error && <div className="error full">{error}</div>}
        <div className="full row"><button className="btn primary sm" disabled={busy || !f} onClick={() => void run(async () => { await api.put('/org/settings', { mailInquiry: f }); setF(null); await reload(); flash('Gespeichert.'); })}>Speichern</button>{msg && <span className="muted small">{msg}</span>}</div>
      </div>
    </>
  );
}

/** Außenprüfung (Sperre): streng = mit Außenkontext neu formulieren und prüfen, check = nur prüfen. Speichert sofort. */
function ExternalGuardForm() {
  const st = useAiStatus();
  const { busy, error, run } = useAsync();
  const { msg, flash } = useFlash();
  if (!st) return null;
  return (
    <>
      <h3>Außenprüfung für Agenten-Mails an Nicht-Interne</h3>
      <p className="muted small">Gilt für Mails, Antworten auf Ursprungsmails und PDF-Versand der KI-Agenten an Nicht-Interne; Entwürfe und die Abschluss-Antwort mit KI werden nur geprüft (Hinweise). Gilt in allen Projekten.</p>
      <div className="row small">
        <select aria-label="Außenprüfung" value={st.externalGuard ?? 'strict'} disabled={busy} style={{ width: 'auto' }} onChange={(e) => void run(async () => { await api.put('/ai/settings', { externalGuard: e.target.value }); await invalidateAi(); flash('Gespeichert.'); })}>
          <option value="strict">streng: mit Außenkontext neu formulieren, dann prüfen (ein Zusatzaufruf je Mail)</option>
          <option value="check">nur prüfen</option>
        </select>{msg && <span className="muted">{msg}</span>}
      </div>
      {error && <div className="error small mt">{error}</div>}
    </>
  );
}

/** Arbeitszeitfenster (Sperre): Mails der Agenten nach außen nur im Fenster, sonst Versand zum nächsten Fensterbeginn. */
function ExternalWindowForm() {
  const st = useAiStatus();
  const win = st?.externalWindow ?? { enabled: true, days: [1, 2, 3, 4, 5], from: '07:00', to: '19:00' };
  const [fw, setFw] = useState<{ enabled: boolean; days: number[]; from: string; to: string } | null>(null);
  const v = fw ?? win;
  const { busy, error, run } = useAsync();
  const { msg, flash } = useFlash();
  if (!st) return null;
  return (
    <>
      <h3>Arbeitszeitfenster für Mails nach außen</h3>
      <p className="muted small">Mails der Agenten an Nicht-Interne (auch Antworten auf Ursprungsmails und PDF-Versand) gehen nur in diesem Fenster (Europe/Berlin); außerhalb plant das System den Versand auf den nächsten Fensterbeginn und schreibt das ins Log. Interner Chat, Fragen und Entwürfe sind nicht betroffen.</p>
      <div className="form cols-2">
        <label className="check full"><input type="checkbox" checked={v.enabled} onChange={(e) => setFw({ ...v, enabled: e.target.checked })} /> Fenster aktiv</label>
        <div className="field"><span>Wochentage</span><div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>{WEEKDAY_SHORT.map((d, i) => <label key={d} className="check small" style={{ margin: 0 }}><input type="checkbox" checked={v.days.includes(i + 1)} onChange={(e) => setFw({ ...v, days: e.target.checked ? [...v.days, i + 1].sort() : v.days.filter((x) => x !== i + 1) })} /> {d}</label>)}</div></div>
        <div className="row"><label className="field"><span>von</span><input type="time" value={v.from} onChange={(e) => setFw({ ...v, from: e.target.value })} /></label><label className="field"><span>bis</span><input type="time" value={v.to} onChange={(e) => setFw({ ...v, to: e.target.value })} /></label></div>
        {error && <div className="error full">{error}</div>}
        <div className="full row"><button className="btn primary sm" disabled={busy || !fw} onClick={() => void run(async () => { await api.put('/ai/settings', { externalWindow: v }); setFw(null); await invalidateAi(); flash('Gespeichert.'); })}>Speichern</button>{msg && <span className="muted small">{msg}</span>}</div>
      </div>
    </>
  );
}
