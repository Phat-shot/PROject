import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { ApiError, fieldErrorsOf } from '../lib/api';
import { IconMore, IconX } from './icons';

/* ---------------------------------------------------------------------------------------------------------------
 * Primitives: Button, IconButton, Badge, Spinner, Loading, Term, Dropdown
 * ------------------------------------------------------------------------------------------------------------- */

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'link';
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  /** Läuft: aria-busy mit Spinner, Knopf gesperrt */
  loading?: boolean;
  icon?: ReactNode;
}
/** Knopf mit Variante, Größe und Ladezustand; Klassen bleiben `btn [sm] [primary|danger|link]`. */
export function Button({ variant = 'secondary', size = 'md', loading = false, icon, className = '', children, type = 'button', disabled, ...rest }: ButtonProps) {
  const cls = ['btn', size === 'sm' ? 'sm' : '', variant === 'secondary' ? '' : variant, className].filter(Boolean).join(' ');
  return <button type={type} className={cls} aria-busy={loading || undefined} disabled={disabled || loading} {...rest}>{icon}{children}</button>;
}

/** Knopf nur mit Symbol; `label` ist Pflicht und wird aria-label und Tooltip. */
export function IconButton({ label, size = 'md', variant, className = '', children, type = 'button', ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'title'> & { label: string; size?: 'sm' | 'md'; variant?: 'link' }) {
  const cls = ['icon-btn', size === 'sm' ? 'sm' : '', variant ?? '', className].filter(Boolean).join(' ');
  return <button type={type} className={cls} aria-label={label} title={label} {...rest}>{children}</button>;
}

export type BadgeTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'inherited' | 'blocked';
export function Badge({ tone = 'neutral', className = '', children, title }: { tone?: BadgeTone; className?: string; children: ReactNode; title?: string }) {
  return <span className={`badge ${tone === 'neutral' ? '' : tone} ${className}`.trim()} title={title}>{children}</span>;
}

export function Spinner() { return <span className="spinner" aria-hidden="true" />; }
/** Kleiner Ladehinweis mit Spinner, z. B. „Lädt …“ */
export function Loading({ children = 'Lädt …', className = '' }: { children?: ReactNode; className?: string }) {
  return <span className={`muted small loading ${className}`.trim()} role="status"><Spinner />{children}</span>;
}

/** Glossar: Fachbegriffe mit Erklärung im Tooltip (gepunktete Unterstreichung). */
export const TERMS: Record<string, string> = {
  notaus: 'Notaus: schaltet alle KI-Funktionen und Agentenläufe im Mandanten sofort ab (Verwaltung › KI); gilt auch gegen Ausnahmen.',
  grundmenge: 'Grundmenge: was jeder Agent immer darf, ohne Bestätigung und nicht abschaltbar: Log-Einträge, Checklistenpunkte, Doku-Entwürfe, interner Chat, Fragen.',
  policy: 'Policy: Regeln, wie selbstständig ein Agent handelt: welche Aktionsklassen er direkt ausführt und welche erst nach Bestätigung durch eine Person.',
  pluscode: 'Plus-Code: Kennung in der Antwortadresse (konto+t<code>@…), über die Antworten automatisch im richtigen Arbeitspaket landen.',
  aussenpruefung: 'Außenprüfung: prüft Mails an Externe vor dem Versand auf Projektinternes (andere Arbeitspakete, nicht freigegebene Seiten, interne Adressen) und hält Agenten-Mails mit Fundstellen an.',
  essenz: 'Essenz: der von der KI aus einer Mail herausgezogene Kern als Vorschlag für Log-Eintrag, Status oder Termin bzw. als Abschnitt einer Seite; angewendet erst nach Freigabe.',
  stillstand: 'Stillstand: ein Arbeitspaket in einer aktiven Spalte ohne Fortschritt über die eingestellte Frist; löst die Eskalation aus (Geplant, Wartet und Zurückgestellt zählen nicht).',
  regelm: 'Regel M: Mitgliedschaft über Gruppen: ein Direkteintrag überschreibt alle Gruppen, zwischen Gruppen gilt die höchste Rolle, Einzelrechte addieren sich.'
};
export function Term({ k, children }: { k: keyof typeof TERMS; children?: ReactNode }) {
  const text = TERMS[k];
  return <abbr className="term" title={text}>{children ?? text.split(':')[0]}</abbr>;
}

export interface DropdownItem { label: ReactNode; onClick: () => void; disabled?: boolean; /** Sichtbarer Grund, wenn gesperrt */ reason?: string; danger?: boolean }
/** Kleines Menü „Mehr“: Enter/Leertaste/Pfeil öffnen, Pfeiltasten wandern, Enter wählt, Esc und Klick außerhalb schließen. */
export function Dropdown({ label = 'Mehr', items, size = 'sm', icon = true }: { label?: string; items: DropdownItem[]; size?: 'sm' | 'md'; icon?: boolean }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  useEffect(() => { if (open) ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]')[active]?.focus(); }, [open, active]);
  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
  const move = (d: 1 | -1) => setActive((a) => { if (!enabled.length) return a; const pos = enabled.indexOf(a); return enabled[(pos + d + enabled.length) % enabled.length]; });
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); ref.current?.querySelector<HTMLElement>('button')?.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) { setActive(enabled[0] ?? 0); setOpen(true); } else move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (open) move(-1); }
    else if (e.key === 'Tab') setOpen(false);
  };
  return (
    <span className="menu-wrap dropdown" ref={ref} onKeyDown={onKey}>
      <button type="button" className={`btn ${size === 'sm' ? 'sm' : ''}`} aria-haspopup="menu" aria-expanded={open} aria-controls={id} onClick={() => { setActive(enabled[0] ?? 0); setOpen((o) => !o); }}>{label}{icon && <IconMore />}</button>
      {open && <div className="menu" role="menu" id={id} aria-label={label}>
        {items.map((it, i) => (
          <button key={i} type="button" role="menuitem" className={`${it.danger ? 'danger' : ''} ${active === i ? 'active' : ''}`.trim()} disabled={it.disabled} tabIndex={active === i ? 0 : -1} aria-disabled={it.disabled || undefined}
            onMouseEnter={() => !it.disabled && setActive(i)} onClick={() => { if (it.disabled) return; setOpen(false); it.onClick(); }}>
            {it.label}{it.disabled && it.reason && <span className="reason">{it.reason}</span>}
          </button>
        ))}
      </div>}
    </span>
  );
}

/* ---------------------------------------------------------------------------------------------------------------
 * Toasts
 * ------------------------------------------------------------------------------------------------------------- */

export type ToastKind = 'error' | 'ok' | 'info';
export interface ToastOptions { kind?: ToastKind; /** ms, 0 = bleibt */ timeout?: number }
interface ToastItem { id: number; text: string; kind: ToastKind }
type ToastFn = (text: string, o?: ToastOptions) => void;
const listeners = new Set<ToastFn>();
/** Toast auch außerhalb von Komponenten (z. B. nach einem Drop) – wirkt, sobald ein ToastProvider gerendert ist. */
export const toast: ToastFn & { error: (t: string) => void; ok: (t: string) => void } = Object.assign(
  (text: string, o?: ToastOptions) => { for (const l of listeners) l(text, o); },
  { error: (t: string) => toast(t, { kind: 'error' }), ok: (t: string) => toast(t, { kind: 'ok' }) }
);
const ToastCtx = createContext<{ show: ToastFn; error: (t: string) => void; ok: (t: string) => void }>({ show: toast, error: toast.error, ok: toast.ok });
export const useToast = () => useContext(ToastCtx);

/** Stapel unten rechts; Fehler bleiben 8 s und werden sofort vorgelesen (assertive), Rest 4 s (polite). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const remove = useCallback((id: number) => setItems((l) => l.filter((x) => x.id !== id)), []);
  const show = useCallback<ToastFn>((text, o) => {
    const kind = o?.kind ?? 'info';
    const id = ++seq.current;
    setItems((l) => [...l.filter((x) => !(x.text === text && x.kind === kind)), { id, text, kind }].slice(-5));
    const ms = o?.timeout ?? (kind === 'error' ? 8000 : 4000);
    if (ms > 0) setTimeout(() => remove(id), ms);
  }, [remove]);
  useEffect(() => { listeners.add(show); return () => { listeners.delete(show); }; }, [show]);
  const api = { show, error: (t: string) => show(t, { kind: 'error' }), ok: (t: string) => show(t, { kind: 'ok' }) };
  const errors = items.filter((x) => x.kind === 'error');
  const rest = items.filter((x) => x.kind !== 'error');
  const render = (x: ToastItem) => (
    <div key={x.id} className={`toast ${x.kind}`}>
      <span>{x.text}</span>
      <IconButton label="Meldung schließen" size="sm" variant="link" onClick={() => remove(x.id)}><IconX /></IconButton>
    </div>
  );
  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="toasts">
        <div role="alert" aria-live="assertive" aria-atomic="false">{errors.map(render)}</div>
        <div role="status" aria-live="polite" aria-atomic="false">{rest.map(render)}</div>
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------------------------------------------------------------------------------------------------------------
 * Dialog-Ebenen: Fokusfalle, Esc nur für die oberste Ebene, Dirty-Prüfung
 * ------------------------------------------------------------------------------------------------------------- */

const openDialogs: string[] = [];
/** Ist irgendein Dialog oder Drawer offen? (Tastaturkürzel der Seiten pausieren dann.) */
export const isDialogOpen = () => openDialogs.length > 0;
/** Liegt der Fokus in einem Dialog oder in einem bearbeitbaren Element? Dann greifen Seitenkürzel nicht. */
export function keyboardShortcutsBlocked(target?: EventTarget | null): boolean {
  if (isDialogOpen()) return true;
  const el = (target ?? (typeof document !== 'undefined' ? document.activeElement : null)) as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return true;
  return Boolean(el.closest('[role=dialog], [contenteditable=true]'));
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Eine Dialog-Ebene: registriert sich im Stapel (Esc schließt nur die oberste), fängt Tab/Shift-Tab im Container,
 * setzt den Fokus beim Öffnen (autoFocus-Element, sonst erstes bedienbares) und gibt ihn beim Schließen zurück.
 */
function useDialogLayer(ref: React.RefObject<HTMLElement>, onEscape: () => void) {
  const id = useId();
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  useEffect(() => {
    openDialogs.push(id);
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    // Fokus beim Öffnen: ein autoFocus-Element hat ihn schon (React setzt ihn beim Einhängen), sonst das erste bedienbare, sonst der Dialog
    if (!(el && el.contains(document.activeElement))) {
      const first = el?.querySelector<HTMLElement>('[autofocus], [data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? el)?.focus?.();
    }
    // Oberste Ebene = letzter modaler Dialog in Dokumentreihenfolge (verschachtelte liegen später, Bestätigungen des DialogProvider ganz am Ende)
    const isTop = () => { const all = document.querySelectorAll('[role="dialog"][aria-modal="true"]'); return all.length === 0 || all[all.length - 1] === el; };
    const h = (e: KeyboardEvent) => {
      if (!isTop()) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onEscapeRef.current(); return; }
      if (e.key === 'Tab' && el) {
        const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => !x.hasAttribute('hidden') && x.getAttribute('aria-hidden') !== 'true');
        if (!items.length) { e.preventDefault(); el.focus(); return; }
        const a = items[0]; const z = items[items.length - 1];
        const inside = el.contains(document.activeElement);
        if (e.shiftKey && (document.activeElement === a || !inside)) { e.preventDefault(); z.focus(); }
        else if (!e.shiftKey && (document.activeElement === z || !inside)) { e.preventDefault(); a.focus(); }
      }
    };
    window.addEventListener('keydown', h, true);
    return () => {
      window.removeEventListener('keydown', h, true);
      const i = openDialogs.indexOf(id); if (i >= 0) openDialogs.splice(i, 1);
      if (prev && document.contains(prev)) prev.focus?.();
    };
  }, [id]);
}

/** Dirty-Zustand eines Formulars: true, sobald sich `value` vom ersten Stand unterscheidet (JSON-Vergleich); `reset()` setzt den Vergleichsstand neu. */
export function useDirty(value: unknown): { dirty: boolean; reset: () => void } {
  const [base, setBase] = useState(() => JSON.stringify(value));
  const cur = JSON.stringify(value);
  return { dirty: cur !== base, reset: () => setBase(cur) };
}

interface LayerProps {
  title: ReactNode; onClose: () => void; children: ReactNode;
  /** Ungespeicherte Eingaben: Schließen fragt nach */
  dirty?: boolean;
  /** Breites Modal (z. B. Berichtsvorschau) */
  wide?: boolean;
}
/** Schließen mit Dirty-Prüfung („Eingaben verwerfen?“). */
function useRequestClose(onClose: () => void, dirty?: boolean) {
  const dialog = useDialog();
  const closing = useRef(false);
  return async () => {
    if (!dirty) { onClose(); return; }
    if (closing.current) return;
    closing.current = true;
    try {
      const ok = await dialog.confirm({ title: 'Eingaben verwerfen?', text: 'Ungespeicherte Eingaben gehen verloren.', confirmLabel: 'Verwerfen', danger: true });
      if (ok) onClose();
    } finally { closing.current = false; }
  };
}

export function Drawer({ title, onClose, children, actions, dirty }: LayerProps & { actions?: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  const close = useRequestClose(onClose, dirty);
  useDialogLayer(ref, () => void close());
  return (
    <>
      <div className="drawer-backdrop" onClick={() => void close()} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} tabIndex={-1}>
        {/* Titel volle Breite (darf umbrechen), Schließen daneben; Aktionen in einer Zeile darunter (mobil seitlich scrollbar) */}
        <header>
          <div className="drawer-title"><h2 id={titleId}>{title}</h2><IconButton label="Schließen" size="sm" className="drawer-close" onClick={() => void close()}><IconX /></IconButton></div>
          {actions && <div className="drawer-actions">{actions}</div>}
        </header>
        <div className="body">{children}</div>
      </aside>
    </>
  );
}

export function Modal({ title, onClose, children, dirty, wide }: LayerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useRequestClose(onClose, dirty);
  useDialogLayer(ref, () => void close());
  return (
    <div className="modal" onMouseDown={(e) => { if (e.target === e.currentTarget) void close(); }}>
      <div className={wide ? 'card wide' : 'card'} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} tabIndex={-1}>
        <div className="row between mb"><h2 className="m-0" id={titleId}>{title}</h2><IconButton label="Schließen" size="sm" onClick={() => void close()}><IconX /></IconButton></div>
        {children}
      </div>
    </div>
  );
}

/** Eingabe im eigenen Dialog statt window.prompt: Enter bestätigt, Escape bricht ab. */
export function PromptModal({ title, label, value = '', placeholder, type = 'text', hint, submitLabel = 'Übernehmen', onSubmit, onClose }: {
  title: ReactNode; label?: string; value?: string; placeholder?: string; type?: string; hint?: string; submitLabel?: string; onSubmit: (v: string) => unknown; onClose: () => void;
}) {
  const [v, setV] = useState(value);
  const ok = () => { onSubmit(v.trim()); onClose(); };
  return (
    <Modal title={title} onClose={onClose} dirty={v !== value}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); ok(); }}>
        <label className="field">{label && <span>{label}</span>}
          <input type={type} value={v} placeholder={placeholder} autoFocus onChange={(e) => setV(e.target.value)} /></label>
        {hint && <p className="muted small">{hint}</p>}
        <div className="row"><Button type="submit" variant="primary">{submitLabel}</Button><Button onClick={onClose}>Abbrechen</Button></div>
      </form>
    </Modal>
  );
}

/**
 * Sanitizer für Seiten-, Berichts- und Markdown-HTML: HTML- und SVG-Profil (Diagramme der Berichte: svg, rect, text, line,
 * circle, path, g, tspan samt Attributen), ohne Skripte, Stylesheets und foreignObject; Tabellen- und Checklisten-Attribute
 * des Editors bleiben erhalten.
 */
export const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true, svg: true, svgFilters: false },
  FORBID_TAGS: ['script', 'style', 'foreignObject', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'base', 'meta', 'link'],
  FORBID_ATTR: ['onload', 'onerror', 'onclick'],
  ADD_ATTR: ['target', 'colwidth', 'data-type', 'data-checked', 'role', 'aria-label', 'viewBox', 'text-anchor', 'font-family', 'font-weight', 'stroke-dasharray']
} as const;
export function sanitizeHtml(html: string): string {
  return String(DOMPurify.sanitize(html, SANITIZE_CONFIG as any));
}
/** Bereinigtes HTML (Seite, Bericht, Vorschau) als Fließtext anzeigen. */
export function SafeHtml({ html, className = 'prose' }: { html: string; className?: string }) {
  return <div className={className} dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />;
}
export function Markdown({ md }: { md: string }) {
  return <SafeHtml html={marked.parse(md, { async: false, breaks: true, gfm: true }) as string} />;
}

/**
 * Asynchrone Aktion mit Lade- und Fehlerzustand. `toast: true` zeigt Fehler zusätzlich als Toast (für Aktionen ohne
 * eigenen Fehlerplatz); `fieldErrors` enthält feldbezogene Meldungen aus ApiError.details.
 */
export function useAsync(opts: { toast?: boolean } = {}) {
  const [busy, setBusy] = useState(false);
  const [error, setErrorState] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const t = useToast();
  const setError = (e: string | null) => { setErrorState(e); if (!e) setFieldErrors({}); };
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setErrorState(null);
    setFieldErrors({});
    try {
      return await fn();
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      setErrorState(msg);
      if (e instanceof ApiError) setFieldErrors(fieldErrorsOf(e.details));
      if (opts.toast) t.error(msg);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, fieldErrors, run, setError };
}

/** Feldfehler unter einem Eingabefeld. */
export function FieldError({ error }: { error?: string | null }) {
  return error ? <span className="field-error" role="alert">{error}</span> : null;
}

export function Initials({ name }: { name: string | null | undefined }) {
  const i = (name ?? '?').split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase();
  return <span className="avatar" title={name ?? ''}>{i}</span>;
}

export const roleLabel: Record<string, string> = { pl: 'PL', member: 'Mitglied', reader: 'Leser' };
export const statusLabel: Record<string, string> = { draft: 'Entwurf', review: 'In Prüfung', final: 'Final' };
export const prioLabel: Record<string, string> = { low: 'niedrig', normal: 'normal', high: 'hoch', critical: 'kritisch' };

/* ---- Eigene Bestätigungsdialoge statt window.confirm / window.alert ---- */

export interface ConfirmOptions { title: ReactNode; text?: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean }
export interface FormField { key: string; label: string; type?: 'text' | 'date' | 'select' | 'checkbox'; value?: string; placeholder?: string; required?: boolean; options?: { value: string; label: string }[] }
export interface FormOptions { title: ReactNode; text?: ReactNode; fields: FormField[]; submitLabel?: string; danger?: boolean }
export interface ChooseOptions<T> { title: ReactNode; text?: ReactNode; options: { label: string; value: T; primary?: boolean; danger?: boolean }[]; cancelLabel?: string }
interface DialogApi {
  /** Ja/Nein-Frage; löst mit true auf, wenn bestätigt. */
  confirm: (o: ConfirmOptions) => Promise<boolean>;
  /** Auswahl zwischen mehreren Optionen; null bei Abbruch. */
  choose: <T,>(o: ChooseOptions<T>) => Promise<T | null>;
  /** Hinweis mit nur einem Button. */
  notify: (o: { title: ReactNode; text?: ReactNode }) => Promise<void>;
  /** Kleines Formular (z. B. Grund und Frist); null bei Abbruch. */
  form: (o: FormOptions) => Promise<Record<string, string> | null>;
}
const DialogCtx = createContext<DialogApi>({ confirm: async (o) => window.confirm(typeof o.title === 'string' ? o.title : '?'), choose: async () => null, notify: async () => undefined, form: async () => null });
export const useDialog = () => useContext(DialogCtx);

type Pending = { kind: 'form'; o: FormOptions; resolve: (v: Record<string, string> | null) => void } | { kind: 'confirm'; o: ConfirmOptions; resolve: (v: boolean) => void } | { kind: 'choose'; o: ChooseOptions<any>; resolve: (v: any) => void } | { kind: 'notify'; o: { title: ReactNode; text?: ReactNode }; resolve: () => void };

export function DialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Pending[]>([]);
  const push = (p: Pending) => setQueue((q) => [...q, p]);
  const api: DialogApi = {
    confirm: (o) => new Promise((resolve) => push({ kind: 'confirm', o, resolve })),
    choose: (o) => new Promise((resolve) => push({ kind: 'choose', o, resolve })),
    notify: (o) => new Promise((resolve) => push({ kind: 'notify', o, resolve })),
    form: (o) => new Promise((resolve) => push({ kind: 'form', o, resolve }))
  };
  const cur = queue[0];
  const done = (fn: () => void) => { fn(); setQueue((q) => q.slice(1)); };
  return (
    <DialogCtx.Provider value={api}>
      {children}
      {cur?.kind === 'form' && <FormDialog o={cur.o} onDone={(v) => done(() => cur.resolve(v))} />}
      {cur && cur.kind !== 'form' && (
        <Modal title={cur.o.title} onClose={() => done(() => (cur.kind === 'confirm' ? cur.resolve(false) : cur.kind === 'choose' ? cur.resolve(null) : (cur as any).resolve()))}>
          {cur.o.text && <div className="mb pre">{cur.o.text}</div>}
          <div className="row">
            {/* Gefährliche Aktion: Fokus auf „Abbrechen“, damit Enter nichts zerstört */}
            {cur.kind === 'confirm' && <>
              <Button variant={cur.o.danger ? 'danger' : 'primary'} autoFocus={!cur.o.danger} onClick={() => done(() => cur.resolve(true))}>{cur.o.confirmLabel ?? 'OK'}</Button>
              <Button autoFocus={Boolean(cur.o.danger)} onClick={() => done(() => cur.resolve(false))}>{cur.o.cancelLabel ?? 'Abbrechen'}</Button>
            </>}
            {cur.kind === 'choose' && <>
              {cur.o.options.map((opt, i) => <Button key={i} variant={opt.primary ? 'primary' : opt.danger ? 'danger' : 'secondary'} autoFocus={i === 0} onClick={() => done(() => cur.resolve(opt.value))}>{opt.label}</Button>)}
              <Button variant="link" onClick={() => done(() => cur.resolve(null))}>{cur.o.cancelLabel ?? 'Abbrechen'}</Button>
            </>}
            {cur.kind === 'notify' && <Button variant="primary" autoFocus onClick={() => done(() => cur.resolve())}>OK</Button>}
          </div>
        </Modal>
      )}
    </DialogCtx.Provider>
  );
}

function FormDialog({ o, onDone }: { o: FormOptions; onDone: (v: Record<string, string> | null) => void }) {
  const [v, setV] = useState<Record<string, string>>(Object.fromEntries(o.fields.map((f) => [f.key, f.value ?? ''])));
  const ok = o.fields.every((f) => !f.required || v[f.key]?.trim());
  return (
    <Modal title={o.title} onClose={() => onDone(null)}>
      {o.text && <div className="mb muted small">{o.text}</div>}
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (ok) onDone(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x.trim()]))); }}>
        {o.fields.map((f, i) => f.type === 'checkbox'
          ? <label key={f.key} className="check"><input type="checkbox" checked={v[f.key] === '1'} onChange={(e) => setV({ ...v, [f.key]: e.target.checked ? '1' : '' })} /> {f.label}</label>
          : <label key={f.key} className="field"><span className={f.required ? 'req' : ''}>{f.label}</span>{f.type === 'select'
          ? <select value={v[f.key]} aria-required={f.required || undefined} onChange={(e) => setV({ ...v, [f.key]: e.target.value })}>{(f.options ?? []).map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select>
          : <input type={f.type ?? 'text'} autoFocus={i === 0} aria-required={f.required || undefined} value={v[f.key]} placeholder={f.placeholder} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />}</label>)}
        <div className="row"><Button type="submit" variant={o.danger ? 'danger' : 'primary'} disabled={!ok}>{o.submitLabel ?? 'Übernehmen'}</Button><Button variant="link" onClick={() => onDone(null)}>Abbrechen</Button></div>
      </form>
    </Modal>
  );
}
