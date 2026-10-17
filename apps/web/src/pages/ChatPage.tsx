import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, fmtDateTime } from '../lib/api';
import { useData } from '../lib/useData';
import { TopBar } from '../components/Layout';
import { ChatPane } from '../components/ChatPane';

interface Conversation { channelId: string; partner: { id: string; name: string; email: string; active: boolean }; lastBody: string | null; lastAt: string | null; unread: number }

/** Direktnachrichten: Gespräche links, Verlauf rechts; neues Gespräch mit jeder Person des Mandanten. */
export function ChatPage() {
  const { cid } = useParams<{ cid?: string }>();
  const nav = useNavigate();
  const convs = useData<{ conversations: Conversation[] }>('/chat/dm', [cid]);
  const people = useData<{ people: { id: string; name: string; email: string }[] }>('/chat/people');
  const [pick, setPick] = useState('');
  const current = convs.data?.conversations.find((c) => c.channelId === cid);
  const start = async (userId: string) => {
    if (!userId) return;
    const r = await api.post<{ channelId: string }>('/chat/dm', { userId });
    setPick('');
    nav(`/chat/${r.channelId}`);
    await convs.reload();
  };
  return (
    <>
      <TopBar title="Chat" />
      <div className="content chat-page dm">
        <div className="dm-list">
          <select value={pick} onChange={(e) => void start(e.target.value)} title="Neues Gespräch">
            <option value="">Neues Gespräch mit …</option>
            {people.data?.people.filter((p) => !convs.data?.conversations.some((c) => c.partner.id === p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {convs.data?.conversations.map((c) => (
            <button key={c.channelId} className={`dm-item ${c.channelId === cid ? 'sel' : ''}`} onClick={() => nav(`/chat/${c.channelId}`)}>
              <div className="row between"><strong>{c.partner.name}</strong>{c.unread > 0 && <span className="badge danger">{c.unread}</span>}</div>
              <div className="muted small ell">{c.lastBody ?? '–'}</div>
              {c.lastAt && <div className="muted small">{fmtDateTime(c.lastAt)}</div>}
            </button>
          ))}
          {convs.data && convs.data.conversations.length === 0 && <div className="muted small" style={{ padding: 8 }}>Noch keine Gespräche. Oben eine Person wählen.</div>}
        </div>
        <div className="dm-pane">
          {cid && current ? <><div className="row between mb"><strong>{current.partner.name}</strong><span className="muted small">{current.partner.email}</span></div><ChatPane channelId={cid} members={[]} placeholder={`Nachricht an ${current.partner.name} … (Strg+Enter sendet)`} emptyText="Noch keine Nachrichten in diesem Gespräch." threads={false} /></>
            : cid && convs.data ? <div className="muted small">Gespräch nicht gefunden.</div>
              : <div className="muted small" style={{ padding: 24 }}>Gespräch links wählen oder ein neues beginnen.</div>}
        </div>
      </div>
    </>
  );
}
