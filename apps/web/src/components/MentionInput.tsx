import { api } from '../lib/api';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';

interface Member { userId: string; name: string }

/**
 * Textfeld mit @-Vervollständigung über Projektmitglieder. Strg/Cmd+Enter sendet; mit enterSends (Chat) sendet schon
 * Enter, Umschalt+Enter bricht um, und das Feld wächst mit dem Text.
 */
export function MentionInput({ value, onChange, members, placeholder, onSubmit, enterSends = false, autoFocus }: { value: string; onChange: (v: string) => void; members: Member[]; placeholder?: string; onSubmit?: () => void; enterSends?: boolean; autoFocus?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!enterSends || !el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [value, enterSends]);
  const [query, setQuery] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const matches = query === null ? [] : members.filter((m) => m.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6);
  useEffect(() => setSel(0), [query]);
  const update = (v: string, caret: number) => {
    onChange(v);
    const before = v.slice(0, caret);
    const m = /(?:^|\s)@([\p{L}\p{N} .-]{0,30})$/u.exec(before);
    setQuery(m ? m[1] : null);
  };
  const pick = (m: Member) => {
    const el = ref.current!;
    const caret = el.selectionStart;
    const before = value.slice(0, caret).replace(/@([\p{L}\p{N} .-]{0,30})$/u, `@${m.name} `);
    const next = before + value.slice(caret);
    onChange(next);
    setQuery(null);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(before.length, before.length); });
  };
  return (
    <div className="mention-box">
      {matches.length > 0 && (
        <div className="mention-list">
          {matches.map((m, i) => <div key={m.userId} className={i === sel ? 'sel' : ''} onMouseDown={(e) => { e.preventDefault(); pick(m); }}>@{m.name}</div>)}
        </div>
      )}
      <textarea ref={ref} value={value} placeholder={placeholder} rows={enterSends ? 1 : undefined} autoFocus={autoFocus}
        onChange={(e) => update(e.target.value, e.target.selectionStart)}
        onKeyDown={(e) => {
          if (matches.length) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((sel + 1) % matches.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((sel - 1 + matches.length) % matches.length); return; }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(matches[sel]); return; }
            if (e.key === 'Escape') { setQuery(null); return; }
          }
          if (e.key === 'Enter' && onSubmit && !e.nativeEvent.isComposing && ((e.metaKey || e.ctrlKey) || (enterSends && !e.shiftKey && !e.altKey))) { e.preventDefault(); onSubmit(); }
        }} />
    </div>
  );
}

/** Kürzel der Projekte, die die Person kennt (einmal je Sitzung geladen); bis dahin leer. */
let keysCache: Promise<string[]> | null = null;
export function useProjectKeys(): string[] {
  const [keys, setKeys] = useState<string[]>([]);
  useEffect(() => {
    keysCache ??= api.get<{ projects?: { key: string }[] }>('/projects').then((r) => (r?.projects ?? []).map((p) => String(p.key).toUpperCase())).catch(() => { keysCache = null; return []; });
    let live = true;
    void keysCache.then((k) => { if (live) setKeys(k); });
    return () => { live = false; };
  }, []);
  return keys;
}
/** Nur für Tests: Cache der Kürzel leeren. */
export const resetProjectKeys = () => { keysCache = null; };

/**
 * Rendert @Name der Mitglieder hervorgehoben und Kennungen wie WEB-12 als Link auf /k/WEB-12 (löst beim Öffnen auf und
 * leitet ins Board weiter). Mit keys nur Kennungen, deren Kürzel ein Projekt der Person ist; ohne keys jede Kennung.
 */
export function MentionText({ text, members, keys }: { text: string; members: Member[]; keys?: string[] }) {
  const names = [...members].sort((a, b) => b.name.length - a.name.length).map((m) => m.name);
  const nameRe = names.length ? `@(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}\\p{N}])` : null;
  const known = keys ? new Set(keys.map((k) => k.toUpperCase())) : null;
  const re = new RegExp(`${nameRe ? `${nameRe}|` : ''}(?<![\\p{L}\\p{N}-])([A-Z][A-Z0-9]{1,9}-[1-9]\\d{0,5})(?![\\p{L}\\p{N}])`, 'gu');
  const parts: (string | JSX.Element)[] = [];
  let last = 0; let m: RegExpExecArray | null; let i = 0;
  while ((m = re.exec(text))) {
    if (nameRe && m[1]) { parts.push(text.slice(last, m.index)); parts.push(<span key={i++} className="mention">@{m[1]}</span>); last = m.index + m[0].length; continue; }
    const code = m[nameRe ? 2 : 1];
    if (known && !known.has(code.slice(0, code.lastIndexOf('-')))) continue;
    parts.push(text.slice(last, m.index));
    parts.push(<Link key={i++} className="task-ref" to={`/k/${code}`} title={`${code} öffnen`}>{code}</Link>);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

/**
 * Weiterleitung /k/:ref (z. B. /k/WEB-12): sucht das Arbeitspaket (nur sichtbare) und öffnet es im Board; sonst ein Hinweis.
 * So lädt der Chat nichts je Nachricht, aufgelöst wird erst beim Klick.
 */
export function TaskRefRedirect() {
  const { ref = '' } = useParams();
  const nav = useNavigate();
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    const code = ref.toUpperCase();
    const cut = code.lastIndexOf('-');
    const [key, n] = [code.slice(0, cut), Number(code.slice(cut + 1))];
    let live = true;
    api.get<{ tasks: { id: string; number: number; projectId: string; projectKey: string }[] }>(`/search?q=${encodeURIComponent(code)}`)
      .then((r) => { const t = r?.tasks?.find((x) => x.projectKey.toUpperCase() === key && x.number === n); if (!live) return; if (t) nav(`/projekte/${t.projectId}/board?task=${t.id}`, { replace: true }); else setMissing(true); })
      .catch(() => { if (live) setMissing(true); });
    return () => { live = false; };
  }, [ref]);
  return missing ? <div className="pad-24"><p>{ref} gibt es nicht oder du darfst es nicht sehen.</p><Link to="/chat">Zurück zum Chat</Link></div> : <div className="pad-24 muted small" role="status">{ref} wird geöffnet …</div>;
}
