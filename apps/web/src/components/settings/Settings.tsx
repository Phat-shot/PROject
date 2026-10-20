import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

/**
 * Gemeinsames Muster der drei Einstellungsseiten (Verwaltung, Projekt, Meine Einstellungen): Reiter sind Routen unter einer
 * Basis, eine Spalte mit Cards je Abschnitt. Reiternamen und Reihenfolge sind auf allen Ebenen gleich (Konzept Einstellungen 4.2).
 */
export interface SettingsTab { key: string; label: string; element: ReactNode }

/** Reiter für die TopBar: Links auf die Unterrouten. */
export const settingsTabLinks = (base: string, tabs: SettingsTab[]) => tabs.map((t) => ({ to: `${base}/${t.key}`, label: t.label }));

/** Inhalt der Einstellungsseite: Route je Reiter, ohne Reiter in der URL der erste. Muss unter einem Pfad mit `/*` liegen. */
export function SettingsRoutes({ tabs, fallback }: { tabs: SettingsTab[]; fallback?: ReactNode }) {
  if (tabs.length === 0) return <div className="content">{fallback ?? <div className="empty">Keine Einstellungen für deine Rolle.</div>}</div>;
  return (
    <div className="content settings">
      <Routes>
        <Route index element={<Navigate to={tabs[0].key} replace />} />
        {tabs.map((t) => <Route key={t.key} path={t.key} element={<div className="stack settings-tab">{t.element}</div>} />)}
        <Route path="*" element={<Navigate to={tabs[0].key} replace />} />
      </Routes>
    </div>
  );
}

/** Kurze Bestätigung nach dem Speichern, verschwindet von selbst. */
export function useFlash(ms = 4000) {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (!msg) return; const h = setTimeout(() => setMsg(null), ms); return () => clearTimeout(h); }, [msg, ms]);
  return { msg, flash: setMsg };
}

/** Eine Zeile „Ändert: PL“ für Cards, die die angemeldete Person nur lesen darf. */
export function ReadOnlyNote({ who }: { who: string }) {
  return <p className="muted small readonly-note">Nur lesend. Ändert: {who}.</p>;
}

/** Badge „Standard“ mit Zurücksetzen für Werte ohne Vererbung, die noch den Code-Standard tragen oder davon abweichen. */
export function StandardBadge({ isDefault, onReset, disabled }: { isDefault: boolean; onReset?: () => void; disabled?: boolean }) {
  if (isDefault) return <span className="badge inherited" title="Noch der Standard; nichts eigenes gesetzt">Standard</span>;
  return onReset ? <button className="btn sm link" disabled={disabled} title="Auf den Standard zurücksetzen" onClick={onReset}>Zurücksetzen</button> : <span className="badge">eigener Wert</span>;
}

/** Ein geerbter Wert mit Herkunft, wie die Benachrichtigungsmatrix ihn zeigt: „erbt: Wert (Ebene)“. */
export interface Inherited<T> { value: T; origin: string }
export const inheritedText = <T,>(e: Inherited<T> | null | undefined, text: (v: T) => string) => (e ? `erbt: ${text(e.value)} (${e.origin})` : 'erbt');

/**
 * Select für ein vererbbares Feld: erste Option „erbt: Wert (Ebene)“ (eigener Wert leer), dann die Werte; gesperrt mit 🔒 und Ebene.
 * `value` ist der eigene Wert dieser Ebene (undefined = erbt), `effective` der wirksame Wert mit Herkunft.
 */
export function InheritSelect<T extends string>({ value, effective, options, onChange, disabled, lockedBy, label, ariaLabel, text }: {
  value: T | undefined | null; effective?: Inherited<T> | null; options: readonly { key: T; label: string }[]; onChange: (v: T | undefined) => void;
  disabled?: boolean; lockedBy?: string | null; label?: ReactNode; ariaLabel?: string; text?: (v: T) => string;
}) {
  const t = text ?? ((v: T) => options.find((o) => o.key === v)?.label ?? String(v));
  const select = (
    <span className="row nowrap" style={{ gap: 4 }}>
      <select aria-label={ariaLabel} className={value == null ? 'inherited' : ''} value={value ?? ''} disabled={disabled || Boolean(lockedBy)} style={{ width: 'auto' }} onChange={(e) => onChange((e.target.value || undefined) as T | undefined)}>
        <option value="">{inheritedText(effective, t)}</option>
        {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
      </select>
      {lockedBy && <span className="muted small" title="Gesperrt auf einer Ebene darüber">🔒 {lockedBy}</span>}
    </span>
  );
  return label ? <label className="field"><span>{label}</span>{select}</label> : select;
}

/** Zahlenfeld für ein vererbbares Feld: leer = erbt, Platzhalter zeigt den wirksamen Wert mit Herkunft. Speichert beim Verlassen. */
export function InheritNumber({ value, effective, onChange, disabled, lockedBy, min, max, unit, label, ariaLabel, width = 90 }: {
  value: number | undefined | null; effective?: Inherited<number> | null; onChange: (v: number | undefined) => void;
  disabled?: boolean; lockedBy?: string | null; min?: number; max?: number; unit?: string; label?: ReactNode; ariaLabel?: string; width?: number;
}) {
  const [v, setV] = useState(value == null ? '' : String(value));
  useEffect(() => setV(value == null ? '' : String(value)), [value]);
  const commit = () => { const n = v.trim() === '' ? undefined : Number(v); if (n !== undefined && (!Number.isFinite(n) || (min != null && n < min) || (max != null && n > max))) { setV(value == null ? '' : String(value)); return; } if (n !== (value ?? undefined)) onChange(n); };
  const input = (
    <span className="row nowrap" style={{ gap: 4 }}>
      <input type="number" aria-label={ariaLabel} className={value == null ? 'inherited' : ''} value={v} min={min} max={max} disabled={disabled || Boolean(lockedBy)} style={{ width }} placeholder={effective ? `${effective.value}${unit ? ` ${unit}` : ''} (${effective.origin})` : '–'} title={inheritedText(effective, (x) => `${x}${unit ? ` ${unit}` : ''}`)}
        onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      {unit && <span className="muted small">{unit}</span>}
      {lockedBy && <span className="muted small" title="Gesperrt auf einer Ebene darüber">🔒 {lockedBy}</span>}
    </span>
  );
  return label ? <label className="field"><span>{label}</span>{input}</label> : input;
}

/** Card mit Überschrift und optionaler Aktion rechts; einheitlicher Kopf für alle Einstellungs-Cards. */
export function SettingsCard({ title, action, children, id, hint }: { title: ReactNode; action?: ReactNode; children: ReactNode; id?: string; hint?: ReactNode }) {
  return (
    <div className="card" id={id}>
      <div className="row between mb"><h2 style={{ margin: 0 }}>{title}</h2>{action}</div>
      {hint && <p className="muted small">{hint}</p>}
      {children}
    </div>
  );
}
