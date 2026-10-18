import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Task, TaskComment } from '@projekttool/shared';
import { api, fmtDate, fmtDateTime } from '../../lib/api';
import { Drawer, Markdown, Modal, PromptModal, prioLabel, useAsync, useDialog } from '../../components/ui';
import { QuickMail } from '../../components/QuickMail';
import { useProject } from '../ProjectPage';
import { useAuth } from '../../lib/auth';
import { useData } from '../../lib/useData';
import { LabelPicker } from './BoardView';
import type { Recurrence, TimeEntry } from '@projekttool/shared';
import { MentionInput, MentionText } from '../../components/MentionInput';
import { fmtH } from './TimeView';
import { CopyMoveDialog } from './CopyMove';
import { contactLabel, useContacts } from '../../lib/useContacts';
import { today } from '../../lib/api';

interface TaskMail { id: string; subject: string; fromAddr: string; fromName: string | null; to: string[]; date: string; snippet: string; outgoing: boolean; copied: boolean; checklistItemId: string | null; accountId: string }

interface TaskDetail {
  task: Task;
  subtasks?: Task[];
  comments: TaskComment[];
  mails: TaskMail[];
  attachments: { id: string; filename: string; size: number }[];
  meetings?: { id: string; title: string; startsAt: string; pageId: string | null }[];
}

/** Arbeitspaket oder Aufgabe: alle Felder direkt editierbar, Speichern bei Änderung bzw. beim Verlassen eines Textfelds. */
export function TaskDrawer({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { detail, users, tasks, reloadTasks, openTask } = useProject();
  const { timeTracking } = useAuth();
  const [d, setD] = useState<TaskDetail | null>(null);
  const [shift, setShift] = useState<{ changes: any[] } | null>(null);
  const [comment, setComment] = useState('');
  const [item, setItem] = useState('');
  const [saved, setSaved] = useState(false);
  const [more, setMore] = useState(false);
  const [ask, setAsk] = useState<null | { kind: 'taskEmail'; itemId: string; value: string } | { kind: 'blocked' } | { kind: 'escalate' }>(null);
  const [mail, setMail] = useState<null | { to: string; subject: string; body: string; itemId?: string }>(null);
  const [agentMsg, setAgentMsg] = useState<string | null>(null);
  const { busy, error, run, setError } = useAsync();
  const dialog = useDialog();
  const [copyMove, setCopyMove] = useState<'copy' | 'move' | null>(null);
  const { contacts } = useContacts(detail.project.id);
  const load = () => api.get<TaskDetail>(`/tasks/${taskId}`).then(setD).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, [taskId]);
  if (!d) return <Drawer title="Arbeitspaket" onClose={onClose}>{error ? <div className="error">{error}</div> : 'Lade …'}</Drawer>;
  const t = d.task;
  const kind = t.parentId ? 'Aufgabe' : 'Arbeitspaket';
  const me = detail.project.myMembership;
  const canEdit = me.role !== 'reader' && !t.archivedAt && !t.deletedAt;
  const canPlan = me.role === 'pl' || me.canEditPlan;
  const canDates = canPlan || t.responsibleUserId === me.userId;
  const patch = async (body: Record<string, unknown>) => {
    await run(async () => { await api.patch(`/tasks/${t.id}`, body); await load(); await reloadTasks(); setSaved(true); setTimeout(() => setSaved(false), 1500); });
  };
  const isPlHere = detail.project.myMembership.role === 'pl';
  const members = users.filter((u) => detail.members.some((m) => m.userId === u.id) && (u.kind !== 'agent' || isPlHere));
  const respAgent = users.find((u) => u.id === t.responsibleUserId && u.kind === 'agent');
  const inheritedName = t.responsible.inherited ? t.responsible.name ?? t.responsible.email ?? 'PL' : null;
  const inheritedFrom = t.responsible.inheritedFrom === 'task' ? 'Arbeitspaket' : t.responsible.inheritedFrom === 'subproject' ? 'Teilprojekt' : 'PL';
  const sp = detail.subprojects.find((s) => s.id === t.subprojectId);
  return (
    <Drawer title={<><span className="badge tkey-badge" title="Kennung, auch in der Suche">{detail.project.key}-{t.number}</span><TitleEdit value={t.title} canEdit={canEdit} done={t.done} onSave={(title) => patch({ title })} /></>} onClose={onClose}
      actions={<>
        {saved && <span className="muted small">gespeichert</span>}
        {me.role !== 'reader' && !t.deletedAt && <button className="btn sm" title="Kopie anlegen, hier oder in einem anderen Projekt" onClick={() => setCopyMove('copy')}>Kopieren</button>}
        {canPlan && !t.deletedAt && <button className="btn sm" title="In ein anderes Projekt verschieben" onClick={() => setCopyMove('move')}>Verschieben</button>}
        {me.role !== 'reader' && (t.archivedAt
          ? <button className="btn sm" onClick={() => void run(async () => { await api.post(`/tasks/${t.id}/unarchive`); await load(); await reloadTasks(); })}>Wiederherstellen</button>
          : <button className="btn sm" title="Vom Board nehmen, Historie bleibt" onClick={() => void run(async () => { await api.post(`/tasks/${t.id}/archive`); await reloadTasks(); onClose(); })}>Archivieren</button>)}
        {me.role === 'pl' && !t.deletedAt && <button className="btn sm danger" onClick={() => void dialog.confirm({ title: 'In den Papierkorb', text: `„${t.title}“ in den Papierkorb legen? Dort bleibt es 30 Tage und lässt sich in den Projekteinstellungen wiederherstellen.`, confirmLabel: 'In den Papierkorb', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/tasks/${t.id}`); await reloadTasks(); onClose(); }); })}>Löschen</button>}
      </>}>
      {error && <div className="error mb">{error}</div>}
      {t.parent && <p className="small mb" style={{ marginTop: 0 }}><span className="muted">Aufgabe im Arbeitspaket</span> <button className="btn sm link" onClick={() => openTask(t.parent!.id)}><span className="tkey">{detail.project.key}-{t.parent.number}</span> {t.parent.title}</button></p>}
      {copyMove && <CopyMoveDialog kind="task" op={copyMove} detail={detail} task={t} onClose={() => setCopyMove(null)} onDone={async (r) => { await reloadTasks(); if (r.projectId !== detail.project.id) onClose(); else if (r.taskId && copyMove === 'copy') openTask(r.taskId); }} />}
      {t.deletedAt && <div className="notice danger mb"><strong>Im Papierkorb</strong> seit {fmtDateTime(t.deletedAt)}. {me.role !== 'reader' && <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => void run(async () => { await api.post(`/tasks/${t.id}/restore`); await load(); await reloadTasks(); })}>Wiederherstellen</button>}</div>}
      {(t.blocked || t.escalationLevel > 0) && (
        <div className={`notice mb ${t.escalationLevel >= 2 || t.blocked ? 'danger' : ''}`}>
          <strong>{t.blocked ? `Blockiert${t.blockedReason ? `: ${t.blockedReason}` : ''}` : 'Eskaliert'}</strong>
          {t.escalationLevel > 0 && <div className="small">Eskalation {ESC_LABEL[t.escalationLevel]} seit {fmtDateTime(t.escalatedAt)}.</div>}
          <div className="row mt small">
            {canEdit && t.blocked && <button className="btn sm" onClick={() => void patch({ blocked: false })}>Blockade aufheben</button>}
            {(me.role === 'pl' || t.responsible.userId === me.userId) && t.escalationLevel < 3 && <button className="btn sm" onClick={() => setAsk({ kind: 'escalate' })}>Eine Stufe höher eskalieren</button>}
            {me.role === 'pl' && t.escalationLevel > 0 && <button className="btn sm" onClick={() => void run(async () => { await api.post(`/tasks/${t.id}/escalation/reset`); await load(); await reloadTasks(); })}>Eskalation zurücksetzen</button>}
          </div>
        </div>
      )}
      {t.conflicts.length > 0 && (
        <div className="notice mb">
          <strong>Terminkonflikt</strong>
          <ul style={{ margin: '4px 0 6px', paddingLeft: 18 }}>{t.conflicts.map((c, i) => <li key={i}>{c}</li>)}</ul>
          <span className="small">Nichts wird automatisch verschoben. {canPlan && <button className="btn sm link" onClick={() => void run(async () => setShift(await api.post(`/tasks/${t.id}/shift-successors`, {})))}>Nachfolger verschieben (Vorschau)</button>}</span>
        </div>
      )}

      <div className="form cols-2 task-fields">
        <label className="field"><span>Status</span>
          <select value={t.columnId} disabled={!canEdit} onChange={(e) => void patch({ columnId: e.target.value })}>{detail.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="field"><span>Teilprojekt</span>
          <select value={t.subprojectId ?? ''} disabled={!canEdit || Boolean(t.parentId)} title={t.parentId ? 'Folgt dem Arbeitspaket' : undefined} onChange={(e) => void patch({ subprojectId: e.target.value || null })}><option value="">– keines –</option>{detail.subprojects.map((s) => <option key={s.id} value={s.id}>{s.name}{s.restricted ? ' 🔒' : ''}</option>)}{sp === undefined && t.subprojectId && <option value={t.subprojectId}>(eingeschränkt)</option>}</select></label>
        <label className="field"><span>Zuständig</span>
          <select value={t.responsibleUserId ?? (t.responsibleEmail ? (contacts.some((c) => c.email === t.responsibleEmail) ? `ext:${t.responsibleEmail}` : 'extern') : '')} disabled={!canEdit} onChange={(e) => { const v = e.target.value; if (v === 'extern') return; if (v.startsWith('ext:')) { void patch({ responsibleEmail: v.slice(4), responsibleUserId: null }); return; } void patch({ responsibleUserId: v || null, responsibleEmail: null }); }}>
            <option value="">{inheritedName ? `${inheritedName} (geerbt vom ${inheritedFrom})` : '– geerbt –'}</option>
            {t.responsibleEmail && !contacts.some((c) => c.email === t.responsibleEmail) && <option value="extern">{t.responsibleEmail} (extern)</option>}
            {members.map((u) => <option key={u.id} value={u.id}>{u.name}{u.kind === 'agent' ? ' (KI-Agent)' : ''}</option>)}
            {contacts.length > 0 && <optgroup label="Extern (Kontakte)">{contacts.map((c) => <option key={c.email} value={`ext:${c.email}`}>{contactLabel(c)}</option>)}</optgroup>}
          </select></label>
        {respAgent && <div className="field full"><span>KI-Agent</span><span className="row small"><span className="badge">{respAgent.name}</span>{isPlHere && <><button className="btn sm" onClick={() => void run(async () => { const r = await api.post<{ status: string; actions: { type: string }[]; error?: string }>(`/tasks/${t.id}/agent-run`); setAgentMsg(`${r.actions.length ? `Aktionen: ${r.actions.map((x) => x.type).join(', ')}` : 'keine Aktion'}${r.error ? ` · Fehler: ${r.error}` : ''}`); await load(); })}>Jetzt laufen lassen</button><button className="btn sm" onClick={() => void run(async () => { await api.post(`/tasks/${t.id}/agent-pause`, { paused: !t.agentPaused }); await load(); })}>{t.agentPaused ? 'Agent fortsetzen' : 'Agent pausieren'}</button></>}<Link className="btn sm link" to={`/projekte/${detail.project.id}/ki`}>Läufe</Link></span>{t.agentWait && <div className="muted small" style={{ marginTop: 4 }}>Wartet seit {fmtDateTime(t.agentWait.since)} auf {{ reply: 'Rückmeldung', date: 'Termin', task: 'Erledigung durch andere', info: 'Information' }[t.agentWait.kind]}: {t.agentWait.reason}{t.agentNextCheckAt && <> · Prüfung {fmtDateTime(t.agentNextCheckAt)}</>}{t.agentWait.remindAt && <> · Nachfassen {fmtDateTime(t.agentWait.remindAt)}{t.agentWait.reminded ? ' ✓' : ''}</>}{t.agentWait.escalateAt && <> · Eskalation {fmtDateTime(t.agentWait.escalateAt)}{t.agentWait.escalated ? ' ✓' : ''}</>}</div>}{t.agentPaused && <div className="muted small">Agent pausiert.</div>}{agentMsg && <div className="small" style={{ marginTop: 4 }}>{agentMsg}</div>}</div>}
        <TextField label="Extern (neue Mail-Adresse, wird Kontakt)" type="email" value={t.responsibleEmail ?? ''} canEdit={canEdit} placeholder="extern@firma.de" list="project-contacts" onSave={(v) => patch({ responsibleEmail: v || null, ...(v ? { responsibleUserId: null } : {}) })} />
        <ContactsDatalist projectId={detail.project.id} />
        <label className="field"><span>Priorität</span>
          <select value={t.priority} disabled={!canEdit} onChange={(e) => void patch({ priority: e.target.value })}>{Object.entries(prioLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <div className="field"><span>Labels</span>{canEdit ? <LabelPicker value={t.labelIds} onChange={(v) => void patch({ labelIds: v })} /> : <span>{t.labelIds.map((id) => { const l = detail.labels.find((x) => x.id === id); return l ? <span key={id} className={`lbl full ${l.color}`} style={{ marginRight: 4 }}>{l.name}</span> : null; })}</span>}</div>
        <label className="field"><span>Start</span><input type="date" value={t.startDate ?? ''} disabled={!canEdit || !canDates} onChange={(e) => void patch({ startDate: e.target.value || null })} /></label>
        <label className="field"><span>Deadline</span><input type="date" value={t.dueDate ?? ''} disabled={!canEdit || !canDates} onChange={(e) => void patch({ dueDate: e.target.value || null })} /></label>
        {timeTracking && (detail.project.timeTrackingEnabled || t.estimateMinutes) ? <>
          <TextField label="Geschätzter Aufwand (Stunden)" type="number" value={t.estimateMinutes ? String(Math.round((t.estimateMinutes / 60) * 100) / 100) : ''} canEdit={canEdit} onSave={(v) => patch({ estimateMinutes: v ? Math.round(Number(v) * 60) : null })} />
          <div className="field"><span>Gebucht</span><span>{fmtH(t.loggedMinutes)}{t.estimateMinutes && t.loggedMinutes > t.estimateMinutes ? <span className="badge warn" style={{ marginLeft: 6 }}>über Schätzung</span> : null}</span></div>
        </> : null}
        <div className="field"><span>Blockiert</span>
          {canEdit && !t.blocked && !t.done ? <span><button className="btn sm" onClick={() => setAsk({ kind: 'blocked' })}>Als blockiert melden</button></span> : t.blocked ? <span className="badge blocked">ja</span> : <span className="muted">nein</span>}</div>
        {detail.project.mailAddress && <div className="field"><span>Antwortadresse</span><span className="small muted" title="Antworten an diese Adresse landen automatisch im Arbeitspaket">{detail.project.mailAddress.replace('@', `+t${t.mailCode}@`)}</span></div>}
        {!canDates && canEdit && <p className="muted small full" style={{ margin: 0 }}>Termine ändert der PL, wer „Projektplan ändern“ darf oder die zuständige Person.</p>}
      </div>

      <TextArea label="Beschreibung" value={t.description ?? ''} canEdit={canEdit} onSave={(v) => patch({ description: v || null })} />

      <button className="btn sm link mt" onClick={() => setMore(!more)}>{more ? '▾' : '▸'} {t.parentId ? 'Vorgänger' : 'Vorgänger, Wiederholung'}</button>
      {more && (
        <div className="form cols-2 mt">
          <PredecessorPicker task={t} all={tasks} projectKey={detail.project.key} canEdit={canEdit && canPlan} onChange={(ids) => patch({ predecessorIds: ids })} />
          {!t.parentId && <RecurrenceField value={t.recurrence ?? null} hasDue={Boolean(t.dueDate)} canEdit={canEdit} onSave={(rec) => patch({ recurrence: rec })} />}
        </div>
      )}

      {!t.parentId && <SubtaskSection parent={t} subtasks={d.subtasks ?? []} canEdit={canEdit} members={members} onChanged={async () => { await load(); await reloadTasks(); }} />}

      <h3 className="mt">Tasks {t.checklistTotal > 0 && <span className="badge">{t.checklistDone}/{t.checklistTotal}</span>}</h3>
      <ul className="checklist">
        {t.checklist?.map((i) => (
          <li key={i.id} className={i.done ? 'done' : ''}>
            <input type="checkbox" checked={i.done} disabled={!canEdit} onChange={(e) => void run(async () => { await api.patch(`/tasks/${t.id}/checklist/${i.id}`, { done: e.target.checked }); await load(); await reloadTasks(); })} />
            <InlineText value={i.title} canEdit={canEdit} onSave={(title) => run(async () => { await api.patch(`/tasks/${t.id}/checklist/${i.id}`, { title }); await load(); })} />
            <select className="inline-select" value={i.responsibleUserId ?? (i.responsibleEmail ? (contacts.some((c) => c.email === i.responsibleEmail) ? `ext:${i.responsibleEmail}` : 'extern') : '')} disabled={!canEdit} title="Zuständig für diesen Task" onChange={(e) => { const v = e.target.value; if (v === 'extern') { setAsk({ kind: 'taskEmail', itemId: i.id, value: i.responsibleEmail ?? '' }); return; } if (v.startsWith('ext:')) { void run(async () => { await api.patch(`/tasks/${t.id}/checklist/${i.id}`, { responsibleUserId: null, responsibleEmail: v.slice(4) }); await load(); }); return; } void run(async () => { await api.patch(`/tasks/${t.id}/checklist/${i.id}`, { responsibleUserId: v || null, responsibleEmail: null }); await load(); }); }}>
              <option value="">{t.responsible.name ?? t.responsible.email ?? '–'} (geerbt)</option>
              {members.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              {contacts.length > 0 && <optgroup label="Extern (Kontakte)">{contacts.map((c) => <option key={c.email} value={`ext:${c.email}`}>{contactLabel(c)}</option>)}</optgroup>}
              <option value="extern">{i.responsibleEmail && !contacts.some((c) => c.email === i.responsibleEmail) ? `${i.responsibleEmail} (extern)` : 'extern (neue Mail-Adresse) …'}</option>
            </select>
            {i.responsibleEmail && canEdit && <button className="btn sm link" title="Stand per Mail nachfragen" onClick={() => setMail({ itemId: i.id, to: i.responsibleEmail!, subject: `${detail.project.key}: Stand zu „${i.title}“`, body: `Guten Tag,\n\nwie ist der Stand zu „${i.title}“ (Arbeitspaket „${t.title}“${t.dueDate ? `, fällig ${t.dueDate.split('-').reverse().join('.')}` : ''})?\n\nBitte antworten Sie einfach auf diese Mail, die Antwort landet automatisch im Arbeitspaket.\n\nMit freundlichen Grüßen\n` })}>Nachfragen</button>}
            {canEdit && <button className="btn sm link" onClick={() => void run(async () => { await api.del(`/tasks/${t.id}/checklist/${i.id}`); await load(); await reloadTasks(); })}>✕</button>}
            <MailThread mails={d.mails.filter((m) => m.checklistItemId === i.id)} projectId={detail.project.id} />
          </li>
        ))}
      </ul>
      {canEdit && <form className="row" onSubmit={(e) => { e.preventDefault(); if (!item.trim()) return; void run(async () => { await api.post(`/tasks/${t.id}/checklist`, { title: item }); setItem(''); await load(); await reloadTasks(); }); }}>
        <input type="text" placeholder="Neuer Task … (Enter)" value={item} onChange={(e) => setItem(e.target.value)} style={{ flex: 1 }} /><button className="btn sm">Hinzufügen</button></form>}

      {(d.meetings?.length ?? 0) > 0 && <p className="small mt"><span className="muted">Aus Besprechung:</span> {d.meetings!.map((m) => <span key={m.id}><Link to={`/projekte/${detail.project.id}/besprechungen`}>{m.title} ({fmtDateTime(m.startsAt)})</Link>{m.pageId && <> · <Link to={`/projekte/${detail.project.id}/doku/${m.pageId}`}>Protokoll</Link></>} </span>)}</p>}
      <h3 className="mt">{kind === 'Aufgabe' ? 'Mails zur Aufgabe' : 'Mails zum Arbeitspaket'}</h3>
      {d.mails.filter((m) => !m.checklistItemId).length === 0 ? <p className="muted small">Keine. Antworten an die Antwortadresse werden automatisch zugeordnet, Mails zu einzelnen Tasks stehen beim Task.</p> : (
        <MailThread mails={d.mails.filter((m) => !m.checklistItemId)} projectId={detail.project.id} />
      )}
      {canEdit && <div className="row mt">
        <Link className="btn sm" to={`/projekte/${detail.project.id}/mail/neu?task=${t.id}`}>Mail aus Arbeitspaket schreiben</Link>
        {(t.responsible.email || t.responsibleEmail) && <button className="btn sm" title="Stand beim Zuständigen nachfragen, Antwort landet im Arbeitspaket" onClick={() => setMail({ to: t.responsibleEmail ?? t.responsible.email ?? '', subject: `${detail.project.key}: Stand zu „${t.title}“`, body: `Guten Tag,\n\nwie ist der Stand zum Arbeitspaket „${t.title}“${t.dueDate ? ` (fällig ${t.dueDate.split('-').reverse().join('.')})` : ''}?\n\nBitte antworten Sie einfach auf diese Mail, die Antwort landet automatisch im Arbeitspaket.\n\nMit freundlichen Grüßen\n` })}>Stand nachfragen</button>}
      </div>}

      <h3 className="mt">Anhänge</h3>
      <ul>{d.attachments.map((a) => <li key={a.id}><a href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer">{a.filename}</a> <span className="muted small">({Math.round(a.size / 1024)} KB)</span>{canEdit && <button className="btn sm link" title="Anhang löschen" onClick={() => void dialog.confirm({ title: 'Anhang löschen', text: `„${a.filename}“ endgültig löschen?`, confirmLabel: 'Löschen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/attachments/${a.id}`); await load(); await reloadTasks(); }); })}>✕</button>}</li>)}</ul>
      {canEdit && <input type="file" onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; const fd = new FormData(); fd.append('file', f); void run(async () => { await api.post(`/attachments?taskId=${t.id}`, fd); await load(); await reloadTasks(); }); }} />}

      {timeTracking && detail.project.timeTrackingEnabled && <TimeSection taskId={t.id} canEdit={canEdit} onChanged={async () => { await load(); await reloadTasks(); }} />}

      <h3 className="mt">Log und Kommentare</h3>
      {d.comments.map((c) => <div key={c.id} className="comment"><div className="who">{c.userName} · {fmtDateTime(c.createdAt)}{c.source === 'mail' && <span className="badge" style={{ marginLeft: 6 }}>aus Mail</span>}{c.source === 'ai' && <span className="badge" style={{ marginLeft: 6 }} title="KI-Vorschlag, freigegeben">KI</span>}{c.mailId && <Link className="small" style={{ marginLeft: 6 }} to={`/projekte/${detail.project.id}/mail/mail/${c.mailId}`}>öffnen</Link>}</div><div style={{ whiteSpace: 'pre-wrap' }}><MentionText text={c.body} members={detail.members} /></div></div>)}
      {canEdit && <div className="stack mt">
        <MentionInput value={comment} onChange={setComment} members={detail.members} placeholder="Kommentar … (@Name erwähnt eine Person, Strg+Enter sendet)" onSubmit={() => { if (comment.trim()) void run(async () => { await api.post(`/tasks/${t.id}/comments`, { body: comment }); setComment(''); await load(); }); }} />
        <div><button className="btn sm" disabled={busy || !comment.trim()} onClick={() => void run(async () => { await api.post(`/tasks/${t.id}/comments`, { body: comment }); setComment(''); await load(); })}>Kommentieren</button></div>
      </div>}

      {ask?.kind === 'taskEmail' && <PromptModal title="Externe Zuständigkeit für diesen Task" label="Mail-Adresse" type="email" value={ask.value} placeholder="name@firma.de" hint="Leer lassen entfernt die externe Zuständigkeit." submitLabel="Speichern" onClose={() => setAsk(null)}
        onSubmit={(v) => void run(async () => { await api.patch(`/tasks/${t.id}/checklist/${ask.itemId}`, { responsibleUserId: null, responsibleEmail: v || null }); await load(); })} />}
      {ask?.kind === 'blocked' && <PromptModal title="Als blockiert melden" label="Warum hängt das Arbeitspaket?" placeholder="z. B. warten auf Freigabe des Kunden" submitLabel="Melden" onClose={() => setAsk(null)} onSubmit={(v) => void patch({ blocked: true, blockedReason: v })} />}
      {ask?.kind === 'escalate' && <PromptModal title="Eine Stufe höher eskalieren" label="Grund (optional)" submitLabel="Eskalieren" onClose={() => setAsk(null)} onSubmit={(note) => void run(async () => { await api.post(`/tasks/${t.id}/escalate`, { level: t.escalationLevel + 1, note }); await load(); await reloadTasks(); })} />}
      {mail && <QuickMail projectId={detail.project.id} taskId={t.id} checklistItemId={mail.itemId ?? null} to={mail.to} subject={mail.subject} body={mail.body} title="Stand nachfragen" onClose={() => setMail(null)} onSent={() => void load()} />}
      {shift && (
        <Modal title="Nachfolger verschieben – Vorschau" onClose={() => setShift(null)}>
          {shift.changes.length === 0 ? <p>Kein Nachfolger muss verschoben werden.</p> : (
            <table className="table"><thead><tr><th>Arbeitspaket</th><th>Start</th><th>Deadline</th></tr></thead><tbody>
              {shift.changes.map((c) => <tr key={c.id}><td>{c.title}</td><td>{c.from ? `${fmtDate(c.from)} → ${fmtDate(c.to)}` : '–'}</td><td>{c.dueFrom ? `${fmtDate(c.dueFrom)} → ${fmtDate(c.dueTo)}` : '–'}</td></tr>)}
            </tbody></table>
          )}
          <div className="row mt">
            {shift.changes.length > 0 && <button className="btn primary" onClick={() => void run(async () => { await api.post(`/tasks/${t.id}/shift-successors`, { apply: true }); setShift(null); await load(); await reloadTasks(); })}>Verschieben und Betroffene informieren</button>}
            <button className="btn" onClick={() => setShift(null)}>Abbrechen</button>
          </div>
        </Modal>
      )}
    </Drawer>
  );
}

/**
 * Aufgaben eines Arbeitspakets: eigene Zuständigkeit, Status, Termin und Log (Klick öffnet die Aufgabe).
 * Häkchen setzt auf die Erledigt-Spalte bzw. zurück auf die erste aktive Spalte.
 */
function SubtaskSection({ parent, subtasks, canEdit, members, onChanged }: { parent: Task; subtasks: Task[]; canEdit: boolean; members: { id: string; name: string; kind?: string }[]; onChanged: () => Promise<void> }) {
  const { detail, openTask } = useProject();
  const [title, setTitle] = useState('');
  const [resp, setResp] = useState('');
  const { busy, error, run } = useAsync();
  const doneCol = detail.columns.find((c) => c.kind === 'done') ?? detail.columns.find((c) => c.isDone);
  const openCol = detail.columns.find((c) => c.kind === 'active') ?? detail.columns.find((c) => !c.isDone);
  const t0 = today();
  const toggle = (x: Task) => run(async () => { const col = x.done ? openCol : doneCol; if (col) await api.patch(`/tasks/${x.id}`, { columnId: col.id }); await onChanged(); });
  const add = () => run(async () => {
    if (!title.trim()) return;
    await api.post(`/projects/${detail.project.id}/tasks`, { title, parentId: parent.id, responsibleUserId: resp || null });
    setTitle(''); setResp(''); await onChanged();
  });
  return (
    <>
      <h3 className="mt">Aufgaben {parent.subtaskTotal > 0 && <span className="badge">{parent.subtaskDone}/{parent.subtaskTotal}</span>}</h3>
      {subtasks.length === 0 && <p className="muted small" style={{ margin: '0 0 6px' }}>Keine. Aufgaben teilen das Arbeitspaket in zuweisbare Schritte mit eigenem Log und Termin; Tasks bleiben die Checkliste.</p>}
      <ul className="subtasks">
        {subtasks.map((x) => {
          const col = detail.columns.find((c) => c.id === x.columnId);
          return (
            <li key={x.id} className={x.done ? 'done' : ''}>
              <input type="checkbox" checked={x.done} disabled={!canEdit || busy} title={x.done ? 'Wieder öffnen' : 'Erledigt'} onChange={() => void toggle(x)} />
              <button className="btn sm link st-title" onClick={() => openTask(x.id)}><span className="tkey">{detail.project.key}-{x.number}</span> {x.title}</button>
              {col && !x.done && <span className="badge">{col.name}</span>}
              {x.blocked && <span className="badge blocked">blockiert</span>}
              {x.dueDate && <span className="small nowrap" style={!x.done && x.dueDate < t0 ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>{fmtDate(x.dueDate)}</span>}
              <span className="muted small ell">{x.responsible.name ?? x.responsible.email ?? '–'}{x.responsible.inherited ? ' (geerbt)' : ''}</span>
              {x.commentCount > 0 && <span className="muted small" title="Log-Einträge">✎ {x.commentCount}</span>}
            </li>
          );
        })}
      </ul>
      {canEdit && <form className="row" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input type="text" placeholder="Neue Aufgabe … (Enter)" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 1 }} />
        <select value={resp} onChange={(e) => setResp(e.target.value)} style={{ width: 'auto' }} title="Zuständig">
          <option value="">zuständig: geerbt</option>
          {members.map((u) => <option key={u.id} value={u.id}>{u.name}{u.kind === 'agent' ? ' (KI-Agent)' : ''}</option>)}
        </select>
        <button className="btn sm" disabled={busy || !title.trim()}>Hinzufügen</button>
      </form>}
      {error && <div className="error mt">{error}</div>}
    </>
  );
}

/** Vorgänger (Ende → Anfang): durchsuchbare Liste mit Häkchen statt Mehrfachauswahl. */
function PredecessorPicker({ task, all, projectKey, canEdit, onChange }: { task: Task; all: Task[]; projectKey: string; canEdit: boolean; onChange: (ids: string[]) => Promise<void> }) {
  const [q, setQ] = useState('');
  const sel = new Set(task.predecessorIds ?? []);
  const needle = q.trim().toLowerCase();
  const list = all.filter((x) => x.id !== task.id && !x.archivedAt && (sel.has(x.id) || !needle || x.title.toLowerCase().includes(needle) || `${projectKey}-${x.number}`.toLowerCase().includes(needle)));
  const toggle = (id: string) => { const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); void onChange([...n]); };
  return (
    <div className="field full"><span>Vorgänger (Ende → Anfang){sel.size > 0 && <span className="muted"> · {sel.size} gewählt</span>}</span>
      <div className="pred-picker">
        <input type="text" placeholder="Titel oder Kennung filtern …" value={q} onChange={(e) => setQ(e.target.value)} disabled={!canEdit} />
        <div className="list">
          {list.length === 0 && <div className="muted small">Keine Treffer.</div>}
          {list.map((x) => <label key={x.id} className={`check small ${sel.has(x.id) ? 'on' : ''}`}><input type="checkbox" checked={sel.has(x.id)} disabled={!canEdit} onChange={() => toggle(x.id)} /> <span className="tkey">{projectKey}-{x.number}</span> {x.title}{x.dueDate && <span className="muted"> · bis {fmtDate(x.dueDate)}</span>}</label>)}
        </div>
      </div>
    </div>
  );
}

/** Mailverlauf zu einem Task oder Arbeitspaket: Nachfrage / Antwort, Zeit, Absender, gekürzter Inhalt. */
function MailThread({ mails, projectId }: { mails: TaskMail[]; projectId: string }) {
  if (mails.length === 0) return null;
  const sorted = [...mails].sort((a, b) => a.date.localeCompare(b.date));
  return (
    <ul className="mail-thread">
      {sorted.map((m) => (
        <li key={m.id} className={m.outgoing ? 'out' : 'in'}>
          <span className={`badge ${m.outgoing ? '' : 'ok'}`}>{m.outgoing ? 'Nachfrage' : 'Antwort'}</span>
          <span className="muted small nowrap">{fmtDateTime(m.date)}</span>
          <span className="small">{m.outgoing ? `an ${m.to.join(', ')}` : `von ${m.fromName ?? m.fromAddr}`}</span>
          <Link className="small" to={`/projekte/${projectId}/mail/m/${m.id}`}>{m.subject}</Link>
          {m.snippet && <span className="muted small ell" title={m.snippet}>{m.snippet.length > 160 ? `${m.snippet.slice(0, 160)} …` : m.snippet}</span>}
          {m.copied && <span className="badge">Kopie</span>}
        </li>
      ))}
    </ul>
  );
}

/** Titel im Kopf: Klick zum Ändern, Enter oder Verlassen speichert, Escape verwirft. */
function TitleEdit({ value, canEdit, done, onSave }: { value: string; canEdit: boolean; done: boolean; onSave: (v: string) => Promise<void> }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => { if (v.trim() && v.trim() !== value) void onSave(v.trim()); else setV(value); };
  return (
    <span className="row" style={{ gap: 8, flex: 1 }}>
      <input className="title-edit" type="text" value={v} readOnly={!canEdit} onChange={(e) => setV(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setV(value); (e.target as HTMLInputElement).blur(); } }} />
      {done && <span className="badge ok">erledigt</span>}
    </span>
  );
}

/** Einzeiliger Text, der sich per Klick bearbeiten lässt (Enter/Verlassen speichert). */
export function InlineText({ value, canEdit, onSave, className }: { value: string; canEdit: boolean; onSave: (v: string) => unknown; className?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => { if (v.trim() && v.trim() !== value) onSave(v.trim()); else setV(value); };
  return <input className={`inline-text ${className ?? ''}`} type="text" value={v} readOnly={!canEdit} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setV(value); (e.target as HTMLInputElement).blur(); } }} />;
}

/** Kontakte des Projekts als Vorschlagsliste für externe Mail-Adressen. */
function ContactsDatalist({ projectId }: { projectId: string }) {
  const d = useData<{ contacts: { email: string; name: string | null; organization: string | null }[] }>(`/projects/${projectId}/contacts`);
  return <datalist id="project-contacts">{d.data?.contacts.map((c) => <option key={c.email} value={c.email}>{[c.name, c.organization].filter(Boolean).join(' · ')}</option>)}</datalist>;
}

function TextField({ label, value, canEdit, onSave, type = 'text', placeholder, list }: { label: string; value: string; canEdit: boolean; onSave: (v: string) => Promise<void>; type?: string; placeholder?: string; list?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className="field"><span>{label}</span>
      <input type={type} value={v} placeholder={placeholder} list={list} readOnly={!canEdit} onChange={(e) => setV(e.target.value)} onBlur={() => { if (v !== value) void onSave(v); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></label>
  );
}

function TextArea({ label, value, canEdit, onSave }: { label: string; value: string; canEdit: boolean; onSave: (v: string) => Promise<void> }) {
  const [v, setV] = useState(value);
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!editing) setV(value); }, [value, editing]);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  if (!editing) {
    return (
      <div className="mt desc-view" onClick={() => canEdit && setEditing(true)} title={canEdit ? 'Klicken zum Bearbeiten' : undefined}>
        <span className="muted small">{label}{canEdit && ' · klicken zum Bearbeiten'}</span>
        {value ? <Markdown md={value} /> : <p className="muted small">Keine Beschreibung.</p>}
      </div>
    );
  }
  return (
    <label className="field mt"><span>{label} (Markdown, Verlassen speichert)</span>
      <textarea ref={ref} value={v} rows={6} onChange={(e) => setV(e.target.value)} onBlur={() => { setEditing(false); if (v !== value) void onSave(v); }} onKeyDown={(e) => { if (e.key === 'Escape') { setV(value); setEditing(false); } }} /></label>
  );
}

function RecurrenceField({ value, hasDue, canEdit, onSave }: { value: Recurrence | null; hasDue: boolean; canEdit: boolean; onSave: (r: Recurrence | null) => Promise<void> }) {
  const [rec, setRec] = useState<Recurrence | null>(value);
  useEffect(() => setRec(value), [value]);
  const dirty = JSON.stringify(rec) !== JSON.stringify(value);
  return (
    <div className="field full"><span>Wiederholung {value && <span className="muted">· {describeRec(value)}</span>}</span>
      <div className="row">
        <select value={rec?.freq ?? ''} disabled={!canEdit} onChange={(e) => setRec(e.target.value ? { freq: e.target.value as Recurrence['freq'], interval: 1, mode: rec?.mode ?? 'after_done', leadDays: rec?.leadDays ?? 0, nth: 1, weekday: 1 } : null)} style={{ width: 'auto' }}>
          <option value="">keine</option><option value="daily">täglich</option><option value="weekly">wöchentlich</option><option value="monthly">monatlich</option><option value="monthly_weekday">n-ter Wochentag im Monat</option>
        </select>
        {rec && <>
          <label className="small">alle <input type="number" min={1} value={rec.interval ?? 1} onChange={(e) => setRec({ ...rec, interval: Number(e.target.value) })} style={{ width: 56 }} /> {rec.freq === 'daily' ? 'Tage' : rec.freq === 'weekly' ? 'Wochen' : 'Monate'}</label>
          {rec.freq === 'monthly_weekday' && <><select value={rec.nth ?? 1} onChange={(e) => setRec({ ...rec, nth: Number(e.target.value) })} style={{ width: 'auto' }}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}.</option>)}</select>
            <select value={rec.weekday ?? 1} onChange={(e) => setRec({ ...rec, weekday: Number(e.target.value) })} style={{ width: 'auto' }}>{['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'].map((d, i) => <option key={i} value={i}>{d}</option>)}</select></>}
          <select value={rec.mode} onChange={(e) => setRec({ ...rec, mode: e.target.value as Recurrence['mode'] })} style={{ width: 'auto' }}><option value="after_done">nächste nach Erledigung</option><option value="on_due">nächste vor Fälligkeit</option></select>
          {rec.mode === 'on_due' && <label className="small">Vorlauf <input type="number" min={0} value={rec.leadDays ?? 0} onChange={(e) => setRec({ ...rec, leadDays: Number(e.target.value) })} style={{ width: 56 }} /> Tage</label>}
        </>}
        {dirty && canEdit && <button className="btn sm primary" onClick={() => void onSave(rec)}>Übernehmen</button>}
      </div>
      {rec && !hasDue && <span className="small" style={{ color: 'var(--warn)' }}>Wiederholung braucht eine Deadline.</span>}
    </div>
  );
}

const ESC_LABEL = ['keine', 'Stufe 1: Teilprojekt-Verantwortung', 'Stufe 2: Projektleitung', 'Stufe 3: Eskalationskontakt'];

function describeRec(r: Recurrence): string {
  const n = r.interval ?? 1;
  const names = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  const base = r.freq === 'daily' ? (n === 1 ? 'täglich' : `alle ${n} Tage`) : r.freq === 'weekly' ? (n === 1 ? 'wöchentlich' : `alle ${n} Wochen`) : r.freq === 'monthly' ? (n === 1 ? 'monatlich' : `alle ${n} Monate`) : `jeden ${r.nth ?? 1}. ${names[r.weekday ?? 1]} im Monat`;
  return `${base}, nächste ${r.mode === 'after_done' ? 'nach Erledigung' : `${r.leadDays ?? 0} Tage vor Fälligkeit`}`;
}

function TimeSection({ taskId, canEdit, onChanged }: { taskId: string; canEdit: boolean; onChanged: () => Promise<void> }) {
  const { detail } = useProject();
  const [data, setData] = useState<{ entries: TimeEntry[]; totalMinutes: number } | null>(null);
  const [f, setF] = useState({ date: today(), hours: '', minutes: '', note: '' });
  const { busy, error, run } = useAsync();
  const load = () => api.get<{ entries: TimeEntry[]; totalMinutes: number }>(`/tasks/${taskId}/time`).then(setData);
  useEffect(() => { void load(); }, [taskId]);
  const minutes = Number(f.hours || 0) * 60 + Number(f.minutes || 0);
  return (
    <>
      <h3 className="mt">Zeiten {data && <span className="badge">{fmtH(data.totalMinutes)}</span>}</h3>
      {data && data.entries.length > 0 && <table className="table"><tbody>{data.entries.map((e) => <tr key={e.id}><td className="nowrap small">{fmtDate(e.date)}</td><td className="small">{e.userName}</td><td className="nowrap small">{fmtH(e.minutes)}</td><td className="muted small">{e.note}</td><td>{(e.userId === detail.project.myMembership.userId || detail.project.myMembership.role === 'pl') && <button className="btn sm link" onClick={() => void run(async () => { await api.del(`/time/${e.id}`); await load(); await onChanged(); })}>✕</button>}</td></tr>)}</tbody></table>}
      {canEdit && <div className="row mt">
        <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} style={{ width: 140 }} />
        <input type="number" min={0} placeholder="Std" value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} style={{ width: 64 }} />
        <input type="number" min={0} max={59} placeholder="Min" value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value })} style={{ width: 64 }} />
        <input type="text" placeholder="Notiz" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} style={{ flex: 1 }} />
        <button className="btn sm primary" disabled={busy || minutes <= 0} onClick={() => void run(async () => { await api.post(`/projects/${detail.project.id}/time`, { taskId, date: f.date, minutes, note: f.note }); setF({ ...f, hours: '', minutes: '', note: '' }); await load(); await onChanged(); })}>Buchen</button>
      </div>}
      {error && <div className="error mt">{error}</div>}
    </>
  );
}
