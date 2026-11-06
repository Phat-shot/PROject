import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { IconCalendar, IconChevronLeft, IconChevronRight } from './icons';
import { addDays, addMonths, dateOf, formatDe, isoWeek, monthGrid, MONTHS, parseDateInput, todayIso, WEEKDAYS, WEEKDAYS_LONG, weekdayMon } from '../lib/dates';

export interface DateInputProps {
  /** ISO-Datum (JJJJ-MM-TT) oder '' */
  value: string | null | undefined;
  /** Neuer Wert (ISO oder '' für leer); erst beim Übernehmen (Enter, Verlassen, Kalender), nicht je Tastendruck */
  onChange: (iso: string) => void;
  id?: string;
  name?: string;
  disabled?: boolean;
  required?: boolean;
  /** Frühestes / spätestes Datum (ISO) */
  min?: string;
  max?: string;
  className?: string;
  style?: CSSProperties;
  placeholder?: string;
  title?: string;
  autoFocus?: boolean;
  /** KW hinter dem Feld anzeigen */
  showWeek?: boolean;
  'aria-label'?: string;
  'aria-invalid'?: boolean;
  'aria-required'?: boolean;
  'aria-describedby'?: string;
}

/**
 * Eigener Datumswähler statt <input type="date">: Anzeige und Eingabe deutsch (TT.MM.JJJJ), tippbar mit Kurzformen
 * („12.11.“, „12.11.26“, „heute“, „morgen“, „+3“, „Fr“, „KW 47“), Pfeil hoch/runter ändert um einen Tag, Alt+Pfeil runter
 * öffnet den Kalender. Kalender als Dialog mit Raster (role=grid), Pfeiltasten, Bild auf/ab (Monat), Pos1/Ende (Wochenanfang/-ende),
 * KW-Spalte, „Heute“ und „Löschen“. Der Wert bleibt ISO wie bisher.
 */
export function DateInput({ value, onChange, id, name, disabled, required, min, max, className = '', style, placeholder = 'TT.MM.JJJJ', title, autoFocus, showWeek, ...aria }: DateInputProps) {
  const iso = value ? String(value).slice(0, 10) : '';
  const [text, setText] = useState(formatDe(iso));
  const [editing, setEditing] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  useEffect(() => { if (!editing) { setText(formatDe(iso)); setInvalid(false); } }, [iso, editing]);
  const outOfRange = (v: string) => Boolean((min && v < min) || (max && v > max));
  const commit = (v: string): boolean => {
    if ((v && outOfRange(v)) || (!v && required)) { setInvalid(true); return false; }
    setInvalid(false); setEditing(false); setText(formatDe(v));
    if (v !== iso) onChange(v);
    return true;
  };
  const commitText = (): boolean => {
    const v = parseDateInput(text);
    if (v === null) { setInvalid(true); return false; }
    if (v === '' && required) { setInvalid(true); return false; }
    return commit(v);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { if (!commitText()) e.preventDefault(); return; }
    if (e.key === 'Escape' && editing) { e.preventDefault(); e.stopPropagation(); setEditing(false); setText(formatDe(iso)); setInvalid(false); return; }
    if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); setOpen(true); return; }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey) {
      const base = parseDateInput(text) || iso || todayIso();
      e.preventDefault();
      const next = addDays(base, e.key === 'ArrowUp' ? 1 : -1);
      if (!outOfRange(next)) { setEditing(true); setText(formatDe(next)); }
    }
  };
  // Klick außerhalb schließt den Kalender
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const weekHint = iso ? `${WEEKDAYS_LONG[weekdayMon(iso)]}, KW ${isoWeek(iso)}` : '';
  return (
    <span className={`date-input ${invalid ? 'invalid' : ''} ${className}`.trim()} ref={wrapRef} style={style}>
      <input ref={inputRef} type="text" inputMode="text" autoComplete="off" id={id} name={name} disabled={disabled} autoFocus={autoFocus} placeholder={placeholder}
        value={text} title={title ?? (weekHint || 'Datum: TT.MM.JJJJ, auch „heute“, „morgen“, „+3“, „Fr“')}
        aria-label={aria['aria-label']} aria-required={aria['aria-required'] ?? required ?? undefined} aria-invalid={invalid || aria['aria-invalid'] || undefined}
        aria-describedby={[aria['aria-describedby'], invalid ? hintId : null].filter(Boolean).join(' ') || undefined}
        onChange={(e) => { setEditing(true); setText(e.target.value); setInvalid(false); }}
        onBlur={(e) => { if (wrapRef.current?.contains(e.relatedTarget as Node)) return; if (editing && !commitText()) { setEditing(false); setText(formatDe(iso)); setInvalid(false); } }}
        onKeyDown={onKey} />
      {showWeek && iso && <span className="date-week muted small" aria-hidden="true">KW {isoWeek(iso)}</span>}
      <button type="button" className="date-btn" disabled={disabled} aria-label={`Kalender öffnen${aria['aria-label'] ? `: ${aria['aria-label']}` : ''}`} aria-haspopup="dialog" aria-expanded={open} tabIndex={-1}
        onClick={() => setOpen(!open)}><IconCalendar size={14} /></button>
      {invalid && <span id={hintId} className="sr-only" role="alert">Kein gültiges Datum{min || max ? ` (${min ? `ab ${formatDe(min)}` : ''}${min && max ? ' ' : ''}${max ? `bis ${formatDe(max)}` : ''})` : ''}</span>}
      {open && <CalendarPopover value={parseDateInput(text) || iso} min={min} max={max} label={aria['aria-label']}
        onPick={(v) => { if (commit(v)) { setOpen(false); inputRef.current?.focus(); } }}
        onClose={() => { setOpen(false); inputRef.current?.focus(); }} />}
    </span>
  );
}

/** Kalender-Dialog: Monatsraster mit KW, Tastatur wie im WAI-ARIA-Muster „Date Picker Dialog“. */
export function CalendarPopover({ value, min, max, label, onPick, onClose }: { value: string; min?: string; max?: string; label?: string; onPick: (iso: string) => void; onClose: () => void }) {
  const today = todayIso();
  const [focus, setFocus] = useState(value || today);
  const gridRef = useRef<HTMLTableElement>(null);
  const titleId = useId();
  const d = dateOf(focus);
  const weeks = monthGrid(d.getUTCFullYear(), d.getUTCMonth());
  useLayoutEffect(() => { gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${focus}"]`)?.focus(); }, [focus]);
  const disabledDay = (x: string) => Boolean((min && x < min) || (max && x > max));
  const onKey = (e: KeyboardEvent) => {
    const map: Record<string, () => string> = {
      ArrowLeft: () => addDays(focus, -1), ArrowRight: () => addDays(focus, 1), ArrowUp: () => addDays(focus, -7), ArrowDown: () => addDays(focus, 7),
      PageUp: () => addMonths(focus, e.shiftKey ? -12 : -1), PageDown: () => addMonths(focus, e.shiftKey ? 12 : 1),
      Home: () => addDays(focus, -weekdayMon(focus)), End: () => addDays(focus, 6 - weekdayMon(focus))
    };
    if (map[e.key]) { e.preventDefault(); setFocus(map[e.key]()); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
  };
  // aria-modal: oberste Ebene, damit Esc nur den Kalender schließt und nicht den Dialog darunter (useDialogLayer)
  return (
    <div className="date-pop" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKey}>
      <div className="date-pop-head">
        <button type="button" className="btn sm link" aria-label="Voriger Monat" onClick={() => setFocus(addMonths(focus, -1))}><IconChevronLeft size={14} /></button>
        <strong id={titleId} aria-live="polite">{label ? <span className="sr-only">{label}: </span> : null}{MONTHS[d.getUTCMonth()]} {d.getUTCFullYear()}</strong>
        <button type="button" className="btn sm link" aria-label="Nächster Monat" onClick={() => setFocus(addMonths(focus, 1))}><IconChevronRight size={14} /></button>
      </div>
      <table className="date-grid" role="grid" aria-labelledby={titleId} ref={gridRef}>
        <thead><tr><th scope="col" className="kw" title="Kalenderwoche"><abbr title="Kalenderwoche">KW</abbr></th>{WEEKDAYS.map((w, i) => <th key={w} scope="col"><abbr title={WEEKDAYS_LONG[i]}>{w}</abbr></th>)}</tr></thead>
        <tbody>
          {weeks.map((wk) => (
            <tr key={wk[0]}>
              <th scope="row" className="kw">{isoWeek(wk[0])}</th>
              {wk.map((x) => {
                const other = dateOf(x).getUTCMonth() !== d.getUTCMonth();
                const sel = x === value;
                return (
                  <td key={x} role="gridcell" aria-selected={sel || undefined}>
                    <button type="button" data-date={x} tabIndex={x === focus ? 0 : -1} disabled={disabledDay(x)}
                      className={`day ${other ? 'other' : ''} ${sel ? 'sel' : ''} ${x === today ? 'today' : ''} ${weekdayMon(x) >= 5 ? 'we' : ''}`.trim()}
                      aria-label={`${WEEKDAYS_LONG[weekdayMon(x)]}, ${formatDe(x)}${x === today ? ', heute' : ''}`} aria-current={x === today ? 'date' : undefined}
                      onClick={() => onPick(x)} onFocus={() => { if (x !== focus) setFocus(x); }}>{dateOf(x).getUTCDate()}</button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="date-pop-foot">
        <button type="button" className="btn sm" disabled={disabledDay(today)} onClick={() => onPick(today)}>Heute</button>
        <button type="button" className="btn sm link" onClick={() => onPick('')}>Löschen</button>
        <span className="muted small grow right-text">{value ? `KW ${isoWeek(value)}` : ''}</span>
      </div>
    </div>
  );
}
