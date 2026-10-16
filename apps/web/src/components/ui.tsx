import { useEffect, useState, type ReactNode } from 'react';
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
        <header>
          <h2>{title}</h2>
          {actions}
          <button className="btn sm" onClick={onClose}>Schließen</button>
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
