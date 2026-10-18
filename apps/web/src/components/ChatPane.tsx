import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../lib/auth';
import { api, fmtDateTime } from '../lib/api';
import { MentionInput, MentionText } from './MentionInput';
import { useDialog } from './ui';

export interface ChatMessage { id: string; channelId: string; userId: string; userName: string; threadId: string | null; body: string; mentions: string[]; replyCount: number; lastReplyAt: string | null; createdAt: string; editedAt: string | null; deleted: boolean }
interface Page { messages: ChatMessage[]; hasMore: boolean; canWrite?: boolean }
interface Member { userId: string; name: string }

const dayLabel = (iso: string) => new Date(iso).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

/**
 * Kanalansicht: Nachrichten (nach Tag gruppiert), Thread rechts, Eingabe mit @Erwähnung.
 * Holt alle 5 s neue Nachrichten und die Antworten des gerade offenen Threads; „Ältere laden“ blättert zurück.
 * Wer im Projektkanal nur mitliest (implizite Leser), sieht statt der Eingabe einen Hinweis.
 */
export function ChatPane({ channelId, members, canModerate, placeholder, initialThread, onThreadChange, onSent, emptyText, threads = true }: {
  channelId: string; members: Member[]; canModerate?: boolean; placeholder?: string; initialThread?: string | null; onThreadChange?: (id: string | null) => void; onSent?: () => void; emptyText?: string; threads?: boolean;
}) {
  const { user } = useAuth();
  const dialog = useDialog();
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [thread, setThread] = useState<string | null>(initialThread ?? null);
  // Das Intervall läuft je Kanal einmal; den aktuell offenen Thread liest es über die Referenz statt aus dem Closure
  const threadRef = useRef<string | null>(thread);
  const [canWrite, setCanWrite] = useState(true);
  const [replies, setReplies] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [reply, setReply] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const base = `/chat/channels/${channelId}/messages`;

  const load = async () => {
    try {
      const p = await api.get<Page>(base);
      setMsgs(p.messages); setHasMore(p.hasMore); setCanWrite(p.canWrite !== false); setError(null);
    } catch (e) { setError((e as Error).message); }
  };
  const loadThread = async (id: string) => {
    try { setReplies((await api.get<Page>(`${base}?thread=${id}`)).messages); } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { setMsgs([]); setThread(initialThread ?? null); void load(); const h = setInterval(() => { void load(); if (threadRef.current) void loadThread(threadRef.current); }, 5000); return () => clearInterval(h); }, [channelId]);
  useEffect(() => { threadRef.current = thread; if (thread) void loadThread(thread); else setReplies([]); onThreadChange?.(thread); }, [thread]);
  // Thread von außen öffnen (z. B. Suchtreffer im Messenger), ohne den Kanal neu zu laden
  useEffect(() => { if (initialThread !== undefined && (initialThread ?? null) !== thread) setThread(initialThread ?? null); }, [initialThread]);
  useEffect(() => { const el = listRef.current; if (el && stickBottom.current) el.scrollTop = el.scrollHeight; }, [msgs.length]);
  const onScroll = () => { const el = listRef.current; if (!el) return; stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; };
  const older = async () => {
    if (!msgs.length) return;
    const el = listRef.current; const h0 = el?.scrollHeight ?? 0;
    const p = await api.get<Page>(`${base}?before=${encodeURIComponent(msgs[0].createdAt)}`);
    setMsgs((m) => [...p.messages, ...m]); setHasMore(p.hasMore);
    requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - h0; });
  };
  const send = async (body: string, threadId: string | null) => {
    if (!body.trim()) return;
    try {
      await api.post(base, { body: body.trim(), threadId });
      if (threadId) { setReply(''); await loadThread(threadId); } else { setText(''); stickBottom.current = true; }
      await load();
      onSent?.();
    } catch (e) { setError((e as Error).message); }
  };
  const remove = async (m: ChatMessage) => {
    if (!(await dialog.confirm({ title: 'Nachricht löschen', text: 'Diese Nachricht löschen?', confirmLabel: 'Löschen', danger: true }))) return;
    await api.del(`/chat/messages/${m.id}`);
    await load(); if (thread) await loadThread(thread);
  };
  const saveEdit = async () => {
    if (!editing) return;
    await api.patch(`/chat/messages/${editing.id}`, { body: editing.body });
    setEditing(null); await load(); if (thread) await loadThread(thread);
  };
  const Msg = ({ m, inThread }: { m: ChatMessage; inThread: boolean }) => (
    <div className={`chat-msg ${m.userId === user?.id ? 'mine' : ''} ${m.deleted ? 'deleted' : ''}`}>
      <div className="chat-head"><strong>{m.userName}</strong><span className="muted small">{timeLabel(m.createdAt)}{m.editedAt ? ' · bearbeitet' : ''}</span>
        {!m.deleted && m.userId === user?.id && <button className="btn sm link" title="Bearbeiten" onClick={() => setEditing({ id: m.id, body: m.body })}>✎</button>}
        {!m.deleted && (m.userId === user?.id || canModerate) && <button className="btn sm link" title="Löschen" onClick={() => void remove(m)}>✕</button>}
      </div>
      {editing?.id === m.id
        ? <div className="form"><textarea value={editing.body} autoFocus onChange={(e) => setEditing({ ...editing, body: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void saveEdit(); if (e.key === 'Escape') setEditing(null); }} /><div className="row"><button className="btn sm primary" onClick={() => void saveEdit()}>Speichern</button><button className="btn sm" onClick={() => setEditing(null)}>Abbrechen</button></div></div>
        : <div className="chat-body">{m.deleted ? <span className="muted">(gelöscht)</span> : <MentionText text={m.body} members={members} />}</div>}
      {threads && !inThread && (m.replyCount > 0 || !m.deleted) && (
        <button className="btn sm link chat-thread-btn" onClick={() => setThread(m.id)}>{m.replyCount > 0 ? `${m.replyCount} Antwort${m.replyCount === 1 ? '' : 'en'}${m.lastReplyAt ? ` · ${fmtDateTime(m.lastReplyAt)}` : ''}` : 'Antworten'}</button>
      )}
    </div>
  );
  const root = thread ? msgs.find((m) => m.id === thread) : null;
  let lastDay = '';
  return (
    <div className={`chat ${thread ? 'with-thread' : ''}`}>
      <div className="chat-main">
        {error && <div className="error mb">{error}</div>}
        <div className="chat-list" ref={listRef} onScroll={onScroll}>
          {hasMore && <div className="center"><button className="btn sm" onClick={() => void older()}>Ältere laden</button></div>}
          {msgs.length === 0 && <div className="muted small center" style={{ padding: 24 }}>{emptyText ?? 'Noch keine Nachrichten.'}</div>}
          {msgs.map((m) => { const d = dayLabel(m.createdAt); const sep = d !== lastDay; lastDay = d; return <div key={m.id}>{sep && <div className="chat-day">{d}</div>}<Msg m={m} inThread={false} /></div>; })}
        </div>
        {canWrite ? <div className="chat-compose">
          <MentionInput value={text} onChange={setText} members={members} placeholder={placeholder ?? 'Nachricht … (@Name erwähnt, Strg+Enter sendet)'} onSubmit={() => void send(text, null)} />
          <button className="btn primary" disabled={!text.trim()} onClick={() => void send(text, null)}>Senden</button>
        </div> : <div className="muted small chat-compose">Im Projektkanal schreiben nur Mitglieder des Projekts; du liest mit.</div>}
      </div>
      {thread && (
        <div className="chat-thread">
          <div className="row between mb"><strong>Thread</strong><button className="btn sm" onClick={() => setThread(null)}>✕</button></div>
          {root ? <Msg m={root} inThread /> : <div className="muted small">Ursprungsnachricht nicht mehr in der Ansicht.</div>}
          <div className="chat-replies">{replies.map((m) => <Msg key={m.id} m={m} inThread />)}</div>
          {canWrite && <div className="chat-compose">
            <MentionInput value={reply} onChange={setReply} members={members} placeholder="Antworten …" onSubmit={() => void send(reply, thread)} />
            <button className="btn primary" disabled={!reply.trim()} onClick={() => void send(reply, thread)}>Antworten</button>
          </div>}
        </div>
      )}
    </div>
  );
}
