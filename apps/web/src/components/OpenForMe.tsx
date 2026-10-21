import { Link } from 'react-router-dom';
import type { NotifyEvent, Question } from '@projekttool/shared';
import type { Waiting } from '../lib/useOpenForMe';
import { useOpenChat } from './Messenger';
import { NotifIcon } from './Notifications';

/**
 * „Offen für dich“: alles, was auf eine Entscheidung oder Handlung der Person wartet, als eine Liste unter den Kennzahlen:
 * Fragen, Entscheidungen und Bestätigungen, KI-Vorschläge, Vorschläge der Mail-KI, Mail-Entwürfe zur Freigabe, Seiten in
 * Prüfung, blockierte und eskalierte Arbeitspakete. Ersetzt einen eigenen Menüpunkt.
 */
export function OpenForMeList({ questions, waiting, projectId, bare = false, onNavigate }: { questions: Question[]; waiting: Waiting | null; projectId: string | null; /** ohne Karte und Überschrift (Glocke) */ bare?: boolean; /** nach Klick (z. B. Glocke schließen) */ onNavigate?: () => void }) {
  const openChat = useOpenChat();
  const inP = <T extends { projectId: string }>(xs: T[] | undefined) => (xs ?? []).filter((x) => !projectId || x.projectId === projectId);
  type Row = { key: string; icon: NotifyEvent; kind: string; projectKey: string; text: string; to?: string; onClick?: () => void; badge?: string };
  const qKind = (q: Question) => (q.kind === 'confirm' ? 'Bestätigung' : q.kind === 'decision' ? 'Entscheidung' : q.kind === 'approval' ? 'Freigabe' : 'Frage');
  const rows: Row[] = [
    ...questions.filter((q) => q.kind === 'decision' || q.kind === 'confirm' || q.kind === 'approval').map((q): Row => ({ key: `q${q.id}`, icon: q.kind === 'confirm' ? 'confirm' : q.kind === 'approval' ? 'approval' : 'decision', kind: qKind(q), projectKey: q.projectKey ?? '', text: `${q.askedByName ?? '?'}${q.taskCode ? ` zu ${q.taskCode}` : ''}: ${q.body.length > 110 ? `${q.body.slice(0, 110)} …` : q.body}`, onClick: () => { if (q.channelId) openChat(q.channelId, q.messageId, q.messageId); } })),
    ...inP(waiting?.proposals).map((p): Row => ({ key: `p${p.projectId}`, icon: 'review', kind: 'KI-Vorschläge', projectKey: p.projectKey, text: `${p.count} Vorschl${p.count === 1 ? 'ag wartet' : 'äge warten'} auf Freigabe`, to: `/projekte/${p.projectId}/ki` })),
    ...inP(waiting?.drafts).map((d): Row => ({ key: `d${d.projectId}`, icon: 'mail_in', kind: 'Mail-Entwürfe', projectKey: d.projectKey, text: `${d.count} Entw${d.count === 1 ? 'urf wartet' : 'ürfe warten'} auf Freigabe`, to: `/postfach/freigaben?projekt=${d.projectId}` })),
    ...inP(waiting?.mailSuggestions).map((m): Row => ({ key: `m${m.mailId}`, icon: 'mail_in', kind: 'Mail-KI', projectKey: m.projectKey, text: `Vorschläge zu „${m.subject.length > 80 ? `${m.subject.slice(0, 80)} …` : m.subject}“`, to: `/postfach/m/${m.mailId}?projekt=${m.projectId}` })),
    ...inP(waiting?.tasks).map((x): Row => ({ key: `t${x.id}`, icon: x.escalationLevel > 0 ? 'escalation' : 'blocked', kind: x.blocked ? 'Blockiert' : 'Eskaliert', projectKey: x.projectKey, text: `${x.projectKey}-${x.number} ${x.title}`, to: `/projekte/${x.projectId}/board?task=${x.id}`, badge: x.escalationLevel > 0 ? `Esk. ${x.escalationLevel}` : undefined })),
    ...inP(waiting?.pagesInReview).map((p): Row => ({ key: `s${p.id}`, icon: 'review', kind: 'Seite in Prüfung', projectKey: p.projectKey, text: p.title, to: `/projekte/${p.projectId}/doku/${p.id}` })),
    ...questions.filter((q) => q.kind !== 'decision' && q.kind !== 'confirm' && q.kind !== 'approval').map((q): Row => ({ key: `q${q.id}`, icon: 'question', kind: qKind(q), projectKey: q.projectKey ?? '', text: `${q.askedByName ?? '?'}${q.taskCode ? ` zu ${q.taskCode}` : ''}: ${q.body.length > 110 ? `${q.body.slice(0, 110)} …` : q.body}`, onClick: () => { if (q.channelId) openChat(q.channelId, q.messageId, q.messageId); } }))
  ];
  return (
    <div className={bare ? 'open-for-me bare' : 'card mb open-for-me'}>
      {!bare && <h2>Offen für dich {rows.length > 0 && <span className="badge warn">{rows.length}</span>}</h2>}
      {waiting && rows.length === 0 && <div className="muted small">Nichts offen.</div>}
      {rows.map((r) => {
        const body = <><NotifIcon event={r.icon} /><span className="k">{r.kind}</span>{!projectId && r.projectKey && <span className="badge">{r.projectKey}</span>}<span className="x">{r.text}</span>{r.badge && <span className="badge danger">{r.badge}</span>}</>;
        return r.to ? <Link key={r.key} className={`ofm ev-${r.icon}`} to={r.to} onClick={onNavigate}>{body}</Link> : <a key={r.key} className={`ofm ev-${r.icon}`} href="#" onClick={(e) => { e.preventDefault(); onNavigate?.(); r.onClick?.(); }}>{body}</a>;
      })}
    </div>
  );
}
