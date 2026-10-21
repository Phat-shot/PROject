import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MailDraft, Question } from '@projekttool/shared';
import { useAuth } from '../lib/auth';
import { api, fmtDateTime } from '../lib/api';
import { MentionInput, MentionText } from './MentionInput';
import { useDialog } from './ui';
import { ApprovalCard } from './AgentPolicy';
import { Thumbs, useRating } from './Rating';

export interface ChatMessage { id: string; channelId: string; userId: string | null; userName: string; /** von einem KI-Agenten (bewertbar) */ fromAgent?: boolean; /** eigene Bewertung (👍 1, 👎 -1) */ myRating?: 1 | -1 | null; threadId: string | null; body: string; mentions: string[]; replyCount: number; lastReplyAt: string | null; createdAt: string; editedAt: string | null; deleted: boolean; /** system: Systembeitrag (Meldung, Karte) mit meta.link; nicht bearbeitbar */ kind?: 'user' | 'system'; meta?: { link?: string | null; event?: string; /** Systemkarte der Chat-Steuerung: Ergebnisse je Befehl, Auftrag mit Rückgängig, Freigabe */ card?: 'results'; results?: { type: string; status: 'ok' | 'held' | 'denied'; text: string; link?: string | null }[]; taskId?: string | null; undoUntil?: string | null; approvalQuestionId?: string | null } | null }
interface Page { messages: ChatMessage[]; hasMore: boolean; canWrite?: boolean }
interface Member { userId: string; name: string }

const dayLabel = (iso: string) => new Date(iso).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

/**
 * Kanalansicht: Nachrichten (nach Tag gruppiert), Thread rechts, Eingabe mit @Erwähnung.
 * Holt alle 5 s neue Nachrichten und die Antworten des gerade offenen Threads; „Ältere laden“ blättert zurück.
 * Wer im Projektkanal nur mitliest (implizite Leser), sieht statt der Eingabe einen Hinweis.
 */
export function ChatPane({ channelId, members, canModerate, placeholder, initialThread, highlightId, onThreadChange, onSent, emptyText, threads = true }: {
  channelId: string; members: Member[]; canModerate?: boolean; placeholder?: string; initialThread?: string | null; /** Nachricht aus einem Deep-Link (?msg=): hinscrollen und hervorheben */ highlightId?: string | null; onThreadChange?: (id: string | null) => void; onSent?: () => void; emptyText?: string; threads?: boolean;
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
  // Frage zur Thread-Wurzel (Status, Auswahl, Erledigt): aus GET /chat/messages/:id, bei jedem Thread-Wechsel und nach Antworten neu
  const [question, setQuestion] = useState<Question | null>(null);
  const [highlight, setHighlight] = useState<string | null>(highlightId ?? null);
  const replyBox = useRef<HTMLDivElement>(null);
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
    try { setQuestion((await api.get<{ question: Question | null }>(`/chat/messages/${id}`)).question); } catch { setQuestion(null); }
  };
  useEffect(() => { setMsgs([]); setThread(initialThread ?? null); void load(); const h = setInterval(() => { void load(); if (threadRef.current) void loadThread(threadRef.current); }, 5000); return () => clearInterval(h); }, [channelId]);
  useEffect(() => { threadRef.current = thread; if (thread) void loadThread(thread); else { setReplies([]); setQuestion(null); } onThreadChange?.(thread); }, [thread]);
  // Deep-Link: zur Nachricht scrollen, hervorheben, Fokus ins Antwortfeld des Threads
  useEffect(() => { setHighlight(highlightId ?? null); }, [highlightId]);
  useEffect(() => {
    if (!highlight) return;
    const el = document.getElementById(`msg-${highlight}`);
    if (el) { el.scrollIntoView({ block: 'center' }); replyBox.current?.querySelector('textarea, input')?.dispatchEvent(new Event('focus')); (replyBox.current?.querySelector('textarea, input') as HTMLElement | null)?.focus(); }
    const h = setTimeout(() => setHighlight(null), 4000);
    return () => clearTimeout(h);
  }, [highlight, msgs.length, replies.length]);
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
  // Feld sofort leeren (wirkt flüssiger); schlägt das Senden fehl, kommt der Text zurück
  const sending = useRef(false);
  const send = async (body: string, threadId: string | null) => {
    if (!body.trim() || sending.current) return;
    sending.current = true;
    const clear = threadId ? setReply : setText;
    clear('');
    if (!threadId) stickBottom.current = true;
    try {
      await api.post(base, { body: body.trim(), threadId });
      setError(null);
      if (threadId) await loadThread(threadId);
      await load();
      onSent?.();
    } catch (e) { clear(body); setError((e as Error).message); }
    finally { sending.current = false; }
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
  // KI-Feedback: Antworten der Agenten bewerten (Zustand sofort in Liste und Thread)
  const rating = useRating(async (id, v, comment) => {
    const r = await api.post<{ rating: 1 | -1 | null }>(`/chat/messages/${id}/rating`, { rating: v, comment: comment || null });
    const upd = (list: ChatMessage[]) => list.map((x) => (x.id === id ? { ...x, myRating: r.rating } : x));
    setMsgs(upd); setReplies(upd);
  });
  const system = (m: ChatMessage) => m.kind === 'system';
  const isQuestion = (m: ChatMessage) => Boolean((m.meta as any)?.questionId);
  // Als Funktion aufgerufen (nicht als Komponente): sonst baut jedes Neuladen die Karten neu auf und verwirft Eingaben
  const Msg = ({ m, inThread }: { m: ChatMessage; inThread: boolean }) => (
    <div id={`msg-${m.id}`} className={`chat-msg ${!system(m) && m.userId === user?.id ? 'mine' : ''} ${system(m) ? 'system' : ''} ${m.deleted ? 'deleted' : ''} ${highlight === m.id ? 'highlight' : ''}`}>
      <div className="chat-head">{system(m) && <span className="badge" title="Systembeitrag nach den Benachrichtigungsregeln">System</span>}{isQuestion(m) && <span className="badge" title="Offene Frage: Antwort hier im Thread oder im Arbeitspaket">{(m.meta as any).kind === 'confirm' ? 'Bestätigung' : (m.meta as any).kind === 'decision' ? 'Entscheidung' : 'Frage'}</span>}{(!system(m) || m.userId) && <strong>{m.userName}</strong>}<span className="muted small">{timeLabel(m.createdAt)}{m.editedAt ? ' · bearbeitet' : ''}</span>
        {!m.deleted && !system(m) && m.userId === user?.id && <button className="btn sm link" title="Bearbeiten" onClick={() => setEditing({ id: m.id, body: m.body })}>✎</button>}
        {!m.deleted && ((!system(m) && m.userId === user?.id) || canModerate) && <button className="btn sm link" title="Löschen" onClick={() => void remove(m)}>✕</button>}
      </div>
      {editing?.id === m.id
        ? <div className="form"><textarea value={editing.body} autoFocus onChange={(e) => setEditing({ ...editing, body: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void saveEdit(); } if (e.key === 'Escape') setEditing(null); }} /><div className="row"><button className="btn sm primary" onClick={() => void saveEdit()}>Speichern</button><button className="btn sm" onClick={() => setEditing(null)}>Abbrechen</button></div></div>
        : <div className="chat-body">{m.deleted ? <span className="muted">(gelöscht)</span> : system(m) ? m.body : <MentionText text={m.body} members={members} />}</div>}
      {m.fromAgent && !m.deleted && <Thumbs value={m.myRating} onRate={(v) => rating.rate(m.id, m.myRating, v)} />}
      {!m.deleted && m.meta?.link && (system(m) || !('question' in m.meta)) && <Link className="btn sm link" to={m.meta.link}>Öffnen</Link>}
      {system(m) && !m.deleted && (m.meta as any)?.card === 'draft' && <DraftCard draftId={String((m.meta as any).draftId)} />}
      {system(m) && !m.deleted && m.meta?.card === 'results' && <ResultsCard m={m} onChanged={() => { void load(); if (thread) void loadThread(thread); }} />}
      {threads && !inThread && (m.replyCount > 0 || !m.deleted) && (
        <button className="btn sm link chat-thread-btn" onClick={() => setThread(m.id)}>{m.replyCount > 0 ? `${m.replyCount} Antwort${m.replyCount === 1 ? '' : 'en'}${m.lastReplyAt ? ` · ${fmtDateTime(m.lastReplyAt)}` : ''}` : 'Antworten'}</button>
      )}
    </div>
  );
  const root = thread ? msgs.find((m) => m.id === thread) : null;
  let lastDay = '';
  return (
    <div className={`chat ${thread ? 'with-thread' : ''}`}>
      {rating.modal}
      <div className="chat-main">
        {error && <div className="error mb">{error}</div>}
        <div className="chat-list" ref={listRef} onScroll={onScroll}>
          {hasMore && <div className="center"><button className="btn sm" onClick={() => void older()}>Ältere laden</button></div>}
          {msgs.length === 0 && <div className="muted small center" style={{ padding: 24 }}>{emptyText ?? 'Noch keine Nachrichten.'}</div>}
          {msgs.map((m) => { const d = dayLabel(m.createdAt); const sep = d !== lastDay; lastDay = d; return <div key={m.id}>{sep && <div className="chat-day">{d}</div>}{Msg({ m, inThread: false })}</div>; })}
        </div>
        {canWrite ? <div className="chat-compose">
          <MentionInput value={text} onChange={setText} members={members} placeholder={placeholder ?? 'Nachricht … (Enter sendet, Umschalt+Enter neue Zeile, @Name erwähnt)'} onSubmit={() => void send(text, null)} enterSends />
          <button className="btn primary" disabled={!text.trim()} onClick={() => void send(text, null)}>Senden</button>
        </div> : <div className="muted small chat-compose">Im Projektkanal schreiben nur Mitglieder des Projekts; du liest mit.</div>}
      </div>
      {thread && (
        <div className="chat-thread">
          <div className="row between mb"><strong>Thread</strong><button className="btn sm" onClick={() => setThread(null)}>✕</button></div>
          {question && <QuestionHead q={question} onChanged={() => { void loadThread(thread); void load(); }} />}
          {root ? Msg({ m: root, inThread: true }) : <div className="muted small">Ursprungsnachricht nicht mehr in der Ansicht.</div>}
          <div className="chat-replies">{replies.map((m) => <div key={m.id}>{Msg({ m, inThread: true })}</div>)}</div>
          {canWrite && <div className="chat-compose" ref={replyBox}>
            <MentionInput value={reply} onChange={setReply} members={members} placeholder="Antworten … (Enter sendet)" onSubmit={() => void send(reply, thread)} enterSends />
            <button className="btn primary" disabled={!reply.trim()} onClick={() => void send(reply, thread)}>Antworten</button>
          </div>}
        </div>
      )}
    </div>
  );
}

/**
 * Thread-Kopf einer Frage: Bezug, Status (offen, beantwortet von … in der Aufgabe, weitergegeben, erledigt), Auswahl als Knöpfe,
 * „Im AP öffnen“ und „Erledigt“ (fragende Person, Adressat oder PL). Antworten im Thread bleiben möglich.
 */
/** Karte der Chat-Steuerung (Konzept 7): Rückgängig für einen eben angelegten Auftrag (10 Minuten) und die Freigabekarte zu offenen Bestätigungen. */
function ResultsCard({ m, onChanged }: { m: ChatMessage; onChanged: () => void }) {
  const [q, setQ] = useState<Question | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const qid = m.meta?.approvalQuestionId ?? null;
  useEffect(() => { if (qid) api.get<{ question: Question }>(`/questions/${qid}`).then((r) => setQ(r.question)).catch(() => undefined); }, [qid]);
  const undoable = Boolean(m.meta?.taskId && m.meta?.undoUntil && new Date(m.meta.undoUntil).getTime() > Date.now()) && !gone;
  return <div className="small mt">
    {undoable && <button className="btn sm" title="Den eben angelegten Auftrag zurücknehmen (archivieren); nur Auftraggeber oder PL, 10 Minuten" onClick={() => void api.post(`/tasks/${m.meta!.taskId}/undo-order`).then(() => { setGone(true); onChanged(); }).catch((e) => setError((e as Error).message))}>Rückgängig</button>}
    {q && <ApprovalCard q={q} onChanged={() => { void api.get<{ question: Question }>(`/questions/${q.id}`).then((r) => setQ(r.question)); onChanged(); }} />}
    {error && <div className="error small">{error}</div>}
  </div>;
}

/**
 * Mail-Entwurf des persönlichen Assistenten als Karte: Empfänger, Betreff, Text; Senden, Ändern (direkt in der Karte), Verwerfen.
 * Gesendet oder verworfen zeigt die Karte nur noch den Stand.
 */
function DraftCard({ draftId }: { draftId: string }) {
  const [d, setD] = useState<MailDraft | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ subject: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.get<{ draft: MailDraft }>(`/mail/drafts/${draftId}`).then((r) => setD(r.draft)).catch((e) => setGone((e as Error).message));
  useEffect(() => { void load(); }, [draftId]);
  const act = async (fn: () => Promise<unknown>, after?: string) => { setBusy(true); try { await fn(); setError(null); if (after) setGone(after); else await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  if (gone) return <div className="draft-card small muted">{gone}</div>;
  if (!d) return null;
  const sent = d.status === 'sent';
  return (
    <div className="draft-card small">
      <div><span className="muted">An:</span> {d.toAddrs.join(', ')}</div>
      {edit ? <div className="form mt">
        <input type="text" aria-label="Betreff" value={edit.subject} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} />
        <textarea aria-label="Text" rows={8} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
      </div> : <>
        <div><span className="muted">Betreff:</span> <strong>{d.subject}</strong></div>
        <div className="draft-body">{d.body}</div>
      </>}
      {error && <div className="error">{error}</div>}
      {sent ? <div className="mt"><span className="badge ok">gesendet</span></div> : <div className="row mt" style={{ flexWrap: 'wrap', gap: 6 }}>
        {edit
          ? <><button className="btn sm primary" disabled={busy} onClick={() => void act(async () => { await api.patch(`/mail/drafts/${d.id}`, edit); await api.post(`/mail/drafts/${d.id}/send`); setEdit(null); })}>Speichern und senden</button><button className="btn sm" disabled={busy} onClick={() => void act(async () => { await api.patch(`/mail/drafts/${d.id}`, edit); setEdit(null); })}>Nur speichern</button><button className="btn sm link" onClick={() => setEdit(null)}>Abbrechen</button></>
          : <><button className="btn sm primary" disabled={busy} onClick={() => void act(() => api.post(`/mail/drafts/${d.id}/send`))}>Senden</button><button className="btn sm" disabled={busy} onClick={() => setEdit({ subject: d.subject, body: d.body })}>Ändern</button><button className="btn sm danger" disabled={busy} onClick={() => void act(() => api.del(`/mail/drafts/${d.id}`), 'Entwurf verworfen.')}>Verwerfen</button></>}
      </div>}
    </div>
  );
}

function QuestionHead({ q, onChanged }: { q: Question; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); setError(null); onChanged(); } catch (e) { setError((e as Error).message); } };
  const kind = q.kind === 'confirm' ? 'Bestätigung' : q.kind === 'decision' ? 'Entscheidung' : q.kind === 'external_referral' ? 'Rückfrage von extern' : q.kind === 'approval' ? 'Freigabe' : 'Frage';
  const status = q.status === 'open' ? 'offen' : q.status === 'answered' ? `beantwortet von ${q.answeredByName ?? '?'}${q.answerSource === 'task' ? ' in der Aufgabe' : q.answerSource === 'meeting' ? ' (Termin bestätigt)' : q.answerSource === 'chat' ? ' im Chat' : ''}` : q.status === 'escalated' ? 'weitergegeben' : `erledigt${q.cancelReason ? `: ${q.cancelReason}` : ''}`;
  return (
    <div className={`question-head ${q.status}`}>
      <div className="row between small"><span><strong>{kind}</strong>{q.taskCode && <> zu <Link to={`/projekte/${q.projectId}/board?task=${q.taskId}`}>{q.taskCode}</Link></>} · {status}</span>
        <span className="row">{q.taskId && <Link className="btn sm link" to={`/projekte/${q.projectId}/board?task=${q.taskId}`}>Im AP öffnen</Link>}{q.status === 'open' && <button className="btn sm link" title="Frage ohne Antwort schließen" onClick={() => void act(() => api.post(`/questions/${q.id}/cancel`, {}))}>Erledigt</button>}</span></div>
      {q.status === 'open' && q.options && q.options.length > 0 && <div className="row mt" style={{ gap: 6 }}>{q.options.map((o) => <button key={o.key} className="btn sm primary" onClick={() => void act(() => api.post(`/questions/${q.id}/answer`, { option: o.key }))}>{o.label}</button>)}</div>}
      {q.kind === 'approval' && <ApprovalCard q={q} onChanged={onChanged} />}
      {q.status === 'answered' && q.answerText && <div className="small muted mt">{q.answerOption && q.options ? `${q.options.find((o) => o.key === q.answerOption)?.label ?? q.answerOption}: ` : ''}{q.answerText}</div>}
      {error && <div className="error small mt">{error}</div>}
    </div>
  );
}
