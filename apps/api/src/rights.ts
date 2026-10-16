import type { Membership, ProjectRole, User, MailViewRights } from '@projekttool/shared';
import { ROLE_RANK } from '@projekttool/shared';
import type { Db } from './db.js';
import { forbidden, notFound } from './errors.js';

export function mapMembership(row: any): Membership {
  return {
    projectId: row.project_id,
    userId: row.user_id,
    role: row.role,
    isDeputy: row.is_deputy,
    canEditPlan: row.can_edit_plan,
    canApprove: row.can_approve,
    canFinalize: row.can_finalize,
    canUseAi: row.can_use_ai
  };
}

export async function getMembership(db: Db, projectId: string, userId: string): Promise<Membership | null> {
  const row = await db.maybeOne(`select * from project_members where project_id = $1 and user_id = $2`, [projectId, userId]);
  return row ? mapMembership(row) : null;
}

/**
 * Zentrale Rechteprüfung: Projektmitgliedschaft mit Mindestrolle.
 * Org-Admins haben keinen impliziten Zugriff auf Projektinhalte.
 */
export async function requireProject(db: Db, user: User, projectId: string, min: ProjectRole = 'reader'): Promise<Membership> {
  const project = await db.maybeOne(`select id, org_id, status from projects where id = $1`, [projectId]);
  if (!project || project.org_id !== user.orgId) throw notFound('Projekt nicht gefunden');
  const m = await getMembership(db, projectId, user.id);
  if (!m) throw forbidden('Kein Mitglied dieses Projekts');
  if (ROLE_RANK[m.role] < ROLE_RANK[min]) throw forbidden(`Rolle ${min} erforderlich`);
  return m;
}

export function requireFlag(m: Membership, flag: keyof Membership, message: string) {
  if (m.role === 'pl') return;
  if (!m[flag]) throw forbidden(message);
}

export const NO_RIGHTS: MailViewRights = { canRead: false, canDraft: false, canSend: false, canAi: false, canCreateTask: false };
export const ALL_RIGHTS: MailViewRights = { canRead: true, canDraft: true, canSend: true, canAi: true, canCreateTask: true };

/**
 * Rechte an einer Mail-Ansicht: Eigentümer eines persönlichen Kontos hat alles,
 * sonst Vereinigung aus personenbezogener Zeile und Rollenzeile.
 * Senden aus persönlichen Konten nur der Eigentümer.
 */
export async function getViewRights(db: Db, viewId: string, user: User, membership: Membership | null): Promise<MailViewRights> {
  const view = await db.maybeOne(
    `select v.*, a.type as account_type, a.owner_user_id from mail_views v join mail_accounts a on a.id = v.account_id where v.id = $1`,
    [viewId]
  );
  if (!view) return NO_RIGHTS;
  if (view.account_type === 'personal' && view.owner_user_id === user.id) return ALL_RIGHTS;
  if (!membership) return NO_RIGHTS;
  const rows = await db.query(
    `select * from mail_view_rights where view_id = $1 and (user_id = $2 or role = $3)`,
    [viewId, user.id, membership.role]
  );
  const r: MailViewRights = { ...NO_RIGHTS };
  for (const row of rows.rows) {
    r.canRead ||= row.can_read;
    r.canDraft ||= row.can_draft;
    r.canSend ||= row.can_send;
    r.canAi ||= row.can_ai;
    r.canCreateTask ||= row.can_create_task;
  }
  if (view.account_type === 'personal') r.canSend = false;
  return r;
}
