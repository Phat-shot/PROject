import type { Db } from '../db.js';
import type { AiFeedbackEntry, AiFeedbackKind } from '@projekttool/shared';
import { PROJECT_LABEL_SQL } from '../projectPolicy.js';

/**
 * KI-Feedback sichern (Migration 064): ausdrücklich (Daumen mit Kommentar) und automatisch aus Entscheidungen und Prüfungen
 * (Ablehnungen, Bearbeitungen, ersetzte Behauptungen, nicht ausgeführte Befehle, Fehler). Ziel: Prompt, KI-Sheet und Agenten
 * laufend verbessern. Sichern darf nie den eigentlichen Vorgang stören: Fehler werden geschluckt.
 */
export interface FeedbackInput {
  orgId: string; projectId?: string | null; agentId?: string | null; userId?: string | null;
  kind: AiFeedbackKind; rating?: 1 | -1 | null; comment?: string | null;
  sourceType: string; sourceId: string;
  context?: Record<string, unknown>;
}

const MAX = 4000;
const clip = (v: unknown): unknown => {
  if (typeof v === 'string') return v.length > MAX ? `${v.slice(0, MAX)} …` : v;
  if (Array.isArray(v)) return v.slice(0, 20).map(clip);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined && x !== null && x !== '').map(([k, x]) => [k, clip(x)]));
  return v;
};
/** Je Person und Quelle nur ein Eintrag: Bewertung und bearbeiteter Entwurf werden aktualisiert statt verdoppelt. */
const ONCE: AiFeedbackKind[] = ['rating', 'draft_edited'];

export async function recordFeedback(db: Db, f: FeedbackInput): Promise<void> {
  try {
    const context = JSON.stringify(clip(f.context ?? {}));
    const comment = f.comment?.trim() ? f.comment.trim().slice(0, 2000) : null;
    if (ONCE.includes(f.kind)) {
      const cur = await db.maybeOne(`select id, context from ai_feedback where kind = $1 and source_type = $2 and source_id = $3 and user_id is not distinct from $4::uuid`, [f.kind, f.sourceType, f.sourceId, f.userId ?? null]);
      if (cur) {
        // Bearbeiteter Entwurf: „vorher“ bleibt die Fassung des Agenten
        const merged = f.kind === 'draft_edited' ? JSON.stringify({ ...(clip(f.context ?? {}) as object), before: cur.context?.before ?? (f.context as any)?.before }) : context;
        await db.query(`update ai_feedback set rating = $2, comment = $3, context = $4::jsonb, updated_at = now() where id = $1`, [cur.id, f.rating ?? null, comment, merged]);
        return;
      }
    }
    await db.query(`insert into ai_feedback (org_id, project_id, agent_user_id, user_id, kind, rating, comment, source_type, source_id, context) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [f.orgId, f.projectId ?? null, f.agentId ?? null, f.userId ?? null, f.kind, f.rating ?? null, comment, f.sourceType, f.sourceId, context]);
  } catch { /* Feedback ist Beiwerk: nie den Vorgang abbrechen */ }
}

/** Bewertung zurücknehmen (Daumen erneut geklickt). */
export async function clearRating(db: Db, userId: string, sourceType: string, sourceId: string): Promise<void> {
  await db.query(`delete from ai_feedback where kind = 'rating' and source_type = $1 and source_id = $2 and user_id = $3`, [sourceType, sourceId, userId]);
}

/** Eigene Bewertungen zu Quellen (für den Zustand der Daumen). */
export async function myRatings(db: Db, userId: string, sourceType: string, ids: string[]): Promise<Map<string, 1 | -1>> {
  if (!ids.length) return new Map();
  const r = await db.query(`select source_id, rating from ai_feedback where kind = 'rating' and source_type = $1 and user_id = $2 and source_id = any($3::text[])`, [sourceType, userId, ids]);
  return new Map(r.rows.map((x: any) => [x.source_id, x.rating === 1 ? 1 : -1]));
}

export interface FeedbackQuery { kind?: string; agentId?: string; rating?: 'up' | 'down'; from?: string; to?: string; limit?: number }
export async function listFeedback(db: Db, orgId: string, q: FeedbackQuery = {}): Promise<AiFeedbackEntry[]> {
  const where = ['f.org_id = $1']; const args: unknown[] = [orgId];
  const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
  if (q.kind) add('f.kind = ?', q.kind);
  if (q.agentId && /^[0-9a-f-]{36}$/i.test(q.agentId)) add('f.agent_user_id = ?::uuid', q.agentId);
  if (q.rating === 'up') where.push('f.rating = 1'); if (q.rating === 'down') where.push('(f.rating = -1 or f.kind <> \'rating\')');
  if (q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from)) add('f.created_at >= ?::date', q.from);
  if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) add(`f.created_at < (?::date + interval '1 day')`, q.to);
  const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 10_000);
  const r = await db.query(`select f.*, a.name as agent_name, u.name as user_name, ${PROJECT_LABEL_SQL} as project_label
      from ai_feedback f left join users a on a.id = f.agent_user_id left join users u on u.id = f.user_id
      left join projects p on p.id = f.project_id left join users ow on ow.id = p.created_by
      where ${where.join(' and ')} order by f.updated_at desc limit ${limit}`, args);
  return r.rows.map((x: any) => ({ id: x.id, kind: x.kind, rating: x.rating === 1 ? 1 : x.rating === -1 ? -1 : null, comment: x.comment ?? null, sourceType: x.source_type, sourceId: x.source_id,
    agent: x.agent_user_id ? { id: x.agent_user_id, name: x.agent_name ?? '–' } : null, user: x.user_id ? { id: x.user_id, name: x.user_name ?? '–' } : null,
    project: x.project_id ? x.project_label ?? null : null, context: x.context ?? {}, createdAt: x.created_at, updatedAt: x.updated_at }));
}
