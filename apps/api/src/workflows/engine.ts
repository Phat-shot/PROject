import type { Db } from '../db.js';
import type { MailService } from '../mail/service.js';
import type { AccountRow } from '../mail/types.js';
import { notifyMany } from '../notify.js';
import { newMailCode, resolveProjectLead } from '../tasks/service.js';
import { audit } from '../audit.js';
import { badRequest } from '../errors.js';
import { projectPolicy, TEXT } from '../projectPolicy.js';
import { orgAccount, projectAccount } from '../mail/accounts.js';

/**
 * Workflow-Engine: ein Lauf arbeitet seine Schritte der Reihe nach ab. Der Startpunkt ist der Start des Laufs,
 * danach triggert jeder Schritt den nächsten: Arbeitspaket erledigt, Timer abgelaufen, Freigabe erteilt,
 * erwartete Mail eingegangen; Mail-Schritte laufen sofort durch.
 */
export type StepType = 'task' | 'timer' | 'wait' | 'mail';
export interface WorkflowStep {
  key: string;
  type: StepType;
  title: string;
  /** task: Beschreibung (Platzhalter {{projekt}}, {{workflow}}, {{lauf}}, {{starter}}, {{datum}}, eigene {{vars}}) */
  description?: string | null;
  /** task: starter (wer den Lauf gestartet hat), pl (geerbt), user, email, previous (Zuständige des vorigen Arbeitspakets) */
  responsible?: 'starter' | 'pl' | 'user' | 'email' | 'previous';
  responsibleUserId?: string | null;
  responsibleEmail?: string | null;
  dueDays?: number | null;
  checklist?: string[];
  priority?: 'low' | 'normal' | 'high' | 'critical';
  /** task: false = nicht auf Erledigung warten, direkt weiter */
  waitForDone?: boolean;
  /** timer */
  hours?: number | null;
  days?: number | null;
  /** wait: approval (PL klickt „Weiter“), mail (Mail am Projektkonto mit Betreff-Stichwort, optional Absender) */
  waitKind?: 'approval' | 'mail';
  mailSubject?: string | null;
  mailFrom?: string | null;
  /** mail: Empfänger (Adressen) plus Schalter für Starter, PL, Zuständige des vorigen Arbeitspakets */
  to?: string[];
  toStarter?: boolean;
  toPl?: boolean;
  toPrevious?: boolean;
  subject?: string | null;
  text?: string | null;
}
export interface StepState { key: string; status: 'pending' | 'active' | 'done' | 'skipped'; startedAt?: string | null; finishedAt?: string | null; taskId?: string | null; waitUntil?: string | null; approvedBy?: string | null; note?: string | null }

const H = 3600_000;
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** Prüft eine Schrittliste aus der Oberfläche; wirft 400 bei Fehlern. */
export function validateSteps(raw: unknown): WorkflowStep[] {
  if (!Array.isArray(raw) || raw.length === 0) throw badRequest('Mindestens ein Schritt');
  if (raw.length > 50) throw badRequest('Höchstens 50 Schritte');
  const keys = new Set<string>();
  return raw.map((s: any, i: number) => {
    const type = String(s?.type ?? '') as StepType;
    if (!['task', 'timer', 'wait', 'mail'].includes(type)) throw badRequest(`Schritt ${i + 1}: unbekannter Typ`);
    const key = String(s.key ?? `s${i + 1}`).trim().slice(0, 40) || `s${i + 1}`;
    if (keys.has(key)) throw badRequest(`Schritt ${i + 1}: Schlüssel „${key}“ doppelt`);
    keys.add(key);
    const title = String(s.title ?? '').trim().slice(0, 200) || (type === 'timer' ? 'Warten' : type === 'mail' ? 'Mail' : '');
    if (!title) throw badRequest(`Schritt ${i + 1}: Titel fehlt`);
    const step: WorkflowStep = { key, type, title };
    if (type === 'task') {
      step.description = s.description ? String(s.description).slice(0, 5000) : null;
      step.responsible = ['starter', 'pl', 'user', 'email', 'previous'].includes(s.responsible) ? s.responsible : 'pl';
      step.responsibleUserId = step.responsible === 'user' ? String(s.responsibleUserId ?? '') || null : null;
      step.responsibleEmail = step.responsible === 'email' ? String(s.responsibleEmail ?? '').trim().toLowerCase() || null : null;
      if (step.responsible === 'user' && !step.responsibleUserId) throw badRequest(`Schritt ${i + 1}: Benutzer wählen`);
      if (step.responsible === 'email' && !step.responsibleEmail) throw badRequest(`Schritt ${i + 1}: Mail-Adresse fehlt`);
      step.dueDays = s.dueDays === null || s.dueDays === undefined || s.dueDays === '' ? null : Math.max(0, Math.round(num(s.dueDays)));
      step.checklist = Array.isArray(s.checklist) ? s.checklist.map((x: unknown) => String(x).trim()).filter(Boolean).slice(0, 30) : [];
      step.priority = ['low', 'normal', 'high', 'critical'].includes(s.priority) ? s.priority : 'normal';
      step.waitForDone = s.waitForDone !== false;
    } else if (type === 'timer') {
      step.hours = Math.max(0, num(s.hours)); step.days = Math.max(0, num(s.days));
      if (step.hours + step.days * 24 <= 0) throw badRequest(`Schritt ${i + 1}: Dauer fehlt`);
    } else if (type === 'wait') {
      step.waitKind = s.waitKind === 'mail' ? 'mail' : 'approval';
      step.mailSubject = s.mailSubject ? String(s.mailSubject).trim().slice(0, 200) : null;
      step.mailFrom = s.mailFrom ? String(s.mailFrom).trim().toLowerCase().slice(0, 200) : null;
      if (step.waitKind === 'mail' && !step.mailSubject && !step.mailFrom) throw badRequest(`Schritt ${i + 1}: Betreff-Stichwort oder Absender angeben`);
    } else {
      step.to = Array.isArray(s.to) ? s.to.map((x: unknown) => String(x).trim().toLowerCase()).filter((x: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)).slice(0, 20) : [];
      step.toStarter = Boolean(s.toStarter); step.toPl = Boolean(s.toPl); step.toPrevious = Boolean(s.toPrevious);
      if (!step.to?.length && !step.toStarter && !step.toPl && !step.toPrevious) throw badRequest(`Schritt ${i + 1}: Empfänger fehlen`);
      step.subject = String(s.subject ?? '').trim().slice(0, 300);
      step.text = String(s.text ?? '').slice(0, 10000);
      if (!step.subject || !step.text) throw badRequest(`Schritt ${i + 1}: Betreff und Text angeben`);
    }
    return step;
  });
}

function fill(text: string | null | undefined, vars: Record<string, string>): string {
  return String(text ?? '').replace(/\{\{\s*([\p{L}\p{N}_.-]+)\s*\}\}/gu, (_, k: string) => vars[k] ?? vars[k.toLowerCase()] ?? '');
}

async function varsFor(db: Db, run: any): Promise<Record<string, string>> {
  const p = await db.one(`select key, name from projects where id = $1`, [run.project_id]);
  const starter = run.started_by ? await db.maybeOne(`select name, email from users where id = $1`, [run.started_by]) : null;
  const own: Record<string, string> = {};
  for (const [k, v] of Object.entries(run.vars ?? {})) own[k] = String(v ?? '');
  return { ...own, projekt: p.name, projektkuerzel: p.key, workflow: run.def_name, lauf: run.name, starter: starter?.name ?? '', datum: new Date().toLocaleDateString('de-DE') };
}

async function responsibleOfTask(db: Db, taskId: string | null | undefined): Promise<{ userId: string | null; email: string | null }> {
  if (!taskId) return { userId: null, email: null };
  const t = await db.maybeOne(`select t.responsible_user_id, t.responsible_email, u.email as user_email from tasks t left join users u on u.id = t.responsible_user_id where t.id = $1`, [taskId]);
  return t ? { userId: t.responsible_user_id, email: t.responsible_email ?? t.user_email ?? null } : { userId: null, email: null };
}

function previousTaskId(steps: WorkflowStep[], state: StepState[], idx: number): string | null {
  for (let i = idx - 1; i >= 0; i--) if (steps[i].type === 'task' && state[i]?.taskId) return state[i].taskId!;
  return null;
}

/** Einen Lauf so weit wie möglich vorantreiben. Gibt den aktualisierten Lauf zurück. */
export async function advanceRun(db: Db, mail: MailService, runId: string, now = new Date()): Promise<any> {
  for (let guard = 0; guard < 60; guard++) {
    const run = await db.maybeOne(`select * from workflow_runs where id = $1`, [runId]);
    if (!run || run.status !== 'active') return run;
    const steps: WorkflowStep[] = run.steps ?? [];
    const state: StepState[] = run.state ?? [];
    const idx: number = run.current_step;
    if (idx >= steps.length) {
      const done = await db.one(`update workflow_runs set status = 'done', finished_at = $2 where id = $1 returning *`, [run.id, now]);
      await audit(db, { orgId: (await db.one(`select org_id from projects where id = $1`, [run.project_id])).org_id, projectId: run.project_id, userId: null, action: 'workflow.done', objectType: 'workflow_run', objectId: run.id, details: { name: run.name } });
      return done;
    }
    const step = steps[idx];
    const st: StepState = state[idx] ?? { key: step.key, status: 'pending' };
    const save = async (patch: Partial<StepState>, next: boolean) => {
      state[idx] = { ...st, ...patch };
      await db.query(`update workflow_runs set state = $2, current_step = $3, last_error = null where id = $1`, [run.id, JSON.stringify(state), next ? idx + 1 : idx]);
    };
    try {
      if (st.status === 'pending') {
        const vars = await varsFor(db, run);
        if (step.type === 'task') {
          const taskId = await createStepTask(db, run, step, steps, state, idx, vars, now);
          if (step.waitForDone === false) { await save({ status: 'done', startedAt: now.toISOString(), finishedAt: now.toISOString(), taskId }, true); continue; }
          await save({ status: 'active', startedAt: now.toISOString(), taskId }, false);
          return run;
        }
        if (step.type === 'timer') {
          const until = new Date(now.getTime() + (num(step.hours) + num(step.days) * 24) * H);
          await save({ status: 'active', startedAt: now.toISOString(), waitUntil: until.toISOString() }, false);
          return run;
        }
        if (step.type === 'wait') {
          await save({ status: 'active', startedAt: now.toISOString() }, false);
          if (step.waitKind === 'approval') {
            const pls = await db.query(`select user_id from project_members where project_id = $1 and role = 'pl'`, [run.project_id]);
            await notifyMany(db, pls.rows.map((r: any) => r.user_id), { projectId: run.project_id, type: 'workflow.approval', title: `Workflow wartet auf Freigabe: ${run.name}`, body: step.title, link: `/workflows/laeufe/${run.id}` });
          }
          return run;
        }
        if (step.type === 'mail') {
          const note = await sendStepMail(db, mail, run, step, steps, state, idx, vars);
          await save({ status: 'done', startedAt: now.toISOString(), finishedAt: now.toISOString(), note }, true);
          continue;
        }
      }
      if (st.status === 'active') {
        let ready = false; let note: string | null = null;
        if (step.type === 'task') {
          const t = st.taskId ? await db.maybeOne(`select t.archived_at, t.deleted_at, c.is_done from tasks t join board_columns c on c.id = t.column_id where t.id = $1`, [st.taskId]) : null;
          ready = !t || Boolean(t.is_done) || Boolean(t.archived_at) || Boolean(t.deleted_at);
        } else if (step.type === 'timer') {
          ready = Boolean(st.waitUntil) && new Date(st.waitUntil!).getTime() <= now.getTime();
        } else if (step.type === 'wait' && step.waitKind === 'approval') {
          ready = Boolean(st.approvedBy);
        } else if (step.type === 'wait') {
          const m = await db.maybeOne(
            `select m.subject, m.from_addr, m.date from mails m join mail_accounts a on a.id = m.account_id
             where a.project_id = $1 and not m.outgoing and m.date >= $2 ${step.mailSubject ? 'and m.subject ilike $3::text' : 'and $3::text is not null'} ${step.mailFrom ? 'and lower(m.from_addr) like $4::text' : 'and $4::text is not null'}
             order by m.date limit 1`,
            [run.project_id, st.startedAt ?? run.started_at, step.mailSubject ? `%${step.mailSubject}%` : '', step.mailFrom ? `%${step.mailFrom}%` : '']
          );
          if (m) { ready = true; note = `Mail von ${m.from_addr}: ${m.subject}`; }
        }
        if (!ready) return run;
        await save({ status: 'done', finishedAt: now.toISOString(), note: note ?? st.note ?? null }, true);
        continue;
      }
      // done/skipped: weiter
      await db.query(`update workflow_runs set current_step = $2 where id = $1`, [run.id, idx + 1]);
    } catch (e: any) {
      await db.query(`update workflow_runs set last_error = $2 where id = $1`, [run.id, String(e?.message ?? e).slice(0, 300)]);
      return await db.maybeOne(`select * from workflow_runs where id = $1`, [run.id]);
    }
  }
  return db.maybeOne(`select * from workflow_runs where id = $1`, [runId]);
}

async function createStepTask(db: Db, run: any, step: WorkflowStep, steps: WorkflowStep[], state: StepState[], idx: number, vars: Record<string, string>, now: Date): Promise<string> {
  const column = run.column_id
    ? await db.maybeOne(`select id from board_columns where id = $1 and project_id = $2`, [run.column_id, run.project_id])
    : null;
  const col = column ?? (await db.one(`select id from board_columns where project_id = $1 and not is_done order by position limit 1`, [run.project_id]));
  let userId: string | null = null; let email: string | null = null;
  if (step.responsible === 'starter') userId = run.started_by;
  else if (step.responsible === 'user') userId = step.responsibleUserId ?? null;
  else if (step.responsible === 'email') email = step.responsibleEmail ?? null;
  else if (step.responsible === 'previous') ({ userId, email } = await responsibleOfTask(db, previousTaskId(steps, state, idx)));
  if (userId && !(await db.maybeOne(`select 1 from project_members where project_id = $1 and user_id = $2`, [run.project_id, userId]))) userId = null;
  const due = step.dueDays !== null && step.dueDays !== undefined ? new Date(now.getTime() + step.dueDays * 24 * H).toISOString().slice(0, 10) : null;
  const pos = await db.one(`select coalesce(max(position), -1) + 1 as p from tasks where column_id = $1`, [col.id]);
  const title = fill(step.title, vars).slice(0, 300) || step.title;
  const r = await db.one(
    `insert into tasks (project_id, subproject_id, column_id, title, description, priority, due_date, responsible_user_id, responsible_email, position, mail_code, created_by, workflow_run_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [run.project_id, run.subproject_id, col.id, title, fill(step.description, vars) || null, step.priority ?? 'normal', due, userId, email, pos.p, newMailCode(), run.started_by, run.id]
  );
  for (const [i, c] of (step.checklist ?? []).entries()) await db.query(`insert into checklist_items (task_id, title, position) values ($1,$2,$3)`, [r.id, fill(c, vars).slice(0, 300), i]);
  if (email) await db.query(`insert into project_contacts (project_id, email) values ($1,$2) on conflict do nothing`, [run.project_id, email]);
  await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'system')`, [r.id, run.started_by ?? (await resolveProjectLead(db, run.project_id)).userId, `Aus Workflow „${run.def_name}“ (Lauf „${run.name}“, Schritt ${idx + 1}: ${step.title})`]).catch(() => undefined);
  if (userId) await notifyMany(db, [userId], { projectId: run.project_id, type: 'task.assigned', title: `Dir zugewiesen: ${title}`, body: `Workflow „${run.name}“`, link: `/projekte/${run.project_id}/board?task=${r.id}` });
  return r.id;
}

async function sendStepMail(db: Db, mail: MailService, run: any, step: WorkflowStep, steps: WorkflowStep[], state: StepState[], idx: number, vars: Record<string, string>): Promise<string> {
  const policy = projectPolicy(await db.one(`select personal from projects where id = $1`, [run.project_id]));
  const account = (await projectAccount(db, run.project_id)) ?? (policy.mail.orgFallback ? await orgAccount(db, (await db.one(`select org_id from projects where id = $1`, [run.project_id])).org_id) : null);
  if (!account) throw new Error(policy.mail.orgFallback ? 'Kein Projekt- oder Mandantenkonto für den Mail-Schritt' : TEXT.noOrgFallback);
  const to = new Set<string>(step.to ?? []);
  if (step.toStarter && run.started_by) { const u = await db.maybeOne(`select email from users where id = $1`, [run.started_by]); if (u) to.add(u.email); }
  if (step.toPl) { const lead = await resolveProjectLead(db, run.project_id); if (lead.email) to.add(lead.email); }
  if (step.toPrevious) { const r = await responsibleOfTask(db, previousTaskId(steps, state, idx)); if (r.email) to.add(r.email); }
  if (!to.size) throw new Error('Mail-Schritt ohne auflösbare Empfänger');
  const subject = fill(step.subject, vars); const text = fill(step.text, vars);
  const prevTask = previousTaskId(steps, state, idx);
  const sender = run.started_by ?? (await resolveProjectLead(db, run.project_id)).userId;
  await mail.sendFromAccount(account, { to: [...to], subject, text, userId: sender!, projectId: run.project_id, taskId: prevTask });
  return `Mail an ${[...to].join(', ')}: ${subject}`;
}

/** Freigabe-Schritt bestätigen (PL). */
export async function approveRun(db: Db, mail: MailService, runId: string, userId: string): Promise<any> {
  const run = await db.maybeOne(`select * from workflow_runs where id = $1`, [runId]);
  if (!run || run.status !== 'active') throw badRequest('Lauf ist nicht aktiv');
  const steps: WorkflowStep[] = run.steps; const state: StepState[] = run.state;
  const step = steps[run.current_step]; const st = state[run.current_step];
  if (!step || step.type !== 'wait' || step.waitKind !== 'approval' || st?.status !== 'active') throw badRequest('Der aktuelle Schritt wartet nicht auf eine Freigabe');
  state[run.current_step] = { ...st, approvedBy: userId };
  await db.query(`update workflow_runs set state = $2 where id = $1`, [run.id, JSON.stringify(state)]);
  return advanceRun(db, mail, run.id);
}

/** Aktuellen Schritt überspringen (PL), z. B. wenn ein Timer nicht mehr nötig ist. */
export async function skipStep(db: Db, mail: MailService, runId: string, note: string): Promise<any> {
  const run = await db.maybeOne(`select * from workflow_runs where id = $1`, [runId]);
  if (!run || run.status !== 'active') throw badRequest('Lauf ist nicht aktiv');
  const state: StepState[] = run.state; const idx = run.current_step;
  if (idx >= (run.steps ?? []).length) return run;
  state[idx] = { ...(state[idx] ?? { key: run.steps[idx].key, status: 'pending' }), status: 'skipped', finishedAt: new Date().toISOString(), note };
  await db.query(`update workflow_runs set state = $2, current_step = $3 where id = $1`, [run.id, JSON.stringify(state), idx + 1]);
  return advanceRun(db, mail, run.id);
}

/** Lauf abbrechen; offene Arbeitspakete des Laufs bleiben bestehen (mit Vermerk). */
export async function cancelRun(db: Db, runId: string, userId: string): Promise<any> {
  const run = await db.maybeOne(`select * from workflow_runs where id = $1`, [runId]);
  if (!run || run.status !== 'active') throw badRequest('Lauf ist nicht aktiv');
  const u = await db.one(`update workflow_runs set status = 'cancelled', finished_at = now() where id = $1 returning *`, [run.id]);
  const open = await db.query(`select t.id from tasks t join board_columns c on c.id = t.column_id where t.workflow_run_id = $1 and not c.is_done and t.archived_at is null and t.deleted_at is null`, [run.id]);
  for (const t of open.rows) await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'system')`, [t.id, userId, `Workflow „${run.name}“ wurde abgebrochen; dieses Arbeitspaket bleibt bestehen.`]);
  return u;
}

/** Nach Erledigung eines Arbeitspakets: zugehörigen Lauf weiterschalten. */
export async function onWorkflowTaskDone(db: Db, mail: MailService, taskId: string): Promise<void> {
  const t = await db.maybeOne(`select workflow_run_id from tasks where id = $1`, [taskId]);
  if (t?.workflow_run_id) await advanceRun(db, mail, t.workflow_run_id);
}

/** Worker: alle aktiven Läufe prüfen (Timer, erwartete Mails, anderweitig erledigte Arbeitspakete). */
export async function runWorkflows(db: Db, mail: MailService, now = new Date()): Promise<number> {
  const runs = await db.query(`select id from workflow_runs where status = 'active' order by started_at`);
  let advanced = 0;
  for (const r of runs.rows) {
    const before = await db.one(`select current_step from workflow_runs where id = $1`, [r.id]);
    const after = await advanceRun(db, mail, r.id, now);
    if (after && (after.current_step !== before.current_step || after.status !== 'active')) advanced++;
  }
  return advanced;
}
