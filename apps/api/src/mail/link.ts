import type { Db } from '../db.js';
import { dispatch } from '../notify.js';

const cut = (s: string | null | undefined, n: number) => { const t = (s ?? '').trim(); return t.length > n ? t.slice(0, n) + ' …' : t; };

/**
 * Mail einem Arbeitspaket zuordnen (mail_task_links): eine bestehende Zuordnung behält Kopie, Ursprung und Task und wird um
 * das Neue ergänzt. Ist die Zuordnung neu, geht die Klasse „Mail am AP“ (mail_in) nach Regel N: Standard nur ein Log-Eintrag,
 * Empfänger legt die Regel fest; logged: die Aufrufstelle schreibt selbst ins Log. Liefert, ob die Zuordnung neu ist.
 */
export async function linkMailToTask(db: Db, l: { mailId: string; taskId: string; copied?: boolean; linkedBy?: string | null; origin?: boolean; checklistItemId?: string | null; actorId?: string | null; logged?: boolean }): Promise<boolean> {
  const existed = await db.maybeOne(`select 1 from mail_task_links where mail_id = $1 and task_id = $2`, [l.mailId, l.taskId]);
  await db.query(
    `insert into mail_task_links (mail_id, task_id, copied, linked_by, origin, checklist_item_id) values ($1,$2,$3,$4,$5,$6)
     on conflict (mail_id, task_id) do update set copied = mail_task_links.copied or excluded.copied, origin = mail_task_links.origin or excluded.origin,
       checklist_item_id = coalesce(mail_task_links.checklist_item_id, excluded.checklist_item_id)`,
    [l.mailId, l.taskId, Boolean(l.copied), l.linkedBy ?? null, Boolean(l.origin), l.checklistItemId ?? null]
  );
  if (existed) return false;
  const x = await db.maybeOne(`select m.subject, m.from_addr, t.project_id from mails m join tasks t on t.id = $2 where m.id = $1`, [l.mailId, l.taskId]);
  if (x) {
    await dispatch(db, {
      event: 'mail_in', projectId: x.project_id, taskId: l.taskId, type: 'mail.in', title: `Mail von ${x.from_addr}: ${cut(x.subject, 120) || '(ohne Betreff)'}`,
      link: `/projekte/${x.project_id}/board?task=${l.taskId}`, ref: { type: 'task', id: l.taskId }, actorId: l.actorId ?? null, dedupeKey: `mail_in:${l.mailId}:${l.taskId}`, logged: l.logged
    });
  }
  return true;
}
