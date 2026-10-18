import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export function Drawer({ title, onClose, children, actions }: { title: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer">
        {/* Titel volle Breite (darf umbrechen), Schließen daneben; Aktionen in einer Zeile darunter (mobil seitlich scrollbar) */}
        <header>
          <div className="drawer-title"><h2>{title}</h2><button className="btn sm drawer-close" title="Schließen (Esc)" aria-label="Schließen" onClick={onClose}>✕</button></div>
          {actions && <div className="drawer-actions">{actions}</div>}
        </header>
        <div className="body">{children}</div>
      </aside>
    </>
  );
}

export function Modal({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal" onClick={onClose}>
      <div className="card" onClick={(e) => e.stopPropagation()}>
        <div className="row between mb"><h2 style={{ margin: 0 }}>{title}</h2><button className="btn sm" onClick={onClose}>✕</button></div>
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
    <Modal title={title} onClose={onClose}>
      <div className="form">
        <label className="field">{label && <span>{label}</span>}
          <input type={type} value={v} placeholder={placeholder} autoFocus onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } }} /></label>
        {hint && <p className="muted small">{hint}</p>}
        <div className="row"><button className="btn primary" onClick={ok}>{submitLabel}</button><button className="btn" onClick={onClose}>Abbrechen</button></div>
      </div>
    </Modal>
  );
}

export function Markdown({ md }: { md: string }) {
  const html = DOMPurify.sanitize(marked.parse(md, { async: false, breaks: true, gfm: true }) as string);
  return <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function useAsync() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e: any) {
      setError(e?.message ?? String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
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
export interface ChooseOptions<T> { title: ReactNode; text?: ReactNode; options: { label: string; value: T; primary?: boolean; danger?: boolean }[]; cancelLabel?: string }
interface DialogApi {
  /** Ja/Nein-Frage; löst mit true auf, wenn bestätigt. */
  confirm: (o: ConfirmOptions) => Promise<boolean>;
  /** Auswahl zwischen mehreren Optionen; null bei Abbruch. */
  choose: <T,>(o: ChooseOptions<T>) => Promise<T | null>;
  /** Hinweis mit nur einem Button. */
  notify: (o: { title: ReactNode; text?: ReactNode }) => Promise<void>;
}
const DialogCtx = createContext<DialogApi>({ confirm: async () => window.confirm('?'), choose: async () => null, notify: async () => undefined });
export const useDialog = () => useContext(DialogCtx);

type Pending = { kind: 'confirm'; o: ConfirmOptions; resolve: (v: boolean) => void } | { kind: 'choose'; o: ChooseOptions<any>; resolve: (v: any) => void } | { kind: 'notify'; o: { title: ReactNode; text?: ReactNode }; resolve: () => void };

export function DialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Pending[]>([]);
  const push = (p: Pending) => setQueue((q) => [...q, p]);
  const api: DialogApi = {
    confirm: (o) => new Promise((resolve) => push({ kind: 'confirm', o, resolve })),
    choose: (o) => new Promise((resolve) => push({ kind: 'choose', o, resolve })),
    notify: (o) => new Promise((resolve) => push({ kind: 'notify', o, resolve }))
  };
  const cur = queue[0];
  const done = (fn: () => void) => { fn(); setQueue((q) => q.slice(1)); };
  return (
    <DialogCtx.Provider value={api}>
      {children}
      {cur && (
        <Modal title={cur.o.title} onClose={() => done(() => (cur.kind === 'confirm' ? cur.resolve(false) : cur.kind === 'choose' ? cur.resolve(null) : cur.resolve()))}>
          {cur.o.text && <div className="mb" style={{ whiteSpace: 'pre-wrap' }}>{cur.o.text}</div>}
          <div className="row">
            {cur.kind === 'confirm' && <>
              <button className={`btn ${cur.o.danger ? 'danger' : 'primary'}`} autoFocus onClick={() => done(() => cur.resolve(true))}>{cur.o.confirmLabel ?? 'OK'}</button>
              <button className="btn" onClick={() => done(() => cur.resolve(false))}>{cur.o.cancelLabel ?? 'Abbrechen'}</button>
            </>}
            {cur.kind === 'choose' && <>
              {cur.o.options.map((opt, i) => <button key={i} className={`btn ${opt.primary ? 'primary' : opt.danger ? 'danger' : ''}`} autoFocus={i === 0} onClick={() => done(() => cur.resolve(opt.value))}>{opt.label}</button>)}
              <button className="btn link" onClick={() => done(() => cur.resolve(null))}>{cur.o.cancelLabel ?? 'Abbrechen'}</button>
            </>}
            {cur.kind === 'notify' && <button className="btn primary" autoFocus onClick={() => done(() => cur.resolve())}>OK</button>}
          </div>
        </Modal>
      )}
    </DialogCtx.Provider>
  );
}
