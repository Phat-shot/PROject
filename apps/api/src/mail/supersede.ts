import type { Db } from '../db.js';
import { audit } from '../audit.js';

/**
 * Überholte Entwürfe verwerfen: neuer Entwurf, geplante oder gesendete Mail des Agenten an dieselben Empfänger zum selben
 * Arbeitspaket (bei PDF-Lieferungen zur selben Seite) ersetzt ältere, die noch auf Freigabe oder Versand warten. Log und Audit.
 */
export async function supersedeDrafts(db: Db, q: { taskId: string; projectId: string; orgId: string; authorId: string; to: string[]; keepId: string | null; pageId?: string | null }): Promise<number> {
  const key = (xs: unknown) => (Array.isArray(xs) ? xs : []).map((x) => String(x).trim().toLowerCase()).sort().join(',');
  const want = key(q.to);
  const rows = (await db.query(`select id, subject, to_addrs from mail_drafts where task_id = $1 and user_id = $2 and status in ('pending_approval', 'scheduled') and page_id is not distinct from $3::uuid and ($4::uuid is null or id <> $4)`, [q.taskId, q.authorId, q.pageId ?? null, q.keepId])).rows
    .filter((d: any) => key(typeof d.to_addrs === 'string' ? JSON.parse(d.to_addrs) : d.to_addrs) === want);
  for (const d of rows) {
    await db.query(`update outbound_checks set decided_at = now() where mail_draft_id = $1 and decided_at is null`, [d.id]);
    await db.query(`delete from mail_drafts where id = $1`, [d.id]);
    await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [q.taskId, q.authorId, `Älterer Entwurf an ${q.to.join(', ')} verworfen (überholt): „${d.subject}“`]);
    await audit(db, { orgId: q.orgId, projectId: q.projectId, userId: q.authorId, action: 'mail.draft_superseded', objectType: 'mail_draft', objectId: d.id, details: { subject: d.subject, by: q.keepId } });
  }
  return rows.length;
}
