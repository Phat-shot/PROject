import type { Db } from './db.js';

export interface NotifyInput {
  userId: string;
  projectId?: string | null;
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
  /** Gleicher Schlüssel je Benutzer → nur einmal (z. B. fällig-bald pro Aufgabe und Tag). */
  dedupeKey?: string | null;
}

export async function notify(db: Db, n: NotifyInput): Promise<void> {
  await db.query(
    `insert into notifications (user_id, project_id, type, title, body, link, dedupe_key) values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing`,
    [n.userId, n.projectId ?? null, n.type, n.title, n.body ?? null, n.link ?? null, n.dedupeKey ?? null]
  );
}

export async function notifyMany(db: Db, userIds: Iterable<string>, n: Omit<NotifyInput, 'userId'>, exclude?: string | null) {
  for (const u of new Set(userIds)) {
    if (u && u !== exclude) await notify(db, { ...n, userId: u });
  }
}

/** PL und Mitglieder mit einem Einzelrecht. */
export async function usersWithRight(db: Db, projectId: string, flag: 'can_approve' | 'can_finalize' | 'can_edit_plan'): Promise<string[]> {
  const rows = await db.query(`select user_id from project_members where project_id = $1 and (role = 'pl' or ${flag})`, [projectId]);
  return rows.rows.map((r: any) => r.user_id);
}
