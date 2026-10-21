import { api } from '../lib/api';
import { useNavigate } from 'react-router-dom';
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

/** Rendert @Name der Mitglieder hervorgehoben. */
export function MentionText({ text, members }: { text: string; members: Member[] }) {
  // @Namen hervorheben, Kennungen wie WEB-12 verlinken (öffnet das Arbeitspaket, wenn man es sehen darf)
  const names = [...members].sort((a, b) => b.name.length - a.name.length).map((m) => m.name);
  const nameRe = names.length ? `@(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}\\p{N}])` : null;
  const re = new RegExp(`${nameRe ? `${nameRe}|` : ''}(?<![\\p{L}\\p{N}-])([A-Z][A-Z0-9]{1,9}-\\d{1,6})(?![\\p{L}\\p{N}])`, 'gu');
  const parts: (string | JSX.Element)[] = [];
  let last = 0; let m: RegExpExecArray | null; let i = 0;
  while ((m = re.exec(text))) {
    parts.push(text.slice(last, m.index));
    if (nameRe && m[1]) parts.push(<span key={i++} className="mention">@{m[1]}</span>);
    else parts.push(<TaskRefLink key={i++} code={m[nameRe ? 2 : 1]} />);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

/** Kennung als Link: sucht das Arbeitspaket (nur sichtbare) und öffnet es im Board; sonst bleibt es Text. */
function TaskRefLink({ code }: { code: string }) {
  const nav = useNavigate();
  const open = async (e: React.MouseEvent) => {
    e.preventDefault();
    const [key, n] = [code.slice(0, code.lastIndexOf('-')), Number(code.slice(code.lastIndexOf('-') + 1))];
    const r = await api.get<{ tasks: { id: string; number: number; projectId: string; projectKey: string }[] }>(`/search?q=${encodeURIComponent(code)}`).catch(() => null);
    const t = r?.tasks.find((x) => x.projectKey.toUpperCase() === key.toUpperCase() && x.number === n);
    if (t) nav(`/projekte/${t.projectId}/board?task=${t.id}`);
  };
  return <a href="#" className="task-ref" title={`${code} öffnen`} onClick={(e) => void open(e)}>{code}</a>;
}
