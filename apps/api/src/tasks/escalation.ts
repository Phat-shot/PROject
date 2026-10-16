import type { Db } from '../db.js';
import { audit } from '../audit.js';
import { notify, notifyMany } from '../notify.js';
import { dateStr, loadTasks, resolveProjectLead } from './service.js';

/**
 * Eskalationsregelwerk (Regel vor KI). Die KI liefert später nur Text und Einschätzung aus Mailinhalten;
 * Stufen, Zeitpunkte und Empfänger kommen aus diesem Regelwerk und werden vom Worker ausgeführt.
 */
export interface EscalationPolicy {
  enabled: boolean;
  /** Tage überfällig bis Stufe 1/2/3 (Teilprojekt-Verantwortlicher / PL / Eskalationskontakt). */
  stageDays: [number, number, number];
  /** Tage ohne Aktivität in einer aktiven Spalte, bis das Arbeitspaket als „hängt“ gilt (Stufe 1). */
  staleDays: number;
  /** Interner Eskalationskontakt (z. B. Vorgesetzte/r, Auftraggeber im Haus). */
  contactUserId: string | null;
  /** Externe Eskalationsadresse (z. B. Auftraggeber). */
  contactEmail: string | null;
  /** Externe Eskalationsmail: Vorschlag (Freigabe durch PL) oder direkt. */
  externalMode: 'proposal' | 'direct';
}

export const DEFAULT_POLICY: EscalationPolicy = { enabled: true, stageDays: [2, 5, 10], staleDays: 7, contactUserId: null, contactEmail: null, externalMode: 'proposal' };

export function policyOf(raw: any): EscalationPolicy {
  const p = { ...DEFAULT_POLICY, ...(raw ?? {}) };
  if (!Array.isArray(p.stageDays) || p.stageDays.length !== 3) p.stageDays = DEFAULT_POLICY.stageDays;
  return p;
}

export const LEVEL_LABEL = ['keine', 'Stufe 1: Teilprojekt-Verantwortung', 'Stufe 2: Projektleitung', 'Stufe 3: Eskalationskontakt'];

/**
 * Kritikalität als Punkteregel: Priorität, Verzug, Lage im Plan (blockierte Nachfolger, Meilenstein nah), Blockiert-Flag.
 * Ab 6 Punkten werden die Stufenfristen halbiert.
 */
export function criticality(t: { priority: string; overdueDays: number; successors: number; milestoneWithinDays: number | null; blocked: boolean }): number {
  let s = 0;
  s += t.priority === 'critical' ? 4 : t.priority === 'high' ? 2 : t.priority === 'low' ? -1 : 0;
  s += t.overdueDays >= 10 ? 3 : t.overdueDays >= 5 ? 2 : t.overdueDays >= 1 ? 1 : 0;
  s += Math.min(3, t.successors);
  if (t.milestoneWithinDays !== null && t.milestoneWithinDays <= 14) s += 2;
  if (t.blocked) s += 2;
  return s;
}

export function targetLevel(input: { overdueDays: number; staleDays: number; blocked: boolean; score: number }, p: EscalationPolicy): number {
  const factor = input.score >= 6 ? 0.5 : 1;
  const d = p.stageDays.map((x) => Math.max(0, Math.ceil(x * factor)));
  let level = 0;
  if (input.overdueDays >= d[0]) level = 1;
  if (input.overdueDays >= d[1]) level = 2;
  if (input.overdueDays >= d[2]) level = 3;
  if (input.blocked || input.staleDays >= p.staleDays) level = Math.max(level, 1);
  if (input.blocked && input.staleDays >= Math.ceil(p.staleDays * factor)) level = Math.max(level, 2);
  return level;
}

export interface EscalationRow {
  taskId: string; title: string; projectId: string; level: number; targetLevel: number; overdueDays: number; staleDays: number; blocked: boolean; blockedReason: string | null;
  score: number; dueDate: string | null; responsible: string | null; chain: string[]; reason: string;
}

/** Berechnet Soll-Stufen aller offenen Arbeitspakete eines Projekts (ohne Nebenwirkungen). */
export async function evaluateProject(db: Db, projectId: string, today: string): Promise<EscalationRow[]> {
  const policyRow = await db.one(`select escalation from projects where id = $1`, [projectId]);
  const p = policyOf(policyRow.escalation);
  if (!p.enabled) return [];
  const lead = await resolveProjectLead(db, projectId);
  const tasks = await loadTasks(db, 't.project_id = $1 and t.archived_at is null', [projectId], lead);
  const raw = await db.query(`select id, blocked, blocked_reason, escalation_level, last_activity_at, column_id, subproject_id from tasks where project_id = $1 and archived_at is null`, [projectId]);
  const rawById = new Map(raw.rows.map((r: any) => [r.id, r]));
  const cols = await db.query(`select id, position, is_done, kind from board_columns where project_id = $1 order by position`, [projectId]);
  const activeCols = new Set(cols.rows.filter((c: any) => (c.kind ?? 'active') === 'active').map((c: any) => c.id));
  const succCount = await db.query(`select predecessor_id, count(*)::int as c from task_dependencies group by predecessor_id`);
  const succ = new Map(succCount.rows.map((r: any) => [r.predecessor_id, r.c]));
  const milestones = await db.query(`select subproject_id, date from milestones where project_id = $1 and date >= $2 order by date`, [projectId, today]);
  const subs = await db.query(`select s.id, s.name, u.name as resp_name from subprojects s left join users u on u.id = s.responsible_user_id where s.project_id = $1`, [projectId]);
  const subById = new Map(subs.rows.map((s: any) => [s.id, s]));
  const contact = p.contactUserId ? await db.maybeOne(`select name from users where id = $1`, [p.contactUserId]) : null;
  const out: EscalationRow[] = [];
  for (const t of tasks) {
    if (t.done) continue;
    const r = rawById.get(t.id);
    if (!r) continue;
    const overdueDays = t.dueDate && t.dueDate < today ? Math.round((Date.parse(today) - Date.parse(t.dueDate)) / 86400_000) : 0;
    const active = activeCols.has(r.column_id);
    const staleDays = active ? Math.floor((Date.parse(today + 'T00:00:00Z') - new Date(r.last_activity_at).getTime()) / 86400_000) : 0;
    const ms = milestones.rows.find((m: any) => !m.subproject_id || m.subproject_id === t.subprojectId);
    const milestoneWithinDays = ms ? Math.round((Date.parse(dateStr(ms.date)!) - Date.parse(today)) / 86400_000) : null;
    const score = criticality({ priority: t.priority, overdueDays, successors: succ.get(t.id) ?? 0, milestoneWithinDays, blocked: r.blocked });
    let target = targetLevel({ overdueDays, staleDays, blocked: r.blocked, score }, p);
    // Ohne Eskalationskontakt endet die Kette beim PL
    if (!p.contactUserId && !p.contactEmail) target = Math.min(target, 2);
    if (target === 0 && r.escalation_level === 0) continue;
    const sub = t.subprojectId ? subById.get(t.subprojectId) : null;
    const chain = [t.responsible.name ?? t.responsible.email ?? '–', sub?.resp_name ? `${sub.resp_name} (TP ${sub.name})` : `PL (TP ohne Verantwortlichen)`, lead.name ?? 'PL', contact?.name ?? p.contactEmail ?? '– kein Eskalationskontakt –'];
    const reasons: string[] = [];
    if (r.blocked) reasons.push(`blockiert${r.blocked_reason ? `: ${r.blocked_reason}` : ''}`);
    if (overdueDays > 0) reasons.push(`${overdueDays} Tage überfällig`);
    if (staleDays >= p.staleDays) reasons.push(`${staleDays} Tage ohne Aktivität`);
    if (score >= 6) reasons.push(`hohe Kritikalität (${score} Punkte, Fristen halbiert)`);
    out.push({ taskId: t.id, title: t.title, projectId, level: r.escalation_level, targetLevel: target, overdueDays, staleDays, blocked: r.blocked, blockedReason: r.blocked_reason, score, dueDate: t.dueDate, responsible: t.responsible.name ?? t.responsible.email, chain, reason: reasons.join(', ') || 'zurückgestuft' });
  }
  return out.sort((a, b) => b.targetLevel - a.targetLevel || b.score - a.score);
}

/** Worker: Stufen anheben (benachrichtigen, Log, ggf. Mail-Entwurf) und zurücksetzen, wenn der Grund entfällt. */
export async function runEscalations(db: Db, today = new Date().toISOString().slice(0, 10)) {
  const projects = await db.query(`select id, org_id, name, key, escalation from projects where status = 'active'`);
  let raised = 0, reset = 0;
  for (const pr of projects.rows) {
    const p = policyOf(pr.escalation);
    const rows = await evaluateProject(db, pr.id, today);
    for (const row of rows) {
      if (row.targetLevel > row.level) {
        await escalate(db, pr, p, row, today);
        raised++;
      } else if (row.targetLevel === 0 && row.level > 0) {
        await db.query(`update tasks set escalation_level = 0, escalated_at = null where id = $1`, [row.taskId]);
        await db.query(`insert into task_comments (task_id, user_id, body, source) select $1, created_by, $2, 'system' from tasks where id = $1`, [row.taskId, `Eskalation zurückgesetzt: Grund entfallen (${today}).`]);
        await audit(db, { orgId: pr.org_id, projectId: pr.id, userId: null, action: 'escalation.reset', objectType: 'task', objectId: row.taskId });
        reset++;
      }
    }
  }
  return { raised, reset };
}

async function escalate(db: Db, pr: any, p: EscalationPolicy, row: EscalationRow, today: string) {
  const task = await db.one(`select t.*, s.responsible_user_id as sub_resp from tasks t left join subprojects s on s.id = t.subproject_id where t.id = $1`, [row.taskId]);
  const lead = await resolveProjectLead(db, pr.id);
  const link = `/projekte/${pr.id}/board?task=${row.taskId}`;
  const title = `Eskalation ${LEVEL_LABEL[row.targetLevel]}: ${row.title}`;
  const body = `${row.reason}. Kette: ${row.chain.slice(0, row.targetLevel + 1).join(' → ')}`;
  const targets = new Set<string>();
  // Zuständiger wird immer informiert, dann die Stufe und alle darunter
  if (task.responsible_user_id) targets.add(task.responsible_user_id);
  if (row.targetLevel >= 1) targets.add(task.sub_resp ?? lead.userId ?? '');
  if (row.targetLevel >= 2) {
    const pls = await db.query(`select user_id from project_members where project_id = $1 and role = 'pl'`, [pr.id]);
    pls.rows.forEach((r: any) => targets.add(r.user_id));
  }
  if (row.targetLevel >= 3 && p.contactUserId) targets.add(p.contactUserId);
  targets.delete('');
  await notifyMany(db, targets, { projectId: pr.id, type: 'escalation', title, body, link, dedupeKey: `esc:${row.taskId}:${row.targetLevel}` });
  await db.query(`update tasks set escalation_level = $2, escalated_at = now() where id = $1`, [row.taskId, row.targetLevel]);
  await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1, $2, $3, 'system')`, [row.taskId, task.created_by ?? lead.userId, `${title}\n${body}`]);
  await audit(db, { orgId: pr.org_id, projectId: pr.id, userId: null, action: 'escalation.raise', objectType: 'task', objectId: row.taskId, details: { level: row.targetLevel, reason: row.reason, score: row.score, overdueDays: row.overdueDays, staleDays: row.staleDays } });
  // Stufe 3 mit externer Adresse: Mail über das Projektkonto, als Entwurf zur Freigabe oder direkt
  if (row.targetLevel >= 3 && p.contactEmail) {
    const account = await db.maybeOne(`select * from mail_accounts where project_id = $1 and type = 'project' order by created_at limit 1`, [pr.id]);
    if (account) {
      const text = `Guten Tag,\n\nim Projekt „${pr.name}“ ist das Arbeitspaket „${row.title}“ ${row.reason}. Zuständig: ${row.responsible ?? '–'}. Fällig: ${row.dueDate ?? '–'}.\n\nWir bitten um Entscheidung bzw. Unterstützung.\n\nMit freundlichen Grüßen\n${lead.name ?? 'Projektleitung'}`;
      const d = await db.one(
        `insert into mail_drafts (account_id, project_id, task_id, user_id, to_addrs, subject, body, status) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [account.id, pr.id, row.taskId, lead.userId, JSON.stringify([p.contactEmail]), `Eskalation ${pr.key}: ${row.title}`, text, p.externalMode === 'direct' ? 'draft' : 'pending_approval']
      );
      if (p.externalMode === 'direct') {
        const { MailService } = await import('../mail/service.js');
        const svc = new MailService(db);
        try {
          await svc.sendFromAccount(account, { to: [p.contactEmail], subject: `Eskalation ${pr.key}: ${row.title}`, text, taskId: row.taskId, userId: lead.userId!, projectId: pr.id });
          await db.query(`update mail_drafts set status = 'sent', sent_at = now() where id = $1`, [d.id]);
        } catch (e: any) {
          await db.query(`update mail_drafts set status = 'failed', error = $2 where id = $1`, [d.id, String(e?.message ?? e)]);
        }
      } else if (lead.userId) {
        await notify(db, { userId: lead.userId, projectId: pr.id, type: 'mail.approval', title: `Freigabe: Eskalationsmail an ${p.contactEmail}`, body: row.title, link: `/projekte/${pr.id}/mail/freigaben`, dedupeKey: `escmail:${row.taskId}` });
      }
    }
  }
}
