import type { Db } from '../db.js';
import { dispatch } from '../notify.js';
import { moveTask } from './service.js';

/**
 * Spalte „Wartet“ (Art waiting): ein Arbeitspaket wartet auf eine Rückmeldung mit Frist, gesetzt von einer Person (Status
 * „Wartet“ mit Grund und Frist) oder vom Agenten (wait, Frage mit Frist). Endet das Warten (Antwort, Agent arbeitet weiter),
 * geht es zurück in die Spalte davor; läuft die Frist ohne Lösung ab, wandert es nach „Zurückgestellt“ und die
 * Verantwortlichen bekommen eine Meldung (Klasse Eskalation). Projekte ohne Wartet-Spalte bleiben unberührt.
 */
const cols = (db: Db, projectId: string) => db.query(`select id, kind, is_done from board_columns where project_id = $1 order by position`, [projectId]).then((r) => r.rows as { id: string; kind: string; is_done: boolean }[]);

export async function enterWaiting(db: Db, taskId: string, w: { reason: string; until: Date | null; by: string | null }): Promise<boolean> {
  const t = await db.maybeOne(`select t.id, t.project_id, t.column_id, c.kind, c.is_done from tasks t join board_columns c on c.id = t.column_id where t.id = $1 and t.archived_at is null and t.deleted_at is null`, [taskId]);
  if (!t || t.is_done) return false;
  const waiting = (await cols(db, t.project_id)).find((c) => c.kind === 'waiting');
  if (!waiting) return false;
  // Zurück geht es in die Spalte vor dem Warten; war es zurückgestellt (abgelaufene Frist), bleibt das alte Ziel
  const back = t.kind === 'waiting' || t.kind === 'parked' ? null : t.column_id;
  await db.query(`update tasks set wait_reason = $2, wait_until = $3, wait_by = $4, wait_expired_at = null, wait_return_column_id = coalesce($5, wait_return_column_id) where id = $1`, [taskId, w.reason.slice(0, 300), w.until, w.by, back]);
  if (t.kind !== 'waiting') await moveTask(db, taskId, waiting.id, null);
  return true;
}

/** Warten beendet: zurück in die Spalte davor (auch aus „Zurückgestellt“ nach abgelaufener Frist), Angaben löschen. */
export async function leaveWaiting(db: Db, taskId: string): Promise<boolean> {
  const t = await db.maybeOne(`select t.id, t.project_id, t.wait_return_column_id, t.wait_expired_at, c.kind from tasks t join board_columns c on c.id = t.column_id where t.id = $1`, [taskId]);
  if (!t) return false;
  const moveBack = t.kind === 'waiting' || (t.kind === 'parked' && t.wait_expired_at);
  if (moveBack) {
    const all = await cols(db, t.project_id);
    const target = all.find((c) => c.id === t.wait_return_column_id && c.kind !== 'waiting') ?? all.find((c) => c.kind === 'active') ?? all.find((c) => !c.is_done && c.kind !== 'waiting');
    if (target) await moveTask(db, taskId, target.id, null);
  }
  await db.query(`update tasks set wait_reason = null, wait_until = null, wait_by = null, wait_return_column_id = null, wait_expired_at = null where id = $1`, [taskId]);
  return Boolean(moveBack);
}

/**
 * Wartezustand des Agenten (agent_wait) auf die Spalte übertragen: wartet er, steht das AP in „Wartet“ (Frist = Eskalation der
 * Frage bzw. des Wartens; Warten auf ein Datum hat keine Frist); wartet er nicht mehr, geht es zurück. Nur, was der Agent
 * selbst gesetzt hat (wait_by = Agent oder leer), eine Person behält ihren Wartezustand. Hinein nur mit enter (ausdrückliches
 * wait im Lauf); eine Frage allein verschiebt nichts.
 */
export async function syncAgentWaiting(db: Db, taskId: string, opts: { enter?: boolean } = {}): Promise<void> {
  const t = await db.maybeOne(`select t.agent_wait, t.wait_by, t.wait_reason, t.wait_until, t.responsible_user_id, c.kind, u.kind as by_kind from tasks t join board_columns c on c.id = t.column_id left join users u on u.id = t.wait_by where t.id = $1`, [taskId]);
  if (!t) return;
  const w = t.agent_wait;
  const agentOwned = !t.wait_by || t.by_kind === 'agent';
  if (w && (opts.enter || t.kind === 'waiting')) {
    const until = w.kind === 'date' ? null : w.escalateAt ? new Date(w.escalateAt) : null;
    const agent = await db.maybeOne(`select id from users where id = $1 and kind = 'agent'`, [t.responsible_user_id]);
    if (t.kind === 'waiting' && !agentOwned) return;
    if (t.kind === 'waiting' && t.wait_reason === w.reason && String(t.wait_until ?? '') === String(until ?? '')) return;
    if (t.kind === 'parked' && !t.wait_reason) return; // von Hand zurückgestellt: nicht wieder hervorholen
    await enterWaiting(db, taskId, { reason: w.reason, until, by: agent?.id ?? t.wait_by ?? null });
  } else if (t.wait_reason && agentOwned && (t.kind === 'waiting' || t.kind === 'parked')) {
    await leaveWaiting(db, taskId);
  }
}

/** Worker: abgelaufene Fristen in „Wartet“ → „Zurückgestellt“, Log und Meldung (Eskalation). */
export async function expireWaits(db: Db, now = new Date()): Promise<number> {
  const rows = (await db.query(`select t.id, t.project_id, t.title, t.wait_reason, t.wait_until, p.key, t.number from tasks t join board_columns c on c.id = t.column_id join projects p on p.id = t.project_id
    where c.kind = 'waiting' and t.wait_until is not null and t.wait_until < $1 and t.archived_at is null and t.deleted_at is null and p.status = 'active'`, [now])).rows;
  for (const t of rows) {
    const parked = (await cols(db, t.project_id)).find((c) => c.kind === 'parked');
    if (!parked) continue;
    await moveTask(db, t.id, parked.id, null);
    await db.query(`update tasks set wait_expired_at = $2, wait_until = null where id = $1`, [t.id, now]);
    const text = `Frist abgelaufen ohne Lösung (wartete auf: ${t.wait_reason ?? '–'}): zurückgestellt`;
    await db.query(`insert into task_comments (task_id, user_id, body, source) select $1, coalesce(wait_by, responsible_user_id, created_by, (select m.user_id from project_members m where m.project_id = tasks.project_id and m.role = 'pl' order by m.is_deputy limit 1)), $2, 'system' from tasks where id = $1`, [t.id, text]);
    // Empfänger: wer gewartet hat, Zuständige(r), Auftraggeber und PL (nur Personen); die Regel „Eskalation“ ergänzt Rollen
    const users = (await db.query(`select distinct u.id from users u where u.kind <> 'agent' and u.active and (u.id in (select x from tasks t, unnest(array[t.wait_by, t.responsible_user_id, t.requested_by]) x where t.id = $1)
      or u.id in (select m.user_id from project_members m where m.project_id = $2 and m.role = 'pl'))`, [t.id, t.project_id])).rows.map((r: any) => r.id as string);
    await dispatch(db, { event: 'escalation', users, projectId: t.project_id, taskId: t.id, type: 'task.wait_expired', title: `Zurückgestellt: ${t.key}-${t.number} ${t.title}`, body: text, link: `/projekte/${t.project_id}/board?task=${t.id}`, ref: { type: 'task', id: t.id }, dedupeKey: `wait_expired:${t.id}:${new Date(t.wait_until).toISOString()}` });
  }
  return rows.length;
}
