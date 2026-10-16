import { randomBytes } from 'node:crypto';
import type { DocShare } from '@projekttool/shared';
import type { Db } from '../db.js';

export function newShareToken(): string {
  return randomBytes(24).toString('base64url');
}

export function publicBase(): string {
  return (process.env.PUBLIC_URL ?? 'http://localhost:5173').replace(/\/$/, '');
}

export function mapShare(r: any): DocShare {
  return {
    id: r.id, pageId: r.page_id, pageTitle: r.page_title ?? undefined, email: r.email, mode: r.mode, includeChildren: r.include_children,
    expiresAt: r.expires_at, createdAt: r.created_at, revokedAt: r.revoked_at, lastAccessAt: r.last_access_at, accessCount: r.access_count,
    url: `${publicBase()}/s/${r.token}`
  };
}

/** Gültige Freigabe zum Token, sonst null. Zählt den Zugriff. */
export async function resolveShare(db: Db, token: string, countAccess = false) {
  const s = await db.maybeOne(
    `select s.*, p.title as page_title, pr.name as project_name, u.name as created_by_name
     from doc_shares s join doc_pages p on p.id = s.page_id join projects pr on pr.id = s.project_id left join users u on u.id = s.created_by
     where s.token = $1 and s.revoked_at is null and (s.expires_at is null or s.expires_at > now()) and pr.status = 'active'`,
    [token]
  );
  if (!s) return null;
  if (countAccess) await db.query(`update doc_shares set last_access_at = now(), access_count = access_count + 1 where id = $1`, [s.id]);
  return s;
}

/** Seite + (optional) alle Unterseiten, die über die Freigabe erreichbar sind. */
export async function sharedPageIds(db: Db, share: any): Promise<string[]> {
  if (!share.include_children) return [share.page_id];
  const rows = await db.query(
    `with recursive tree as (
       select id from doc_pages where id = $1
       union all
       select p.id from doc_pages p join tree t on p.parent_page_id = t.id
     ) select id from tree`,
    [share.page_id]
  );
  return rows.rows.map((r: any) => r.id);
}
