import type { ChatTaskItem } from '@projekttool/shared';
import type { Db } from '../db.js';
import { audit } from '../audit.js';
import { canSeeSubproject, getMembership } from '../rights.js';
import { cancelQuestions } from '../questions.js';
import { touchTask } from '../tasks/service.js';
import { queueAgentRun } from './agentEvents.js';

/**
 * Aufgaben übernehmen (Chat): Die Person weist dem Agenten eine Aufgabe aus seiner Statusantwort zu, per Knopf auf der
 * Aufgabenkarte (meta.card = 'tasks', POST /chat/messages/:id/take) oder per Chat-Befehl take. Rechte wie die Zuweisung im
 * Projekt: KI-Agenten weist nur die Projektleitung zu (im persönlichen Projekt der Inhaber); der Agent ist aktives Mitglied des
 * Projekts und noch nicht zuständig, beide sehen das Teilprojekt. Danach Log, Audit und ein Lauf am Arbeitspaket (Anlass assigned).
 */
export type TakeCheck = { ok: true; task: any } | { ok: false; reason: string; task?: any };

export async function takeCheck(db: Db, q: { senderId: string; agent: { id: string; name: string }; taskId: string }): Promise<TakeCheck> {
  const task = await db.maybeOne(`select t.*, c.is_done from tasks t join board_columns c on c.id = t.column_id where t.id = $1 and t.deleted_at is null and t.archived_at is null`, [q.taskId]);
  if (!task) return { ok: false, reason: 'Aufgabe nicht gefunden' };
  if (task.is_done) return { ok: false, reason: 'schon erledigt', task };
  if (task.responsible_user_id === q.agent.id) return { ok: false, reason: `schon bei ${q.agent.name}`, task };
  const agentMember = await db.maybeOne(`select 1 from project_members m join users u on u.id = m.user_id where m.project_id = $1 and m.user_id = $2 and u.active`, [task.project_id, q.agent.id]);
  if (!agentMember) return { ok: false, reason: `${q.agent.name} ist kein Mitglied dieses Projekts`, task };
  const m = await getMembership(db, task.project_id, q.senderId);
  if (!m || m.role !== 'pl') return { ok: false, reason: 'KI-Agenten weist nur die Projektleitung zu', task };
  if (!(await canSeeSubproject(db, q.senderId, task.subproject_id)) || !(await canSeeSubproject(db, q.agent.id, task.subproject_id))) return { ok: false, reason: 'Teilprojekt ist eingeschränkt sichtbar', task };
  return { ok: true, task };
}

/** Zuständigkeit auf den Agenten setzen (nach takeCheck): Log, Audit, Lauf einplanen. */
export async function takeTask(db: Db, q: { sender: { id: string; name: string; orgId: string }; agent: { id: string; name: string }; taskId: string }): Promise<TakeCheck> {
  const c = await takeCheck(db, { senderId: q.sender.id, agent: q.agent, taskId: q.taskId });
  if (!c.ok) return c;
  const prev = c.task.responsible_user_id as string | null;
  await db.query(`update tasks set responsible_user_id = $2, responsible_email = null, updated_at = now() where id = $1`, [q.taskId, q.agent.id]);
  // Zuständigkeit wechselt von einem anderen Agenten weg: dessen offene Fragen am AP erledigen sich
  if (prev && (await db.maybeOne(`select 1 from users where id = $1 and kind = 'agent'`, [prev]))) await cancelQuestions(db, { taskId: q.taskId, askedBy: prev }, 'Zuständigkeit gewechselt', q.sender.id);
  await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'chat')`, [q.taskId, q.sender.id, `Übernommen auf Wunsch von ${q.sender.name} per Chat (zuständig: ${q.agent.name})`]);
  await touchTask(db, q.taskId);
  await audit(db, { orgId: q.sender.orgId, projectId: c.task.project_id, userId: q.sender.id, action: 'task.update', objectType: 'task', objectId: q.taskId, details: { responsibleUserId: q.agent.id, previous: prev, via: 'chat_take' } });
  queueAgentRun(q.taskId, 'assigned', q.agent.id);
  return c;
}

/** Karte meta.items: je Aufgabe, ob der Absender sie dem Agenten zuweisen darf (sonst mit Grund). */
export async function taskItems(db: Db, q: { senderId: string; agent: { id: string; name: string }; tasks: { taskId: string; projectId: string; ref: string; title: string; due: string | null; status: string }[] }): Promise<ChatTaskItem[]> {
  const out: ChatTaskItem[] = [];
  for (const [i, t] of q.tasks.entries()) {
    const c = await takeCheck(db, { senderId: q.senderId, agent: q.agent, taskId: t.taskId });
    out.push({ n: i + 1, ref: t.ref, taskId: t.taskId, projectId: t.projectId, title: t.title, due: t.due, status: t.status, canTake: c.ok, ...(c.ok ? {} : { reason: c.reason }) });
  }
  return out;
}

/** Karte nach dem Übernehmen neu prüfen: übernommene Aufgaben taken, die übrigen mit frischem canTake. */
export async function refreshItems(db: Db, q: { senderId: string; agent: { id: string; name: string }; items: ChatTaskItem[]; taken: string[] }): Promise<ChatTaskItem[]> {
  const out: ChatTaskItem[] = [];
  for (const it of q.items) {
    if (it.taken || q.taken.includes(it.taskId)) { out.push({ ...it, taken: true, canTake: false, reason: null }); continue; }
    const c = await takeCheck(db, { senderId: q.senderId, agent: q.agent, taskId: it.taskId });
    out.push({ ...it, canTake: c.ok, reason: c.ok ? null : c.reason });
  }
  return out;
}

/** Ergebnistext je Aufgabe. */
export const takeLine = (it: { ref: string; title: string }, r: TakeCheck) => (r.ok ? `${it.ref} „${it.title}“` : `${it.ref}: ${r.reason}`);
