import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Task } from '@projekttool/shared';
import { api, fmtDateTime } from '../../lib/api';
import { useData } from '../../lib/useData';
import { Modal, useAsync, useDialog } from '../../components/ui';
import { useProject, useProjectOptional } from '../ProjectPage';
import { contactLabel } from '../../lib/useContacts';
import type { ProjectContact } from '@projekttool/shared';

export type StepType = 'task' | 'timer' | 'wait' | 'mail';
export interface WorkflowStep {
  key: string; type: StepType; title: string; description?: string | null;
  responsible?: 'starter' | 'pl' | 'user' | 'email' | 'previous' | 'agent'; responsibleUserId?: string | null; responsibleEmail?: string | null; dueDays?: number | null; checklist?: string[]; priority?: string; waitForDone?: boolean;
  hours?: number | null; days?: number | null;
  waitKind?: 'approval' | 'mail'; mailSubject?: string | null; mailFrom?: string | null;
  to?: string[]; toStarter?: boolean; toPl?: boolean; toPrevious?: boolean; subject?: string | null; text?: string | null;
}
export interface WorkflowDef { id: string; projectId: string; name: string; description: string | null; steps: WorkflowStep[]; active: boolean; runCount: number; activeRuns: number }
export interface StepState { key: string; status: 'pending' | 'active' | 'done' | 'skipped'; startedAt?: string | null; finishedAt?: string | null; taskId?: string | null; waitUntil?: string | null; approvedBy?: string | null; note?: string | null }
export interface WorkflowRun { id: string; defId: string | null; projectId: string; projectKey: string | null; projectName: string | null; projectKind: 'project' | 'workflow'; name: string; defName: string; steps: WorkflowStep[]; state: StepState[]; vars: Record<string, string>; status: 'active' | 'done' | 'cancelled'; currentStep: number; standalone: boolean; columnId: string | null; subprojectId: string | null; startedByName: string | null; startedAt: string; finishedAt: string | null; lastError: string | null; doneSteps: number; totalSteps: number; waitingOn: string | null }

export const STEP_LABEL: Record<StepType, string> = { task: 'Arbeitspaket', timer: 'Timer', wait: 'Warten auf Ereignis', mail: 'Mail senden' };
const STEP_ICON: Record<StepType, string> = { task: '☐', timer: '⏱', wait: '⏳', mail: '✉' };

export function stepSummary(s: WorkflowStep): string {
  if (s.type === 'task') return `${s.title} · ${s.responsible === 'starter' ? 'Starter' : s.responsible === 'user' ? 'Benutzer' : s.responsible === 'agent' ? 'KI-Agent' : s.responsible === 'email' ? s.responsibleEmail : s.responsible === 'previous' ? 'Zuständige des vorigen AP' : 'geerbt (PL)'}${s.dueDays != null ? ` · fällig +${s.dueDays} Tage` : ''}${s.waitForDone === false ? ' · ohne Warten' : ''}`;
  if (s.type === 'timer') return `${(s.days ?? 0) > 0 ? `${s.days} Tage ` : ''}${(s.hours ?? 0) > 0 ? `${s.hours} Std.` : ''}`.trim() || 'Timer';
  if (s.type === 'wait') return s.waitKind === 'mail' ? `Mail${s.mailSubject ? ` „${s.mailSubject}“` : ''}${s.mailFrom ? ` von ${s.mailFrom}` : ''}` : 'Freigabe durch die PL';
  return `${s.subject ?? ''} → ${[...(s.to ?? []), s.toStarter && 'Starter', s.toPl && 'PL', s.toPrevious && 'Zuständige des vorigen AP'].filter(Boolean).join(', ')}`;
}

export function RunRow({ r, onOpen, showProject }: { r: WorkflowRun; onOpen: () => void; showProject?: boolean }) {
  const pct = r.totalSteps ? Math.round((r.doneSteps / r.totalSteps) * 100) : 0;
  return (
    <div className="card wf-run" onClick={onOpen} style={{ cursor: 'pointer' }}>
      <div className="row between">
        <div><strong>{r.name}</strong> <span className="muted small">{r.defName}{showProject ? (r.projectKind === 'workflow' ? ' · isoliert' : ` · Projekt ${r.projectKey}`) : r.standalone ? ' · isoliert' : ''} · gestartet {fmtDateTime(r.startedAt)}{r.startedByName ? ` von ${r.startedByName}` : ''}</span></div>
        <span className={`badge ${r.status === 'active' ? 'member' : r.status === 'done' ? 'ok' : ''}`}>{r.status === 'active' ? 'aktiv' : r.status === 'done' ? 'abgeschlossen' : 'abgebrochen'}</span>
      </div>
      <div className="progress mt"><div style={{ width: `${pct}%` }} /></div>
      <div className="muted small">Schritt {Math.min(r.currentStep + 1, r.totalSteps)} von {r.totalSteps}{r.waitingOn ? ` · wartet auf: ${r.waitingOn}` : ''}{r.lastError ? ` · Fehler: ${r.lastError}` : ''}</div>
    </div>
  );
}

export function RunDetail({ runId, backTo }: { runId: string; backTo: string }) {
  const { detail, openTask } = useProject();
  const me = detail.project.myMembership;
  const d = useData<{ run: WorkflowRun; tasks: Task[] }>(`/workflow-runs/${runId}`, [runId]);
  const dialog = useDialog();
  const { busy, error, run } = useAsync();
  useEffect(() => { const h = setInterval(() => void d.reload(), 30_000); return () => clearInterval(h); }, [runId]);
  if (d.error) return <div className="content"><div className="error">{d.error}</div></div>;
  if (!d.data) return <div className="content muted">Lade …</div>;
  const r = d.data.run;
  const act = (path: string, body?: unknown) => run(async () => { await api.post(`/workflow-runs/${r.id}/${path}`, body); await d.reload(); });
  const cur = r.status === 'active' ? r.steps[r.currentStep] : null;
  const canApprove = me.role === 'pl' || me.canApprove;
  return (
    <div className="content">
      <div className="row between mb">
        <div><Link to={backTo}>← Workflows</Link><h2 style={{ margin: '4px 0 0' }}>{r.name}</h2><div className="muted small">{r.defName}{r.projectKind === 'workflow' ? ` · isolierter Lauf (Mini-Projekt ${r.projectKey})` : ` · Projekt ${r.projectKey}`} · gestartet {fmtDateTime(r.startedAt)}{r.startedByName ? ` von ${r.startedByName}` : ''}{r.finishedAt ? ` · beendet ${fmtDateTime(r.finishedAt)}` : ''}</div></div>
        <div className="row" style={{ gap: 6 }}>
          <span className={`badge ${r.status === 'active' ? 'member' : r.status === 'done' ? 'ok' : ''}`}>{r.status === 'active' ? 'aktiv' : r.status === 'done' ? 'abgeschlossen' : 'abgebrochen'}</span>
          {r.status === 'active' && <button className="btn sm" disabled={busy} title="Timer, Mails und Arbeitspakete jetzt prüfen" onClick={() => void act('check')}>Jetzt prüfen</button>}
          {r.status === 'active' && cur?.type === 'wait' && cur.waitKind === 'approval' && canApprove && <button className="btn sm primary" disabled={busy} onClick={() => void act('approve')}>Freigeben und weiter</button>}
          {r.status === 'active' && me.role === 'pl' && <button className="btn sm" disabled={busy} onClick={() => void dialog.confirm({ title: 'Schritt überspringen', text: `Schritt ${r.currentStep + 1} „${cur?.title ?? ''}“ überspringen und mit dem nächsten weitermachen?`, confirmLabel: 'Überspringen' }).then((ok) => { if (ok) void act('skip', {}); })}>Schritt überspringen</button>}
          {r.status === 'active' && <button className="btn sm danger" disabled={busy} onClick={() => void dialog.confirm({ title: 'Lauf abbrechen', text: 'Den Lauf abbrechen? Bereits angelegte Arbeitspakete bleiben bestehen.', confirmLabel: 'Abbrechen', danger: true }).then((ok) => { if (ok) void act('cancel'); })}>Lauf abbrechen</button>}
        </div>
      </div>
      {error && <div className="error mb">{error}</div>}
      {r.lastError && <div className="notice danger mb">Fehler im letzten Schritt: {r.lastError}</div>}
      {Object.keys(r.vars).length > 0 && <div className="muted small mb">Variablen: {Object.entries(r.vars).map(([k, v]) => `${k} = ${v}`).join(' · ')}</div>}
      <ol className="wf-timeline">
        {r.steps.map((s, i) => {
          const st = r.state[i] ?? { key: s.key, status: 'pending' };
          const task = st.taskId ? d.data!.tasks.find((t) => t.id === st.taskId) : null;
          return (
            <li key={s.key} className={`wf-step ${st.status} ${i === r.currentStep && r.status === 'active' ? 'current' : ''}`}>
              <div className="wf-dot">{st.status === 'done' ? '✓' : st.status === 'skipped' ? '↷' : st.status === 'active' ? '●' : '○'}</div>
              <div className="wf-body">
                <div><span className="wf-icon">{STEP_ICON[s.type]}</span> <strong>{i + 1}. {s.title}</strong> <span className="muted small">{STEP_LABEL[s.type]}</span></div>
                <div className="small muted">{stepSummary(s)}</div>
                {task && <div className="small"><button className="btn sm link" onClick={() => openTask(task.id)}><span className="badge tkey-badge">{detail.project.key}-{task.number}</span>{task.title}</button> <span className={`badge ${task.done ? 'ok' : ''}`}>{task.done ? 'erledigt' : detail.columns.find((c) => c.id === task.columnId)?.name ?? ''}</span>{task.responsible.name && <span className="muted"> · {task.responsible.name}</span>}</div>}
                {st.status === 'active' && s.type === 'timer' && st.waitUntil && <div className="small">läuft bis {fmtDateTime(st.waitUntil)}</div>}
                {st.status === 'active' && s.type === 'wait' && <div className="small">wartet seit {fmtDateTime(st.startedAt)}{s.waitKind === 'approval' ? ' auf die Freigabe der PL' : ' auf die Mail'}</div>}
                {st.note && <div className="small muted">{st.note}</div>}
                {(st.startedAt || st.finishedAt) && <div className="small muted">{st.startedAt ? `Start ${fmtDateTime(st.startedAt)}` : ''}{st.finishedAt ? ` · Ende ${fmtDateTime(st.finishedAt)}` : ''}</div>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Lauf starten: Name, Variablen; im Board zusätzlich Spalte und Teilprojekt (vom Aufrufer gesetzt). */
export function StartRunDialog({ def, standalone, columnId, subprojectId, onClose, onStarted, start }: { def: WorkflowDef; standalone?: boolean; columnId?: string | null; subprojectId?: string | null; onClose: () => void; onStarted: (r: WorkflowRun) => unknown; start?: (body: Record<string, unknown>) => Promise<WorkflowRun> }) {
  const detail = useProjectOptional()?.detail ?? null;
  const pid = detail?.project.id;
  const varNames = [...new Set(def.steps.flatMap((s) => [s.title, s.description, s.subject, s.text, ...(s.checklist ?? [])].flatMap((t) => [...String(t ?? '').matchAll(/\{\{\s*([\p{L}\p{N}_.-]+)\s*\}\}/gu)].map((m) => m[1]))).filter((v) => !['projekt', 'projektkuerzel', 'workflow', 'lauf', 'starter', 'datum'].includes(v.toLowerCase())))];
  const [name, setName] = useState('');
  const [vars, setVars] = useState<Record<string, string>>({});
  const [sub, setSub] = useState(subprojectId ?? '');
  const [col, setCol] = useState(columnId ?? '');
  const { busy, error, run } = useAsync();
  return (
    <Modal title={`Workflow starten: ${def.name}`} onClose={onClose}>
      <div className="form">
        <label className="field"><span>Name des Laufs</span><input type="text" value={name} autoFocus placeholder={`${def.name} ${new Date().toLocaleDateString('de-DE')}`} onChange={(e) => setName(e.target.value)} /></label>
        {varNames.map((v) => <label key={v} className="field"><span>{v}</span><input type="text" value={vars[v] ?? ''} onChange={(e) => setVars({ ...vars, [v]: e.target.value })} placeholder={`Wert für {{${v}}}`} /></label>)}
        {!standalone && detail && <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <label className="field"><span>Spalte für die Arbeitspakete</span><select value={col} onChange={(e) => setCol(e.target.value)}><option value="">erste Spalte</option>{detail.columns.filter((c) => !c.isDone).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="field"><span>Teilprojekt</span><select value={sub} onChange={(e) => setSub(e.target.value)}><option value="">– keins –</option>{detail.subprojects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        </div>}
        <ol className="wf-steps small">{def.steps.map((s) => <li key={s.key}>{STEP_LABEL[s.type]}: {stepSummary(s)}</li>)}</ol>
        {error && <div className="error">{error}</div>}
        <div className="row"><button className="btn primary" disabled={busy} onClick={() => void run(async () => { const body = { name: name || null, vars, columnId: standalone ? null : col || null, subprojectId: standalone ? null : sub || null }; const r = start ? await start(body) : (await api.post<{ run: WorkflowRun }>(`/projects/${pid}/workflows/${def.id}/start`, body)).run; await onStarted(r); })}>Starten</button><button className="btn" onClick={onClose}>Abbrechen</button></div>
      </div>
    </Modal>
  );
}

const newStep = (type: StepType, n: number): WorkflowStep => ({ key: `s${n}`, type, title: type === 'task' ? '' : type === 'timer' ? 'Warten' : type === 'wait' ? 'Freigabe' : 'Abschlussmail', responsible: 'pl', waitForDone: true, hours: type === 'timer' ? 24 : null, days: null, waitKind: 'approval', to: [], toPl: type === 'mail', checklist: [] });

/** Editor: Schrittliste mit Typ-spezifischen Feldern, verschiebbar. */
export function WorkflowEditor({ existing, members, agents = [], contacts, save: persist, onClose, onSaved }: { existing: WorkflowDef | null; members: { id: string; name: string }[]; agents?: { id: string; name: string }[]; contacts: ProjectContact[]; save: (body: Record<string, unknown>) => Promise<unknown>; onClose: () => void; onSaved: () => unknown }) {
  const [name, setName] = useState(existing?.name ?? '');
  const [desc, setDesc] = useState(existing?.description ?? '');
  const [active, setActive] = useState(existing?.active ?? true);
  const [steps, setSteps] = useState<WorkflowStep[]>(existing?.steps.map((s) => ({ ...s })) ?? [newStep('task', 1)]);
  const { busy, error, run } = useAsync();
  const upd = (i: number, patch: Partial<WorkflowStep>) => setSteps((xs) => xs.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, dir: -1 | 1) => setSteps((xs) => { const n = [...xs]; const j = i + dir; if (j < 0 || j >= n.length) return xs; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const nextKey = () => { let n = steps.length + 1; while (steps.some((s) => s.key === `s${n}`)) n++; return n; };
  const save = () => run(async () => { await persist({ name, description: desc || null, steps, active }); await onSaved(); });
  return (
    <Modal title={existing ? 'Workflow bearbeiten' : 'Neuer Workflow'} onClose={onClose}>
      <div className="form wf-editor">
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <label className="field" style={{ flex: 1 }}><span>Name</span><input type="text" value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="z. B. Kickoff-Ablauf" /></label>
          <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> aktiv (startbar)</label>
        </div>
        <label className="field"><span>Beschreibung (optional)</span><input type="text" value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
        <p className="muted small" style={{ margin: 0 }}>Platzhalter in Titeln und Texten: {'{{projekt}}'}, {'{{workflow}}'}, {'{{lauf}}'}, {'{{starter}}'}, {'{{datum}}'} und eigene wie {'{{kunde}}'} (werden beim Start abgefragt).</p>
        <ol className="wf-edit-list">
          {steps.map((s, i) => (
            <li key={s.key} className="card">
              <div className="row between">
                <div className="row" style={{ gap: 6 }}><strong>{i + 1}.</strong>
                  <select value={s.type} onChange={(e) => upd(i, { ...newStep(e.target.value as StepType, i + 1), key: s.key, title: s.title })}>{(Object.keys(STEP_LABEL) as StepType[]).map((k) => <option key={k} value={k}>{STEP_LABEL[k]}</option>)}</select>
                </div>
                <div className="row" style={{ gap: 4 }}>
                  <button className="btn sm" title="Nach oben" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                  <button className="btn sm" title="Nach unten" disabled={i === steps.length - 1} onClick={() => move(i, 1)}>↓</button>
                  <button className="btn sm link" title="Entfernen" disabled={steps.length === 1} onClick={() => setSteps((xs) => xs.filter((_, j) => j !== i))}>✕</button>
                </div>
              </div>
              <label className="field"><span>{s.type === 'task' ? 'Titel des Arbeitspakets' : 'Bezeichnung'}</span><input type="text" value={s.title} onChange={(e) => upd(i, { title: e.target.value })} placeholder={s.type === 'task' ? 'z. B. Kickoff {{kunde}} vorbereiten' : ''} /></label>
              {s.type === 'task' && <>
                <label className="field"><span>Beschreibung</span><textarea value={s.description ?? ''} onChange={(e) => upd(i, { description: e.target.value })} rows={2} /></label>
                <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                  <label className="field"><span>Zuständig</span>
                    <select value={s.responsible ?? 'pl'} onChange={(e) => upd(i, { responsible: e.target.value as WorkflowStep['responsible'] })}>
                      <option value="pl">geerbt (Teilprojekt/PL)</option><option value="starter">wer den Lauf startet</option><option value="user">bestimmter Benutzer (muss im Zielprojekt Mitglied sein)</option><option value="email">extern (Kontakt/Mail)</option><option value="previous">Zuständige des vorigen Arbeitspakets</option><option value="agent">KI-Agent (muss im Zielprojekt Mitglied sein; ohne Recht „Workflow-Schritte“ oder per Agenten-Policy gesperrt, dann an die PL)</option>
                    </select></label>
                  {s.responsible === 'agent' && <label className="field"><span>KI-Agent</span><select value={s.responsibleUserId ?? ''} onChange={(e) => upd(i, { responsibleUserId: e.target.value || null })}><option value="">– wählen –</option>{agents.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>}
                  {s.responsible === 'user' && <label className="field"><span>Benutzer</span><select value={s.responsibleUserId ?? ''} onChange={(e) => upd(i, { responsibleUserId: e.target.value || null })}><option value="">– wählen –</option>{members.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>}
                  {s.responsible === 'email' && <label className="field"><span>Mail-Adresse</span><input type="email" list={`wf-contacts-${i}`} value={s.responsibleEmail ?? ''} onChange={(e) => upd(i, { responsibleEmail: e.target.value })} /><datalist id={`wf-contacts-${i}`}>{contacts.map((c) => <option key={c.email} value={c.email}>{contactLabel(c)}</option>)}</datalist></label>}
                  <label className="field"><span>Fällig nach Tagen</span><input type="number" min={0} value={s.dueDays ?? ''} onChange={(e) => upd(i, { dueDays: e.target.value === '' ? null : Number(e.target.value) })} style={{ width: 90 }} /></label>
                  <label className="field"><span>Priorität</span><select value={s.priority ?? 'normal'} onChange={(e) => upd(i, { priority: e.target.value })}><option value="low">niedrig</option><option value="normal">normal</option><option value="high">hoch</option><option value="critical">kritisch</option></select></label>
                </div>
                <label className="field"><span>Tasks (eine je Zeile)</span><textarea value={(s.checklist ?? []).join('\n')} rows={2} onChange={(e) => upd(i, { checklist: e.target.value.split('\n') })} /></label>
                <label className="check"><input type="checkbox" checked={s.waitForDone !== false} onChange={(e) => upd(i, { waitForDone: e.target.checked })} /> auf Erledigung warten, bevor der nächste Schritt startet</label>
              </>}
              {s.type === 'timer' && <div className="row" style={{ gap: 12 }}>
                <label className="field"><span>Tage</span><input type="number" min={0} value={s.days ?? ''} onChange={(e) => upd(i, { days: e.target.value === '' ? null : Number(e.target.value) })} style={{ width: 90 }} /></label>
                <label className="field"><span>Stunden</span><input type="number" min={0} value={s.hours ?? ''} onChange={(e) => upd(i, { hours: e.target.value === '' ? null : Number(e.target.value) })} style={{ width: 90 }} /></label>
              </div>}
              {s.type === 'wait' && <>
                <label className="field"><span>Ereignis</span><select value={s.waitKind ?? 'approval'} onChange={(e) => upd(i, { waitKind: e.target.value as 'approval' | 'mail' })}><option value="approval">Freigabe durch die Projektleitung („Freigeben und weiter“)</option><option value="mail">Mail-Eingang am Projektkonto</option></select></label>
                {s.waitKind === 'mail' && <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                  <label className="field"><span>Betreff enthält</span><input type="text" value={s.mailSubject ?? ''} onChange={(e) => upd(i, { mailSubject: e.target.value })} placeholder="z. B. Bestätigung" /></label>
                  <label className="field"><span>Absender enthält (optional)</span><input type="text" value={s.mailFrom ?? ''} onChange={(e) => upd(i, { mailFrom: e.target.value })} placeholder="kunde@firma.de" /></label>
                </div>}
              </>}
              {s.type === 'mail' && <>
                <label className="field"><span>Empfänger (Adressen, mit Komma)</span><input type="text" value={(s.to ?? []).join(', ')} onChange={(e) => upd(i, { to: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></label>
                <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                  <label className="check"><input type="checkbox" checked={Boolean(s.toStarter)} onChange={(e) => upd(i, { toStarter: e.target.checked })} /> an Starter</label>
                  <label className="check"><input type="checkbox" checked={Boolean(s.toPl)} onChange={(e) => upd(i, { toPl: e.target.checked })} /> an PL</label>
                  <label className="check"><input type="checkbox" checked={Boolean(s.toPrevious)} onChange={(e) => upd(i, { toPrevious: e.target.checked })} /> an Zuständige des vorigen Arbeitspakets</label>
                </div>
                <label className="field"><span>Betreff</span><input type="text" value={s.subject ?? ''} onChange={(e) => upd(i, { subject: e.target.value })} /></label>
                <label className="field"><span>Text</span><textarea rows={3} value={s.text ?? ''} onChange={(e) => upd(i, { text: e.target.value })} /></label>
              </>}
            </li>
          ))}
        </ol>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {(Object.keys(STEP_LABEL) as StepType[]).map((k) => <button key={k} className="btn sm" onClick={() => setSteps((xs) => [...xs, newStep(k, nextKey())])}>+ {STEP_LABEL[k]}</button>)}
        </div>
        {error && <div className="error">{error}</div>}
        <div className="row"><button className="btn primary" disabled={busy || !name.trim()} onClick={() => void save()}>Speichern</button><button className="btn" onClick={onClose}>Abbrechen</button></div>
      </div>
    </Modal>
  );
}
