import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { Membership } from '@projekttool/shared';
import { api } from '../lib/api';
import { useData } from '../lib/useData';
import { ChatPane } from './ChatPane';

export interface Conversation {
  channelId: string; kind: 'project' | 'dm'; title: string; subtitle: string | null; projectId: string | null; projectKey: string | null;
  partner: { id: string; name: string; email: string; kind: 'person' | 'agent'; active: boolean } | null;
  lastBody: string | null; lastUser: string | null; lastAt: string | null; unread: number;
}
interface Hit { id: string; channelId: string; threadId: string | null; body: string; createdAt: string; userName: string; kind: 'project' | 'dm'; title: string | null; projectKey: string | null }
interface Person { id: string; name: string; email: string; kind: 'person' | 'agent' }

/** Öffnet den Messenger (Desktop: Overlay unten rechts, mobil: Seite /chat), optional direkt mit Gespräch und Thread. */
export const MessengerCtx = createContext<(channelId?: string | null, threadId?: string | null, msgId?: string | null) => void>(() => undefined);
export const useOpenChat = () => useContext(MessengerCtx);

const short = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
};

/**
 * Messenger: links alle Gespräche (Projektkanäle, Direktnachrichten mit Personen und KI-Agenten) nach letzter Aktivität,
 * rechts der Verlauf. Oben die Suche über Gesprächsnamen und Nachrichten. Chat ist der reguläre Weg zwischen
 * Projektbeteiligten; Mail bleibt für Externe.
 */
export function Messenger({ channelId, threadId, msgId, onSelect, onClose, onRead }: {
  channelId: string | null; threadId?: string | null; /** Nachricht aus einem Deep-Link (hervorheben) */ msgId?: string | null; onSelect: (channelId: string | null, threadId?: string | null) => void; onClose?: () => void; onRead?: () => void;
}) {
  const [convs, setConvs] = useState<Conversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [picking, setPicking] = useState(false);
  const load = () => api.get<{ conversations: Conversation[] }>('/chat/conversations').then((r) => { setConvs(r.conversations); setError(null); }).catch((e) => setError(e.message));
  useEffect(() => { void load(); const h = setInterval(load, 15_000); return () => clearInterval(h); }, []);
  // Nach dem Öffnen eines Gesprächs sind seine Nachrichten gelesen: Liste und Zähler kurz danach auffrischen
  useEffect(() => { if (!channelId) return; const h = setTimeout(() => { void load(); onRead?.(); }, 800); return () => clearTimeout(h); }, [channelId]);
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const h = setTimeout(() => api.get<{ messages: Hit[] }>(`/chat/search?q=${encodeURIComponent(q.trim())}`).then((r) => setHits(r.messages)).catch(() => setHits([])), 250);
    return () => clearTimeout(h);
  }, [q]);
  const needle = q.trim().toLowerCase();
  const list = (convs ?? []).filter((c) => !needle || c.title.toLowerCase().includes(needle) || (c.subtitle ?? '').toLowerCase().includes(needle));
  const current = convs?.find((c) => c.channelId === channelId) ?? null;
  const start = async (p: Person) => {
    const r = await api.post<{ channelId: string }>('/chat/dm', { userId: p.id });
    setPicking(false); setQ('');
    await load();
    onSelect(r.channelId);
  };
  return (
    <div className={`messenger ${channelId ? 'has-sel' : ''}`}>
      <div className="msg-head">
        <strong>Chat</strong>
        <input type="search" placeholder="Gespräche und Nachrichten suchen …" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Chat durchsuchen" />
        <button className="btn sm" title="Neues Gespräch mit einer Person oder einem KI-Agenten" onClick={() => setPicking(!picking)}>+ Neu</button>
        {onClose && <button className="btn sm" title="Schließen" aria-label="Chat schließen" onClick={onClose}>✕</button>}
      </div>
      <div className="msg-body">
        <div className="msg-list">
          {picking && <PeoplePicker exclude={new Set((convs ?? []).filter((c) => c.partner).map((c) => c.partner!.id))} onPick={(p) => void start(p)} onCancel={() => setPicking(false)} />}
          {error && <div className="error small">{error}</div>}
          {!convs && !error && <div className="muted small" style={{ padding: 10 }}>Lade …</div>}
          {list.map((c) => (
            <button key={c.channelId} className={`msg-item ${c.channelId === channelId ? 'sel' : ''} ${c.unread ? 'unread' : ''}`} onClick={() => onSelect(c.channelId)}>
              <span className={`msg-avatar ${c.kind === 'project' ? 'proj' : c.partner?.kind === 'agent' ? 'agent' : ''}`}>{c.kind === 'project' ? (c.projectKey ?? '#').slice(0, 3) : c.partner?.kind === 'agent' ? 'KI' : initials(c.title)}</span>
              <span className="msg-main">
                <span className="row between"><span className="msg-title ell">{c.title}</span><span className="muted small nowrap">{short(c.lastAt)}</span></span>
                <span className="row between"><span className="muted small ell">{c.lastBody ? `${c.kind === 'project' && c.lastUser ? `${c.lastUser}: ` : ''}${c.lastBody}` : c.kind === 'project' ? `Projektkanal ${c.projectKey}` : c.subtitle}</span>{c.unread > 0 && <span className="badge danger">{c.unread}</span>}</span>
              </span>
            </button>
          ))}
          {convs && list.length === 0 && !hits.length && <div className="muted small" style={{ padding: 10 }}>{needle ? 'Kein Gespräch gefunden.' : 'Noch keine Gespräche. Über „+ Neu“ eine Person oder einen KI-Agenten anschreiben.'}</div>}
          {hits.length > 0 && <>
            <div className="msg-group">Nachrichten</div>
            {hits.map((h) => (
              <button key={h.id} className="msg-hit" onClick={() => { onSelect(h.channelId, h.threadId); }}>
                <span className="row between small"><strong className="ell">{h.kind === 'project' ? `${h.projectKey} · ${h.title}` : h.title}</strong><span className="muted nowrap">{short(h.createdAt)}</span></span>
                <span className="small ell"><span className="muted">{h.userName}:</span> {h.body}</span>
              </button>
            ))}
          </>}
        </div>
        <div className="msg-pane">
          {current ? <Conversation c={current} threadId={threadId ?? null} msgId={msgId ?? null} onBack={() => onSelect(null)} onThread={(t) => onSelect(current.channelId, t)} onSent={() => void load()} />
            : channelId && convs ? <div className="muted small" style={{ padding: 24 }}>Gespräch nicht gefunden oder nicht mehr zugänglich.</div>
              : <div className="msg-empty muted small">Gespräch links wählen. Chat ist der Weg zwischen Projektbeteiligten, auch mit KI-Agenten (im Projektkanal per @Name); Mail bleibt für Externe.</div>}
        </div>
      </div>
    </div>
  );
}

function initials(name: string) { return name.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]!.toUpperCase()).join(''); }

/** Verlauf eines Gesprächs; im Projektkanal mit Threads, @Erwähnung über Projektmitglieder (auch Agenten) und Moderation durch die PL. */
function Conversation({ c, threadId, msgId, onBack, onThread, onSent }: { c: Conversation; threadId: string | null; msgId: string | null; onBack: () => void; onThread: (id: string | null) => void; onSent: () => void }) {
  const detail = useData<{ project: { myMembership: Membership }; members: { userId: string; name: string; kind?: string }[] }>(c.projectId ? `/projects/${c.projectId}` : null, [c.projectId]);
  const members = useMemo(() => (detail.data?.members ?? []).map((m) => ({ userId: m.userId, name: m.name })), [detail.data]);
  const agentHint = c.partner?.kind === 'agent' ? ' Der Agent antwortet aus seinen Arbeitspaketen.' : '';
  return (
    <>
      <div className="msg-pane-head">
        <button className="btn sm msg-back" onClick={onBack} aria-label="Zurück zur Liste">←</button>
        <div className="ell"><strong>{c.title}</strong> <span className="muted small">{c.kind === 'project' ? `Projektkanal ${c.projectKey}` : c.partner?.kind === 'agent' ? 'KI-Agent' : c.partner?.email}</span></div>
      </div>
      <ChatPane key={c.channelId} channelId={c.channelId} members={members} canModerate={detail.data?.project.myMembership.role === 'pl'}
        threads initialThread={threadId} highlightId={msgId} onSent={onSent} onThreadChange={(t) => { if ((t ?? null) !== threadId) onThread(t); }}
        placeholder={c.kind === 'project' ? `Nachricht an ${c.projectKey} … (Enter sendet, @Name erwähnt)` : `Nachricht an ${c.title} … (Enter sendet)`}
        emptyText={c.kind === 'project' ? 'Noch keine Nachrichten im Projektkanal.' : `Noch keine Nachrichten.${agentHint}`} />
    </>
  );
}

function PeoplePicker({ exclude, onPick, onCancel }: { exclude: Set<string>; onPick: (p: Person) => void; onCancel: () => void }) {
  const d = useData<{ people: Person[] }>('/chat/people');
  const [f, setF] = useState('');
  const n = f.trim().toLowerCase();
  const list = (d.data?.people ?? []).filter((p) => !exclude.has(p.id) && (!n || p.name.toLowerCase().includes(n) || p.email.toLowerCase().includes(n)));
  return (
    <div className="msg-picker">
      <div className="row"><input type="text" autoFocus placeholder="Person oder KI-Agent …" value={f} onChange={(e) => setF(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); if (e.key === 'Enter' && list[0]) onPick(list[0]); }} /><button className="btn sm link" onClick={onCancel}>Abbrechen</button></div>
      <div className="msg-picker-list">
        {list.map((p) => <button key={p.id} className="msg-hit" onClick={() => onPick(p)}><span className="small"><strong>{p.name}</strong> <span className="muted">{p.kind === 'agent' ? 'KI-Agent' : p.email}</span></span></button>)}
        {d.data && list.length === 0 && <div className="muted small" style={{ padding: 6 }}>Niemand gefunden.</div>}
      </div>
    </div>
  );
}
