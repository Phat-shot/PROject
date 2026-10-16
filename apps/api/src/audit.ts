import type { Db } from './db.js';

export interface AuditInput {
  orgId: string;
  projectId?: string | null;
  userId?: string | null;
  action: string;
  objectType: string;
  objectId?: string | null;
  details?: Record<string, unknown>;
}

/** Audit-Log schreibt ausschließlich die API bzw. der Worker. */
export async function audit(db: Db, a: AuditInput): Promise<void> {
  await db.query(
    `insert into audit_log (org_id, project_id, user_id, action, object_type, object_id, details)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [a.orgId, a.projectId ?? null, a.userId ?? null, a.action, a.objectType, a.objectId ?? null, JSON.stringify(a.details ?? {})]
  );
}
