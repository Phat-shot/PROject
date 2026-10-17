import { useSearchParams } from 'react-router-dom';
import { useData } from '../../lib/useData';
import { ChatPane } from '../../components/ChatPane';
import { useProject } from '../ProjectPage';

/** Projektchat: ein Kanal für alle Mitglieder, Antworten als Thread (?thread=…). */
export function ChatView() {
  const { detail } = useProject();
  const [params, setParams] = useSearchParams();
  const ch = useData<{ channel: { id: string } }>(`/projects/${detail.project.id}/chat`, [detail.project.id]);
  if (ch.error) return <div className="content"><div className="error">{ch.error}</div></div>;
  if (!ch.data) return <div className="content muted">Lade …</div>;
  const members = detail.members.filter((m) => m.kind !== 'agent').map((m) => ({ userId: m.userId, name: m.name }));
  return (
    <div className="content chat-page">
      <p className="muted small" style={{ margin: '0 0 8px' }}>Chat der Projektmitglieder. @Name benachrichtigt die Person; Antworten bündeln sich im Thread. Für Entscheidungen und Stände bleibt das Log am Arbeitspaket die Quelle.</p>
      <ChatPane channelId={ch.data.channel.id} members={members} canModerate={detail.project.myMembership.role === 'pl'} initialThread={params.get('thread')}
        onThreadChange={(id) => { const n = new URLSearchParams(params); if (id) n.set('thread', id); else n.delete('thread'); setParams(n, { replace: true }); }} />
    </div>
  );
}
