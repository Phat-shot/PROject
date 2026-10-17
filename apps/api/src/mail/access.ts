import type { MailViewRights, User } from '@projekttool/shared';
import type { Db } from '../db.js';
import { getMembership, getViewRights } from '../rights.js';

/** Leserecht an einer Mail über ihre Ansichten (oder über eine Kopie in einem Arbeitspaket); liefert die vereinigten Rechte. */
export async function mailAccess(db: Db, user: User, mailId: string): Promise<{ ok: boolean; viewIds: string[]; rights: MailViewRights }> {
    const views = await db.query(`select view_id, (select project_id from mail_views where id = view_id) as project_id from mail_view_matches where mail_id = $1`, [mailId]);
    const merged: MailViewRights = { canRead: false, canDraft: false, canSend: false, canAi: false, canCreateTask: false };
    const readable: string[] = [];
    for (const v of views.rows) {
      const m = await getMembership(db, v.project_id, user.id);
      const r = await getViewRights(db, v.view_id, user, m);
      if (r.canRead) {
        readable.push(v.view_id);
        merged.canDraft ||= r.canDraft; merged.canSend ||= r.canSend; merged.canAi ||= r.canAi; merged.canCreateTask ||= r.canCreateTask;
      }
    }
    if (readable.length) return { ok: true, viewIds: readable, rights: { ...merged, canRead: true } };
    const copied = await db.query(
      `select t.project_id from mail_task_links l join tasks t on t.id = l.task_id where l.mail_id = $1 and l.copied`,
      [mailId]
    );
    for (const c of copied.rows) {
      if (await getMembership(db, c.project_id, user.id)) return { ok: true, viewIds: [], rights: { ...merged, canRead: true } };
    }
    return { ok: false, viewIds: [], rights: merged };
  }

