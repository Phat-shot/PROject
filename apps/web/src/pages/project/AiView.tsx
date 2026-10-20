import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { AgentRun, AiProposal, MailAiRun } from '@projekttool/shared';
import { MailAiRunCard } from './MailAi';
import { api, fmtDateTime } from '../../lib/api';
import { useData } from '../../lib/useData';
import { aiBlocked, useAiStatus } from '../../lib/useAi';
import { PromptModal, useAsync } from '../../components/ui';
import { classLabel } from '../../components/AgentPolicy';
import { useProject } from '../ProjectPage';

/**
 * KI je Projekt: Vorschläge aus Mails (Essenz in Arbeitspaket oder Seite) mit Freigabe durch PL oder Personen mit
 * Freigaberecht; Frage ans Projekt mit Quellen; Statusbericht-Entwurf als Entwurfsseite. Regel vor KI: nichts wird
 * ohne Freigabe geändert, jede Anfrage steht im Audit. Was die KI-Freigaben sperren, zeigt der Knopf mit Begründung.
 */
export function AiView() {
  const { detail, openTask, reloadTasks, ai: caps } = useProject();
  const ai = useAiStatus();
  const pid = detail.project.id;
  const base = `/projekte/${pid}`;
  const isPl = detail.project.myMembership.role === 'pl';
  // Begründungen aus den KI-Freigaben (Leser mit „KI nutzen“ stellen nur Fragen ans Projekt)
  const askNo = aiBlocked(caps, 'assist.ask');
  const reportNo = aiBlocked(caps, 'assist.report');
  const [status, setStatus] = useState<'pending' | 'all'>('pending');
  const props = useData<{ proposals: AiProposal[]; canApprove: boolean }>(`/projects/${pid}/ai/proposals?status=${status}`, [status]);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<{ answer: string; sources: { type: 'task' | 'page' | 'mail'; id: string; title: string }[] } | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [rejecting, setRejecting] = useState<AiProposal | null>(null);
  const runs = useData<{ runs: AgentRun[] }>(`/projects/${pid}/agent-runs`);
  const mailAi = useData<{ runs: MailAiRun[] }>(`/projects/${pid}/mail-ai`);
  const { busy, error, run } = useAsync();
  const nav = useNavigate();
  const projectAiOff = Boolean(ai && (!ai.enabled || !detail.project.aiProfileId));
  const llms = useData<{ available: { id: string; name: string; own: boolean }[] }>(`/projects/${pid}/llms`);
  const profileName = llms.data?.available.find((p) => p.id === detail.project.aiProfileId)?.name;
  const decide = (p: AiProposal, ok: boolean) => run(async () => {
    if (ok) {
      const body = p.kind === 'task_update' ? { logEntry: edits[p.id] } : { section: edits[p.id] };
      await api.post(`/ai/proposals/${p.id}/approve`, body);
      await reloadTasks();
    } else { if (p.kind === 'agent_action') { setRejecting(p); return; } await api.post(`/ai/proposals/${p.id}/reject`, {}); }
    await props.reload();
  });
  const srcLink = (s: { type: string; id: string; title: string }) => s.type === 'task' ? <button key={s.id} className="btn sm link" onClick={() => openTask(s.id)}>{s.title}</button> : s.type === 'page' ? <Link key={s.id} className="btn sm link" to={`${base}/doku/${s.id}`}>{s.title}</Link> : <Link key={s.id} className="btn sm link" to={`${base}/mail/mail/${s.id}`}>{s.title}</Link>;
  return (
    <div className="content">
      {error && <div className="error mb">{error}</div>}
      {caps?.killswitch && <div className="notice danger mb"><strong>KI im Mandanten abgeschaltet (Notaus).</strong> Keine KI-Funktion und keine Agentenläufe, bis der Org-Admin sie unter Verwaltung › KI-Freigaben wieder einschaltet.</div>}
      {projectAiOff && !caps?.killswitch && <div className="notice mb">Projekt-KI ist aus{ai && !ai.enabled ? ': kein KI-Profil im Mandanten (Verwaltung › KI-Profile)' : isPl ? ': unter Einstellungen › Projekt ein KI-Profil zuweisen' : ': die PL weist unter Einstellungen › Projekt ein KI-Profil zu'}. Agenten laufen unabhängig davon mit ihrem eigenen Profil.</div>}
      {profileName && <p className="muted small">Projekt-KI: {profileName}</p>}
      {(mailAi.data?.runs.length ?? 0) > 0 && <div className="card mb">
        <h2 style={{ marginTop: 0 }}>Mail-KI</h2>
        <p className="muted small">Mails aus dem Ordner „KI Bearbeiten“ bearbeitet die Projekt-KI direkt; Agenten, die eine Ansicht betreuen, schlagen vor. Angenommen wird mit einem Klick, ausgeführt mit deinen Rechten.</p>
        {mailAi.data!.runs.slice(0, 30).map((r) => <MailAiRunCard key={r.id} run={r} showMail onChanged={async () => { await mailAi.reload(); await reloadTasks(); }} />)}
      </div>}
      <div className="card mb">
        <div className="row between"><h2 style={{ margin: 0 }}>Vorschläge zur Freigabe</h2><span className="row" style={{ gap: 2 }}><button className={`chip ${status === 'pending' ? 'on' : ''}`} onClick={() => setStatus('pending')}>offen</button><button className={`chip ${status === 'all' ? 'on' : ''}`} onClick={() => setStatus('all')}>alle</button></span></div>
        <p className="muted small">Essenz einer Mail als Log-Eintrag, Status- oder Terminänderung im Arbeitspaket oder als Abschnitt einer Seite. Entsteht im Postfach über „KI: Essenz …“; angewendet wird erst nach Freigabe{props.data?.canApprove ? ' (du darfst freigeben)' : ' durch PL oder Personen mit Freigaberecht'}.</p>
        {props.data?.proposals.length === 0 && <div className="empty">Keine {status === 'pending' ? 'offenen ' : ''}Vorschläge.</div>}
        {rejecting && <PromptModal title="Ablehnen" label="Grund (Pflicht; dieselbe Aktion wird 14 Tage nicht erneut vorgeschlagen)" submitLabel="Ablehnen" onClose={() => setRejecting(null)} onSubmit={(v) => { const p = rejecting; setRejecting(null); if (v.trim()) void run(async () => { await api.post(`/ai/proposals/${p.id}/reject`, { note: v.trim() }); await props.reload(); }); }} />}
        {props.data?.proposals.map((p) => (
          <div key={p.id} className={`ai-proposal ${p.status}`}>
            <div className="row between">
              <div><span className="badge">{p.kind === 'task_update' ? 'Arbeitspaket' : p.kind === 'agent_action' ? 'Agent' : 'Seite'}</span> <strong>{p.kind === 'page_append' ? <Link className="btn sm link" to={`${base}/doku/${p.pageId}`}>{p.pageTitle ?? '–'}</Link> : <button className="btn sm link" onClick={() => p.taskId && openTask(p.taskId)}>{p.taskTitle ?? '–'}</button>}</strong>{p.mailSubject && <span className="muted small"> · aus Mail <Link to={`${base}/mail/mail/${p.mailId}`}>{p.mailSubject}</Link></span>}</div>
              <span className="muted small">{p.createdByName ?? '–'} · {fmtDateTime(p.createdAt)} {p.status !== 'pending' && <span className={`badge ${p.status === 'approved' ? 'ok' : 'warn'}`}>{({ approved: p.kind === 'agent_action' ? 'ausgeführt' : 'angewendet', rejected: 'abgelehnt', stale: 'veraltet', failed: 'fehlgeschlagen', expired: 'abgelaufen', withdrawn: 'zurückgezogen' } as Record<string, string>)[p.status] ?? p.status}</span>}</span>
            </div>
            {p.kind === 'agent_action' ? (
              <div className="mt small"><strong>{p.payload.label}</strong>{p.actionClass && <span className="muted"> · {classLabel(p.actionClass)}</span>}{p.result && p.status !== 'approved' && <div className="muted">{p.result}</div>}<div className="muted">Angehalten nach der Agenten-Policy; Bestätigen führt mit den Rechten des Agenten aus.</div></div>
            ) : p.kind === 'task_update' ? (
              <div className="mt">
                {p.payload.summary && <div><strong>{p.payload.summary}</strong></div>}
                {(p.payload.columnName || p.payload.dueDate) && <div className="small">{p.payload.columnName && <span className="badge">Status → {p.payload.columnName}</span>} {p.payload.dueDate && <span className="badge">Termin → {p.payload.dueDate}</span>}</div>}
                {p.status === 'pending' && props.data?.canApprove ? <textarea className="mt" rows={4} value={edits[p.id] ?? p.payload.logEntry ?? ''} onChange={(e) => setEdits({ ...edits, [p.id]: e.target.value })} /> : <div className="small mt" style={{ whiteSpace: 'pre-wrap' }}>{p.payload.logEntry}</div>}
                {(p.payload.questions?.length ?? 0) > 0 && <div className="small mt"><span className="muted">Offene Fragen:</span><ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>{p.payload.questions!.map((q, i) => <li key={i}>{q}</li>)}</ul></div>}
              </div>
            ) : (
              <div className="mt">{p.status === 'pending' && props.data?.canApprove ? <textarea rows={8} value={edits[p.id] ?? p.payload.section ?? ''} onChange={(e) => setEdits({ ...edits, [p.id]: e.target.value })} /> : <pre className="small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{p.payload.section}</pre>}</div>
            )}
            {p.status === 'pending' && props.data?.canApprove && <div className="row mt"><button className="btn primary sm" disabled={busy} onClick={() => void decide(p, true)}>{p.kind === 'agent_action' ? 'Bestätigen' : 'Anwenden'}</button><button className="btn sm" disabled={busy} onClick={() => void decide(p, false)}>Ablehnen</button></div>}
            {p.note && <div className="muted small mt">Ablehnung: {p.note}</div>}
          </div>
        ))}
      </div>
      <div className="card mb">
        <h2>Frage ans Projekt</h2>
        <p className="muted small">Antwort aus Arbeitspaketen, Seiten und den Mails, die du lesen darfst, mit Quellenangabe. Keine Änderung an Daten.</p>
        {caps && askNo && <p className="notice small">{askNo}</p>}
        <form className="row" onSubmit={(e) => { e.preventDefault(); void run(async () => setAnswer(await api.post(`/projects/${pid}/ai/ask`, { question }))); }}>
          <input type="text" style={{ flex: 1 }} value={question} placeholder="z. B. Was blockiert den Go-Live? Wer liefert das Design?" onChange={(e) => setQuestion(e.target.value)} disabled={Boolean(askNo)} title={askNo} />
          <button className="btn primary" disabled={busy || Boolean(askNo) || question.trim().length < 3} title={askNo}>Fragen</button>
        </form>
        {answer && <div className="mt">
          <div style={{ whiteSpace: 'pre-wrap' }}>{answer.answer}</div>
          {answer.sources.length > 0 && <div className="small mt"><span className="muted">Quellen:</span> {answer.sources.map((s, i) => <span key={s.id}>[Q{i + 1}] {srcLink(s)} </span>)}</div>}
        </div>}
      </div>
      <div className="card mb">
        <div className="row between"><h2 style={{ margin: 0 }}>Agenten-Läufe</h2><button className="btn sm" onClick={() => void runs.reload()}>Aktualisieren</button></div>
        <p className="muted small">KI-Agenten sind Mitglieder oder stellvertretende PL; sie handeln bei Arbeitspaketen und Aufgaben, für die sie zuständig sind (direkt oder geerbt, z. B. über ein Teilprojekt). Jeder Lauf zeigt Anlass, Protokollnotiz und ausgeführte Aktionen; Log-Einträge stehen am Arbeitspaket unter dem Namen des Agenten.</p>
        {runs.data && runs.data.runs.length === 0 && <div className="empty">Noch keine Läufe. Einen Agenten unter Einstellungen › Mitglieder aufnehmen und ihm ein Arbeitspaket zuweisen.</div>}
        {(runs.data?.runs ?? []).slice(0, 40).map((r) => (
          <div key={r.id} className={`ai-proposal ${r.status === 'error' ? 'rejected' : ''}`}>
            <div className="row between"><div><span className="badge">{r.agentName}</span> <button className="btn sm link" onClick={() => r.taskId && openTask(r.taskId)}>{r.taskNumber ? `${detail.project.key}-${r.taskNumber} ` : ''}{r.taskTitle ?? (r.trigger === 'chat' ? 'Chat im Projektkanal' : '–')}</button> <span className="muted small">· Anlass {r.trigger}</span></div><span className="muted small">{fmtDateTime(r.createdAt)} · {r.inputTokens + r.outputTokens} Token {r.status === 'error' && <span className="badge danger">Fehler</span>}{r.status === 'skipped' && <span className="badge warn" title="Kein LLM-Aufruf, zählt nicht gegen das Tagesbudget">übersprungen</span>}</span></div>
            {r.reasoning && <div className="small mt" style={{ whiteSpace: 'pre-wrap' }}>{r.reasoning}</div>}
            {r.error && <div className={`${r.status === 'skipped' ? 'muted' : 'error'} small mt`}>{r.error}</div>}
            {r.proposed && r.status === 'error' && <details className="small mt"><summary className="muted">Rohantwort des Modells</summary><pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{JSON.stringify(r.proposed, null, 1)}</pre></details>}
            {r.actions.length > 0 && <ul className="small mt" style={{ margin: '4px 0 0', paddingLeft: 18 }}>{r.actions.map((a, i) => <li key={i}>{a.type === 'comment' ? `Log: ${a.text}` : a.type === 'set_status' ? `Status → ${a.column}` : a.type === 'check_item' ? 'Task abgehakt' : a.type === 'add_item' ? `Task ergänzt: ${a.text}` : a.type === 'update_item' ? `Task umformuliert: ${a.text}` : a.type === 'doc_create' ? `Doku-Seite angelegt: ${(a as any).title}` : a.type === 'doc_append' ? 'Doku-Seite ergänzt' : a.type === 'doc_update' ? 'Doku-Seite überarbeitet' : a.type === 'doc_status' ? `Doku-Status → ${(a as any).status}` : a.type === 'doc_move' ? `Doku-Seite nach „${(a as any).folder}“ verschoben` : a.type === 'folder_create' ? `Doku-Ordner angelegt: ${(a as any).folder}` : a.type === 'doc_send_pdf' ? `PDF an ${(a.to ?? []).join(', ')}: ${a.subject}` : a.type === 'mail' ? `Mail an ${(a.to ?? []).join(', ')}: ${a.subject}${a.text?.startsWith('[Entwurf') ? ' (Entwurf zur Freigabe)' : ''}` : a.type === 'blocked' ? `Blockiert gemeldet: ${a.reason}` : a.type === 'escalate' ? `An PL: ${a.text}` : a.type === 'wait' ? `Wartet auf ${{ reply: 'Rückmeldung', date: 'Termin', task: 'Erledigung durch andere', info: 'Information' }[(a as any).kind as string] ?? (a as any).kind}: ${a.reason}` : a.type === 'chat_reply' ? `Antwort im Chat: ${a.text}` : a.type === 'chat_note' ? `Log-Eintrag aus dem Chat: ${a.text}` : a.type === 'claim_check' ? `Behauptung ohne Aktion ersetzt (${a.replaced}): ${a.text}` : `nichts zu tun${a.reason ? `: ${a.reason}` : ''}`}</li>)}</ul>}
          </div>
        ))}
      </div>
      <div className="card">
        <h2>Statusbericht-Entwurf</h2>
        <p className="muted small">Aus den Kennzahlen des Regelwerks, dem RAID-Register, der Ampel und den Log-Einträgen der letzten zwei Wochen entsteht ein Entwurf (Management-Summary, Fortschritt, Risiken, Entscheidungsbedarf, nächste Schritte) als Seite im Ordner „Berichte“ mit Status Entwurf. Versand wie gewohnt über das Reporting.</p>
        <span className="row"><button className="btn primary" disabled={busy || Boolean(reportNo)} title={reportNo} onClick={() => void run(async () => { const r = await api.post<{ page: { id: string } }>(`/projects/${pid}/ai/status-report`); nav(`${base}/doku/${r.page.id}`); })}>Entwurf erzeugen</button>{caps && reportNo && <span className="muted small">{reportNo}</span>}</span>
      </div>
    </div>
  );
}
