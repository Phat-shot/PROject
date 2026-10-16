import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Task, TaskComment } from '@projekttool/shared';
import { api, fmtDate, fmtDateTime } from '../../lib/api';
import { Drawer, Markdown, Modal, prioLabel, useAsync } from '../../components/ui';
import { useProject } from '../ProjectPage';
import { LabelPicker } from './BoardView';
import type { Recurrence } from '@projekttool/shared';

interface TaskDetail {
  task: Task;
  comments: TaskComment[];
  mails: { id: string; subject: string; fromAddr: string; date: string; copied: boolean; accountId: string }[];
  attachments: { id: string; filename: string; size: number }[];
}

export function TaskDrawer({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { detail, users, tasks, reloadTasks } = useProject();
  const [d, setD] = useState<TaskDetail | null>(null);
  const [edit, setEdit] = useState(false);
  const [shift, setShift] = useState<{ changes: any[] } | null>(null);
  const [comment, setComment] = useState('');
  const [item, setItem] = useState('');
  const { busy, error, run, setError } = useAsync();
  const load = () => api.get<TaskDetail>(`/tasks/${taskId}`).then(setD).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, [taskId]);
  if (!d) return <Drawer title="Aufgabe" onClose={onClose}>{error ? <div className="error">{error}</div> : 'Lade …'}</Drawer>;
  const t = d.task;
  const me = detail.project.myMembership;
  const canEdit = me.role !== 'reader';
  const canPlan = me.role === 'pl' || me.canEditPlan;
  const column = detail.columns.find((c) => c.id === t.columnId);
  const sp = detail.subprojects.find((s) => s.id === t.subprojectId);
  const patch = async (body: Record<string, unknown>) => {
    await run(async () => { await api.patch(`/tasks/${t.id}`, body); await load(); await reloadTasks(); });
  };
  const members = users.filter((u) => detail.members.some((m) => m.userId === u.id));
  return (
    <Drawer title={<>{t.title}{t.done && <span className="badge ok" style={{ marginLeft: 8 }}>erledigt</span>}</>} onClose={onClose}
      actions={canEdit && <>
        {t.archivedAt ? <button className="btn sm" onClick={() => void run(async () => { await api.post(`/tasks/${t.id}/unarchive`); await load(); await reloadTasks(); })}>Wiederherstellen</button>
          : <button className="btn sm" title="Vom Board nehmen, Historie bleibt" onClick={() => void run(async () => { await api.post(`/tasks/${t.id}/archive`); await reloadTasks(); onClose(); })}>Archivieren</button>}
        <button className="btn sm" onClick={() => setEdit(true)}>Bearbeiten</button>
      </>}>
      {error && <div className="error mb">{error}</div>}
      {t.conflicts.length > 0 && (
        <div className="notice mb">
          <strong>Terminkonflikt</strong>
          <ul style={{ margin: '4px 0 6px', paddingLeft: 18 }}>{t.conflicts.map((c, i) => <li key={i}>{c}</li>)}</ul>
          <span className="small">Nichts wird automatisch verschoben. {canPlan && <>Der PL kann <button className="btn sm link" onClick={() => void run(async () => setShift(await api.post(`/tasks/${t.id}/shift-successors`, {})))}>Nachfolger verschieben</button> (Vorschau).</>}</span>
        </div>
      )}
      <dl className="kv">
        <dt>Status</dt><dd>
          {canEdit ? <select value={t.columnId} onChange={(e) => void patch({ columnId: e.target.value })} style={{ width: 200 }}>{detail.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select> : column?.name}
        </dd>
        <dt>Teilprojekt</dt><dd>{sp?.name ?? <span className="muted">keines</span>}</dd>
        <dt>Zuständig</dt><dd>
          {t.responsible.name ?? t.responsible.email ?? '–'}
          {t.responsible.inherited && <span className="badge inherited" style={{ marginLeft: 6 }}>geerbt vom {t.responsible.inheritedFrom === 'subproject' ? 'Teilprojekt' : 'PL'}</span>}
          {t.responsible.email && !t.responsible.userId && <span className="badge" style={{ marginLeft: 6 }}>extern</span>}
        </dd>
        <dt>Priorität</dt><dd><span className={`badge prio-${t.priority}`}>{prioLabel[t.priority]}</span></dd>
        <dt>Labels</dt><dd>{canEdit ? <LabelPicker value={t.labelIds} onChange={(v) => void patch({ labelIds: v })} /> : t.labelIds.map((id) => { const l = detail.labels.find((x) => x.id === id); return l ? <span key={id} className={`lbl full ${l.color}`} style={{ marginRight: 4 }}>{l.name}</span> : null; })}</dd>
        <dt>Wiederholung</dt><dd>{t.recurrence ? describeRec(t.recurrence) : <span className="muted">keine</span>}{t.archivedAt && <span className="badge" style={{ marginLeft: 6 }}>archiviert</span>}</dd>
        <dt>Zeitraum</dt><dd>{t.startDate ? `${fmtDate(t.startDate)} – ` : ''}{t.dueDate ? fmtDate(t.dueDate) : <span className="muted">keine Deadline</span>}</dd>
        {t.predecessorIds && t.predecessorIds.length > 0 && <><dt>Vorgänger</dt><dd>{t.predecessorIds.map((p) => tasks.find((x) => x.id === p)?.title).filter(Boolean).join(', ')}</dd></>}
        <dt>Antwortadresse</dt><dd className="small muted">{detail.project.mailAddress ? detail.project.mailAddress.replace('@', `+t${t.mailCode}@`) : `Kein Projektkonto · Code ${t.mailCode}`}</dd>
      </dl>
      {t.description && <div className="mt"><Markdown md={t.description} /></div>}

      <h3 className="mt">Checkliste</h3>
      <ul className="checklist">
        {t.checklist?.map((i) => (
          <li key={i.id} className={i.done ? 'done' : ''}>
            <input type="checkbox" checked={i.done} disabled={!canEdit} onChange={(e) => void run(async () => { await api.patch(`/tasks/${t.id}/checklist/${i.id}`, { done: e.target.checked }); await load(); await reloadTasks(); })} />
            <span style={{ flex: 1 }}>{i.title}</span>
            <span className="muted small">{i.responsibleUserId ? users.find((u) => u.id === i.responsibleUserId)?.name : 'geerbt'}</span>
            {canEdit && <button className="btn sm link" onClick={() => void run(async () => { await api.del(`/tasks/${t.id}/checklist/${i.id}`); await load(); })}>✕</button>}
          </li>
        ))}
      </ul>
      {canEdit && <form className="row" onSubmit={(e) => { e.preventDefault(); if (!item.trim()) return; void run(async () => { await api.post(`/tasks/${t.id}/checklist`, { title: item }); setItem(''); await load(); await reloadTasks(); }); }}>
        <input type="text" placeholder="Neuer Task …" value={item} onChange={(e) => setItem(e.target.value)} style={{ flex: 1 }} /><button className="btn sm">Hinzufügen</button></form>}

      <h3 className="mt">Verknüpfte Mails</h3>
      {d.mails.length === 0 ? <p className="muted small">Keine. Antworten an die Antwortadresse oben werden automatisch zugeordnet.</p> : (
        <table className="table"><tbody>
          {d.mails.map((m) => <tr key={m.id}><td><Link to={`/projekte/${detail.project.id}/mail/mail/${m.id}`}>{m.subject}</Link></td><td className="muted small">{m.fromAddr}</td><td className="muted small nowrap">{fmtDateTime(m.date)}</td><td>{m.copied && <span className="badge">Kopie</span>}</td></tr>)}
        </tbody></table>
      )}
      {canEdit && <Link className="btn sm mt" to={`/projekte/${detail.project.id}/mail/neu?task=${t.id}`}>Mail aus Aufgabe schreiben</Link>}

      <h3 className="mt">Anhänge</h3>
      <ul>{d.attachments.map((a) => <li key={a.id}><a href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer">{a.filename}</a> <span className="muted small">({Math.round(a.size / 1024)} KB)</span></li>)}</ul>
      {canEdit && <input type="file" onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; const fd = new FormData(); fd.append('file', f); void run(async () => { await api.post(`/attachments?taskId=${t.id}`, fd); await load(); }); }} />}

      <h3 className="mt">Log und Kommentare</h3>
      {d.comments.map((c) => <div key={c.id} className="comment"><div className="who">{c.userName} · {fmtDateTime(c.createdAt)}{c.source === 'mail' && <span className="badge" style={{ marginLeft: 6 }}>aus Mail</span>}{c.mailId && <Link className="small" style={{ marginLeft: 6 }} to={`/projekte/${detail.project.id}/mail/mail/${c.mailId}`}>öffnen</Link>}</div><div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div></div>)}
      {canEdit && <form className="stack mt" onSubmit={(e) => { e.preventDefault(); if (!comment.trim()) return; void run(async () => { await api.post(`/tasks/${t.id}/comments`, { body: comment }); setComment(''); await load(); }); }}>
        <textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Kommentar …" /><div><button className="btn sm" disabled={busy}>Kommentieren</button></div></form>}

      {edit && <EditTask task={t} members={members} onClose={() => setEdit(false)} onSaved={async () => { setEdit(false); await load(); await reloadTasks(); }} canPlan={canPlan} />}
      {shift && (
        <Modal title="Nachfolger verschieben – Vorschau" onClose={() => setShift(null)}>
          {shift.changes.length === 0 ? <p>Kein Nachfolger muss verschoben werden.</p> : (
            <table className="table"><thead><tr><th>Aufgabe</th><th>Start</th><th>Deadline</th></tr></thead><tbody>
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

function EditTask({ task, members, onClose, onSaved, canPlan }: { task: Task; members: { id: string; name: string }[]; onClose: () => void; onSaved: () => Promise<void>; canPlan: boolean }) {
  const { detail, tasks } = useProject();
  const [f, setF] = useState({
    title: task.title, description: task.description ?? '', subprojectId: task.subprojectId ?? '', priority: task.priority, startDate: task.startDate ?? '', dueDate: task.dueDate ?? '',
    responsibleUserId: task.responsibleUserId ?? '', responsibleEmail: task.responsibleEmail ?? '', predecessorIds: task.predecessorIds ?? [],
    rec: task.recurrence ? { ...task.recurrence } : null as Recurrence | null
  });
  const { busy, error, run } = useAsync();
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const ownTask = task.responsibleUserId === detail.project.myMembership.userId;
  const canDates = canPlan || ownTask;
  return (
    <Modal title="Aufgabe bearbeiten" onClose={onClose}>
      <div className="form cols-2">
        <label className="field full"><span>Titel</span><input type="text" value={f.title} onChange={(e) => set('title', e.target.value)} /></label>
        <label className="field full"><span>Beschreibung (Markdown)</span><textarea value={f.description} onChange={(e) => set('description', e.target.value)} /></label>
        <label className="field"><span>Teilprojekt</span><select value={f.subprojectId} onChange={(e) => set('subprojectId', e.target.value)}><option value="">– keines –</option>{detail.subprojects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="field"><span>Priorität</span><select value={f.priority} onChange={(e) => set('priority', e.target.value)}>{Object.entries(prioLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="field"><span>Start</span><input type="date" value={f.startDate} disabled={!canDates} onChange={(e) => set('startDate', e.target.value)} /></label>
        <label className="field"><span>Deadline</span><input type="date" value={f.dueDate} disabled={!canDates} onChange={(e) => set('dueDate', e.target.value)} /></label>
        <label className="field"><span>Zuständig (intern)</span><select value={f.responsibleUserId} onChange={(e) => { set('responsibleUserId', e.target.value); if (e.target.value) set('responsibleEmail', ''); }}><option value="">– geerbt –</option>{members.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        <label className="field"><span>Extern (Mail-Adresse)</span><input type="email" value={f.responsibleEmail} onChange={(e) => { set('responsibleEmail', e.target.value); if (e.target.value) set('responsibleUserId', ''); }} /></label>
        <label className="field full"><span>Vorgänger (Ende → Anfang)</span>
          <select multiple value={f.predecessorIds} disabled={!canPlan} onChange={(e) => set('predecessorIds', Array.from(e.target.selectedOptions).map((o) => o.value))} style={{ height: 90 }}>
            {tasks.filter((x) => x.id !== task.id).map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
          </select></label>
        <div className="field full"><span>Wiederholung (W6)</span>
          <div className="row">
            <select value={f.rec?.freq ?? ''} onChange={(e) => set('rec', e.target.value ? { freq: e.target.value, interval: 1, mode: f.rec?.mode ?? 'after_done', leadDays: f.rec?.leadDays ?? 0, nth: 1, weekday: 1 } : null)} style={{ width: 'auto' }}>
              <option value="">keine</option><option value="daily">täglich</option><option value="weekly">wöchentlich</option><option value="monthly">monatlich</option><option value="monthly_weekday">n-ter Wochentag im Monat</option>
            </select>
            {f.rec && <>
              <label className="small">alle <input type="number" min={1} value={f.rec.interval ?? 1} onChange={(e) => set('rec', { ...f.rec, interval: Number(e.target.value) })} style={{ width: 56 }} /> {f.rec.freq === 'daily' ? 'Tage' : f.rec.freq === 'weekly' ? 'Wochen' : 'Monate'}</label>
              {f.rec.freq === 'monthly_weekday' && <><select value={f.rec.nth ?? 1} onChange={(e) => set('rec', { ...f.rec, nth: Number(e.target.value) })} style={{ width: 'auto' }}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}.</option>)}</select>
                <select value={f.rec.weekday ?? 1} onChange={(e) => set('rec', { ...f.rec, weekday: Number(e.target.value) })} style={{ width: 'auto' }}>{['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'].map((d, i) => <option key={i} value={i}>{d}</option>)}</select></>}
              <select value={f.rec.mode} onChange={(e) => set('rec', { ...f.rec, mode: e.target.value })} style={{ width: 'auto' }}><option value="after_done">nächste nach Erledigung</option><option value="on_due">nächste vor Fälligkeit</option></select>
              {f.rec.mode === 'on_due' && <label className="small">Vorlauf <input type="number" min={0} value={f.rec.leadDays ?? 0} onChange={(e) => set('rec', { ...f.rec, leadDays: Number(e.target.value) })} style={{ width: 56 }} /> Tage</label>}
            </>}
          </div>
          {f.rec && !f.dueDate && <span className="small" style={{ color: 'var(--warn)' }}>Wiederholung braucht eine Deadline.</span>}
        </div>
        {!canDates && <p className="muted small full">Termine und Abhängigkeiten ändert der PL oder wer das Recht „Projektplan ändern“ hat.</p>}
        {error && <div className="error full">{error}</div>}
        <div className="row full">
          <button className="btn primary" disabled={busy} onClick={() => void run(async () => {
            const body: Record<string, unknown> = { title: f.title, description: f.description || null, subprojectId: f.subprojectId || null, priority: f.priority, responsibleUserId: f.responsibleUserId || null, responsibleEmail: f.responsibleEmail || null };
            if (canDates) { body.startDate = f.startDate || null; body.dueDate = f.dueDate || null; }
            if (canPlan) body.predecessorIds = f.predecessorIds;
            body.recurrence = f.rec;
            await api.patch(`/tasks/${task.id}`, body);
            await onSaved();
          })}>Speichern</button>
          {detail.project.myMembership.role === 'pl' && <button className="btn danger right" onClick={() => { if (confirm('Aufgabe löschen?')) void run(async () => { await api.del(`/tasks/${task.id}`); await onSaved(); }); }}>Löschen</button>}
        </div>
      </div>
    </Modal>
  );
}


function describeRec(r: Recurrence): string {
  const n = r.interval ?? 1;
  const names = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  const base = r.freq === 'daily' ? (n === 1 ? 'täglich' : `alle ${n} Tage`) : r.freq === 'weekly' ? (n === 1 ? 'wöchentlich' : `alle ${n} Wochen`) : r.freq === 'monthly' ? (n === 1 ? 'monatlich' : `alle ${n} Monate`) : `jeden ${r.nth ?? 1}. ${names[r.weekday ?? 1]} im Monat`;
  return `${base}, nächste ${r.mode === 'after_done' ? 'nach Erledigung' : `${r.leadDays ?? 0} Tage vor Fälligkeit`}`;
}
