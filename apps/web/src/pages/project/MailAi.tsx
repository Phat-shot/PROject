import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MailAccount, MailAiRun } from '@projekttool/shared';
import { api, fmtDateTime } from '../../lib/api';
import { useData } from '../../lib/useData';
import { Modal, useAsync } from '../../components/ui';
import { useProject } from '../ProjectPage';
import type { ViewRow } from './MailView';

const STATUS: Record<MailAiRun['status'], string> = { queued: 'wartet', running: 'läuft', ok: 'fertig', error: 'mit Fehlern', skipped: 'übersprungen' };
const ACTION_STATUS: Record<string, [string, string]> = { done: ['erledigt', 'ok'], approved: ['angenommen', 'ok'], rejected: ['verworfen', ''], pending: ['offen', 'warn'], error: ['Fehler', 'danger'] };
const when = (s?: string) => (s ? s.replace('T', ' ') : '');

function label(a: MailAiRun['actions'][number]): string {
  switch (a.type) {
    case 'create_ap': return `Arbeitspaket „${a.title ?? ''}“${a.responsible ? ` · ${a.responsible}` : ''}${a.dueDate ? ` · fällig ${a.dueDate}` : ''}`;
    case 'create_aufgabe': return `Aufgabe „${a.title ?? ''}“ in ${a.ref ?? '?'}${a.responsible ? ` · ${a.responsible}` : ''}${a.dueDate ? ` · fällig ${a.dueDate}` : ''}`;
    case 'link': return `Zu ${a.ref ?? '?'}${a.text ? `: ${a.text}` : ''}`;
    case 'create_event': return `Termin „${a.title ?? ''}“ ${when(a.startsAt)}${a.location ? ` · ${a.location}` : ''}`;
    case 'reply_draft': return `Antwortentwurf: ${(a.text ?? '').slice(0, 140)}${(a.text ?? '').length > 140 ? ' …' : ''}`;
    case 'move': return `Ablage: ${a.folder ?? 'Archiv'}`;
    default: return `Nichts zu tun${a.reason ? `: ${a.reason}` : ''}`;
  }
}

/** Ein Lauf eines Agenten an der Mail: ausgeführt (als stellvertretende PL) oder Vorschläge (als Mitglied) mit Annehmen/Verwerfen. */
export function MailAiRunCard({ run, showMail = false, onChanged }: { run: MailAiRun; showMail?: boolean; onChanged: () => Promise<void> | void }) {
  const { detail, openTask } = useProject();
  const base = `/projekte/${detail.project.id}`;
  const { busy, error, run: exec } = useAsync();
  const decide = (index: number | 'all', approve: boolean) => exec(async () => { await api.post(`/mail/ai-runs/${run.id}/decide`, { index, approve }); await onChanged(); });
  const open = run.mode === 'triage' ? run.actions.filter((a) => a.status === 'pending' || a.status === 'error').length : 0;
  return (
    <div className="ai-proposal">
      <div className="row between">
        <div><span className="badge">{run.mode === 'process' ? `${run.agentName ?? 'Agent'} hat bearbeitet` : `Vorschläge von ${run.agentName ?? 'Agent'}`}</span>{run.openPoints && run.openPoints.length > 0 && <span className="badge warn" style={{ marginLeft: 4 }} title={run.openPoints.join(' · ')}>{run.openPoints.length} offen</span>}{showMail && run.mail && <> <Link to={`${base}/mail/m/${run.mail.id}`}>{run.mail.subject || '(kein Betreff)'}</Link> <span className="muted small">von {run.mail.fromName ?? run.mail.fromAddr}</span></>}</div>
        <span className="muted small">{STATUS[run.status]}{run.requestedBy ? ` · auf Anfrage von ${run.requestedBy} (Antwort per Chat)` : ''} · {fmtDateTime(run.createdAt)}</span>
      </div>
      {run.summary && <div className="small mt">{run.summary}</div>}
      {run.error && run.status !== 'ok' && <div className="small muted">{run.error}</div>}
      {error && <div className="error small">{error}</div>}
      {run.actions.length > 0 && <ul className="ai-actions">
        {run.actions.map((a, i) => {
          const [st, cls] = ACTION_STATUS[a.status] ?? [a.status, ''];
          const r = a.result ?? {};
          return <li key={i}>
            <span className="small">{label(a)}</span> <span className={`badge ${cls}`}>{st}</span>
            {r.taskId && <button className="btn sm link" onClick={() => openTask(r.taskId!)}>{r.ref ?? 'öffnen'}</button>}
            {r.meetingId && <Link className="btn sm link" to={`${base}/besprechungen`}>Kalender</Link>}
            {r.draftId && <Link className="btn sm link" to={`${base}/mail/freigaben`}>Entwurf</Link>}
            {r.draftId && r.hints ? <span className="small" style={{ color: 'var(--warn)' }} title="Der Entwurf nennt Inhalte, die Externe nicht erfahren sollen; Details unter Mail › Freigaben">{r.hints} {r.hints === 1 ? 'Hinweis' : 'Hinweise'} der Außenprüfung</span> : null}
            {r.error && <span className="muted small"> {r.error}</span>}
            {run.mode === 'triage' && (a.status === 'pending' || a.status === 'error') && <span className="row" style={{ display: 'inline-flex', gap: 4, marginLeft: 6 }}>
              <button className="btn sm primary" disabled={busy} onClick={() => void decide(i, true)}>Annehmen</button>
              <button className="btn sm" disabled={busy} onClick={() => void decide(i, false)}>Verwerfen</button>
            </span>}
          </li>;
        })}
      </ul>}
      {open > 1 && <div className="row mt"><button className="btn sm primary" disabled={busy} onClick={() => void decide('all', true)}>Alle annehmen</button><button className="btn sm" disabled={busy} onClick={() => void decide('all', false)}>Alle verwerfen</button></div>}
    </div>
  );
}

/** An der Mail: „Agent übernimmt“ (ein Agent als stellvertretende PL legt sofort an) und was Agenten damit gemacht haben bzw. vorschlagen. */
export function MailAiBox({ mailId, accountId, outgoing, views, canCreateTask, data }: { mailId: string; accountId: string; outgoing: boolean; views: ViewRow[]; canCreateTask: boolean; data: { data: { runs: MailAiRun[]; suggestAgent: { id: string; name: string; canProcess: boolean } | null } | null; reload: () => Promise<unknown> } }) {
  const { detail, reloadTasks } = useProject();
  const d = data;
  const agent = d.data?.suggestAgent ?? null;
  const { busy, error, run } = useAsync();
  const busyRun = d.data?.runs.some((r) => r.status === 'queued' || r.status === 'running');
  // Solange ein Lauf wartet oder läuft, kurz nachsehen
  useEffect(() => { if (!busyRun) return; const h = setInterval(() => void d.reload(), 3000); return () => clearInterval(h); }, [busyRun, d.reload]);
  const kiView = views.find((v) => v.aiProcess && v.accountId === accountId && v.projectId === detail.project.id);
  const processed = d.data?.runs.some((r) => r.mode === 'process');
  const reload = async () => { await d.reload(); await reloadTasks(); };
  if (!d.data) return null;
  const canProcess = Boolean(agent?.canProcess) && !processed && !outgoing && canCreateTask;
  const why = !agent ? 'Kein Agent im Projekt (Projektagent unter Einstellungen › Projekt oder Agent an der Mail-Ansicht)' : !agent.canProcess ? `${agent.name} ist Mitglied, nicht (stellvertretende) Projektleitung: nur Vorschläge` : processed ? 'Diese Mail wurde schon bearbeitet' : outgoing ? 'Gesendete Mails bearbeitet die KI nicht' : !canCreateTask ? 'Erfordert das Recht „Arbeitspaket erzeugen“' : `${agent.name} legt sofort an: Arbeitspaket oder Aufgabe mit Ursprungsmail, Termin, Antwortentwurf, Ablage${kiView ? ` (die Mail wandert in den Ordner „${(kiView.filter.folders ?? [])[0] ?? kiView.name}“)` : ''}`;
  return (
    <div className="mb">
      <div className="row mb small">
        <span className="muted" title="Ein Agent, der stellvertretende Projektleitung ist, bearbeitet die Mail sofort mit seinen Rechten">Agent übernimmt{agent?.canProcess ? ` (${agent.name})` : ''}:</span>
        <button className="btn sm" disabled={!canProcess || busy} title={why} onClick={() => void run(async () => { await api.post(`/mail/mails/${mailId}/ai-process`, { projectId: detail.project.id }); await d.reload(); })}>Bearbeiten lassen</button>
        {!canProcess && <span className="muted">{why}</span>}
      </div>
      {error && <div className="error small">{error}</div>}
      {d.data.runs.map((r) => <MailAiRunCard key={r.id} run={r} onChanged={reload} />)}
    </div>
  );
}

/** Einstellungen › Mail: Ordner „KI Bearbeiten“ für ein Konto einrichten. */
export function AiFolderDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { detail } = useProject();
  const accounts = useData<{ accounts: MailAccount[]; personalAccounts: MailAccount[] }>(`/projects/${detail.project.id}/mail/accounts`);
  const isPl = detail.project.myMembership.role === 'pl';
  // Projektkonten (PL) über die Projektbindung, eigene Konten über die persönliche Bindung
  const usable = [...(isPl ? (accounts.data?.accounts ?? []).map((a) => ({ ...a, via: 'Projektkonto' })) : []), ...(accounts.data?.personalAccounts ?? []).filter((a) => !(accounts.data?.accounts ?? []).some((x) => x.id === a.id)).map((a) => ({ ...a, via: 'persönlich' }))];
  const [accountId, setAccountId] = useState('');
  const agents = detail.members.filter((m) => m.kind === 'agent');
  const [agentId, setAgentId] = useState(detail.project.agentUserId ?? agents[0]?.userId ?? '');
  const { busy, error, run } = useAsync();
  useEffect(() => { if (!accountId && usable[0]) setAccountId(usable[0].id); }, [usable.length]);
  return (
    <Modal title="Ordner „KI Bearbeiten“ einrichten" onClose={onClose}>
      <p className="small">Im Konto entsteht der Ordner „KI Bearbeiten“ und im Projekt eine Ansicht darauf. Jede Mail, die du dort ablegst (im Mailprogramm oder hier mit „Verschieben“), bearbeitet der gewählte Agent sofort: als stellvertretende Projektleitung legt er Arbeitspaket oder Aufgabe mit Ursprungsmail, Termin und Antwortentwurf direkt an und legt die Mail ab („Archiv“ oder „In Arbeit“); als Mitglied schlägt er dasselbe vor.</p>
      <p className="notice small">Der Inhalt dieser Mails wird für die Mitglieder des Projekts sichtbar (als Kopie am Arbeitspaket).</p>
      {usable.length === 0 ? <div className="empty">Kein passendes Konto: ein eigenes Konto (Einstellungen › Mail-Konten) oder als PL ein Projektkonto (Einstellungen › Mail).</div> :
        <label className="field"><span>Konto</span><select value={accountId} onChange={(e) => setAccountId(e.target.value)}>{usable.map((a) => <option key={a.id} value={a.id}>{a.address} · {a.via}</option>)}</select></label>}
      {agents.length === 0 ? <div className="empty">Kein KI-Agent im Projekt: zuerst einen Agenten als Mitglied aufnehmen (Einstellungen › Mitglieder).</div> :
        <label className="field"><span>Agent</span><select value={agentId} onChange={(e) => setAgentId(e.target.value)}>{agents.map((a) => <option key={a.userId} value={a.userId}>{a.name} · {a.role === 'pl' ? 'stellv. PL: legt direkt an' : 'Mitglied: schlägt vor'}</option>)}</select></label>}
      {error && <div className="error">{error}</div>}
      <div className="row mt"><button className="btn primary" disabled={busy || !accountId || !agentId} onClick={() => void run(async () => { await api.post(`/projects/${detail.project.id}/mail/ai-folder`, { accountId, agentUserId: agentId }); onDone(); })}>Einrichten</button><button className="btn" onClick={onClose}>Abbrechen</button></div>
    </Modal>
  );
}
