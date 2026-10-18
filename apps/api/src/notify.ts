import type { Db } from './db.js';

export interface NotifyInput {
  userId: string;
  projectId?: string | null;
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
  /** Gleicher Schlüssel je Benutzer → nur einmal (z. B. fällig-bald pro Arbeitspaket und Tag). */
  dedupeKey?: string | null;
}

/** Einziger Weg in die Meldungen; KI-Agenten und deaktivierte Benutzer bekommen keine. */
export async function notify(db: Db, n: NotifyInput): Promise<void> {
  await db.query(
    `insert into notifications (user_id, project_id, type, title, body, link, dedupe_key)
     select u.id, $2::uuid, $3::text, $4::text, $5::text, $6::text, $7::text from users u where u.id = $1::uuid and u.active and u.kind <> 'agent'
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
  const rows = await db.query(`select m.user_id from project_members m join users u on u.id = m.user_id where m.project_id = $1 and (m.role = 'pl' or m.${flag}) and u.kind <> 'agent'`, [projectId]);
  return rows.rows.map((r: any) => r.user_id);
}
