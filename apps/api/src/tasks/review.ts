import type { Db } from '../db.js';
import { badRequest } from '../errors.js';
import { dispatch } from '../notify.js';

/**
 * Benannte prüfende Person: Arbeitspakete in einer Spalte der Art „In Prüfung“ (review) und Doku-Seiten im Status „In Prüfung“
 * haben eine Prüferin bzw. einen Prüfer. Gesetzt beim Wechsel in die Prüfung (Pflicht mit der Projekteinstellung
 * „Prüfer erforderlich“), gemeldet in der Klasse Prüfung/Freigabe, sichtbar in „Offen für dich“; Freigeben oder Zurückweisen.
 */

/** Prüfer: aktives menschliches Mitglied des Projekts (keine Leser, keine KI-Agenten). */
export async function assertReviewer(db: Db, projectId: string, userId: string): Promise<{ id: string; name: string }> {
  const r = await db.maybeOne(`select u.id, u.name from project_members m join users u on u.id = m.user_id where m.project_id = $1 and m.user_id = $2 and u.active and u.kind <> 'agent' and m.role <> 'reader'`, [projectId, userId]);
  if (!r) throw badRequest('Prüfer muss ein aktives Mitglied des Projekts sein (keine Leser, keine KI-Agenten)');
  return r;
}

/** Prüfer erforderlich (Projekteinstellung)? */
export async function reviewRequired(db: Db, projectId: string): Promise<boolean> {
  return Boolean((await db.maybeOne(`select review_required from projects where id = $1`, [projectId]))?.review_required);
}

/** Offene Prüfmeldungen zu einem Bezug schließen (Prüfung erledigt, Prüfer gewechselt, Status verlassen). */
export async function resolveReviewNotes(db: Db, refType: 'task' | 'page', refId: string): Promise<void> {
  await db.query(`update notifications set read_at = coalesce(read_at, now()), resolved_at = now() where ref_type = $1 and ref_id = $2 and type in ('task.review', 'page.review') and resolved_at is null`, [refType, refId]);
}

/**
 * Arbeitspaket kommt in eine Prüfspalte: Prüfer setzen (oder beibehalten), Rückkehrspalte merken, Log, Meldung an den Prüfer.
 * prevCol: Spalte vor dem Wechsel (Zeile), reviewerId: gewählt oder null (dann der bisherige, sonst Fehler bei Pflicht).
 */
export async function enterTaskReview(db: Db, task: any, prevCol: any, reviewerId: string | null | undefined, actor: { id: string; name: string }): Promise<void> {
  const required = await reviewRequired(db, task.project_id);
  const id = reviewerId || (prevCol.kind === 'review' ? task.reviewer_user_id : null) || null;
  if (!id && required) throw badRequest('Prüfer erforderlich: Wer prüft? (Projekteinstellung „Prüfer erforderlich“)');
  const reviewer = id ? await assertReviewer(db, task.project_id, id) : null;
  const changed = (reviewer?.id ?? null) !== (task.reviewer_user_id ?? null) || prevCol.kind !== 'review';
  await db.query(`update tasks set reviewer_user_id = $2, review_return_column_id = case when $3 then review_return_column_id else $4::uuid end where id = $1`,
    [task.id, reviewer?.id ?? null, prevCol.kind === 'review', prevCol.id]);
  if (!changed) return;
  await resolveReviewNotes(db, 'task', task.id);
  await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'system')`, [task.id, actor.id, reviewer ? `Zur Prüfung an ${reviewer.name}` : 'Zur Prüfung (ohne benannte prüfende Person)']);
  if (reviewer) await dispatch(db, { event: 'review', projectId: task.project_id, taskId: task.id, users: [reviewer.id], type: 'task.review', title: `Zur Prüfung: ${task.title}`, body: `von ${actor.name}`, link: `/projekte/${task.project_id}/board?task=${task.id}`, ref: { type: 'task', id: task.id }, actorId: actor.id, logged: true });
}

/** Arbeitspaket verlässt die Prüfspalte (von Hand, Freigabe, Zurückweisen): Prüfzustand endet. */
export async function leaveTaskReview(db: Db, taskId: string): Promise<void> {
  await db.query(`update tasks set reviewer_user_id = null, review_return_column_id = null where id = $1 and (reviewer_user_id is not null or review_return_column_id is not null)`, [taskId]);
  await resolveReviewNotes(db, 'task', taskId);
}
