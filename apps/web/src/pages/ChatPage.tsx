import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { TopBar } from '../components/Layout';
import { Messenger } from '../components/Messenger';

/** Chat als Seite (mobil und für direkte Links): derselbe Messenger wie im Overlay, Auswahl in der Adresse. */
export function ChatPage() {
  const { cid } = useParams<{ cid?: string }>();
  const [params] = useSearchParams();
  const nav = useNavigate();
  return (
    <>
      <TopBar title="Chat" />
      <div className="content chat-page full">
        <Messenger channelId={cid ?? null} threadId={params.get('thread')} onSelect={(c, t) => nav(c ? `/chat/${c}${t ? `?thread=${t}` : ''}` : '/chat', { replace: Boolean(c && c === cid) })} />
      </div>
    </>
  );
}
