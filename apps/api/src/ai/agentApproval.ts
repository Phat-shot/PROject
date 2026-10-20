import type { AgentActionClass, User } from '@projekttool/shared';
import type { Db } from '../db.js';
import type { MailService } from '../mail/service.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { getMembership } from '../rights.js';
import { accountRights, projectAccount } from '../mail/accounts.js';
import { contactChain } from '../tasks/service.js';
import { answerQuestion, cancelQuestions, type QuestionRow } from '../questions.js';
import { aiConfigFor } from './client.js';
import { applyAgentActions, baseOf, gateAction, loadRunCtx, loadTaskForAgent } from './agent.js';
import { canDecideClass } from './agentPolicy.js';

/**
 * Bestätigung angehaltener Agentenaktionen (Konzept 6.5). Entscheiden darf die PL, wer „Freigeben“ und das Recht der Klasse hat
 * (Final setzen für finalize und distribute, Projektplan ändern für plan, foreign und restructure, Senderecht für send_external),
 * bei close, assign und schedule auch der Ansprechpartner des AP; Agenten nie. Ausgeführt wird mit den aktuellen Rechten des
 * Agenten über denselben Code wie der Lauf (Gate erneut, Stand geprüft: stale oder failed statt stillschweigend anders).
 */
const EXPIRE_H = 336;
/** Vergleich unabhängig von der Schlüsselreihenfolge (jsonb sortiert Schlüssel). */
const stable = (o: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v === null || v === undefined ? null : String(v)])));

export interface ProposalRow { id: string; org_id: string; project_id: string; task_id: string | null; question_id: string | null; status: string; payload: any; action_class: AgentActionClass | null; seq: number; depends_on: string | null; created_by: string | null; agent_run_id: string | null }

export async function canDecideProposal(db: Db, user: User, p: ProposalRow): Promise<boolean> {
  if (user.kind === 'agent') return false;
  const m = await getMembership(db, p.project_id, user.id);
  if (!m || m.role === 'reader') return false;
  const acc = p.action_class === 'send_external' ? await projectAccount(db, p.project_id) : null;
  const canSend = acc ? (await accountRights(db, user, acc, p.project_id)).canSend : false;
  if (canDecideClass(m, p.action_class, { canSend })) return true;
  // Ansprechpartner (Stufe 0 der Kette) bei Erledigt, Zuweisung und Terminen
  if (p.task_id && ['close', 'assign', 'schedule'].includes(p.action_class ?? '')) {
    const task = await db.maybeOne(`select t.*, p.key as project_key from tasks t join projects p on p.id = t.project_id where t.id = $1`, [p.task_id]);
    const chain = task ? await contactChain(db, task, { exclude: [p.created_by ?? ''] }) : [];
    if (chain[0]?.id === user.id) return true;
  }
  return false;
}

export interface DecideInput { ids: string[]; approve: boolean; reason?: string | null; user: User; now?: Date }

/** Vorschläge entscheiden; liefert die betroffenen Zeilen. Bestätigte werden in seq-Reihenfolge ausgeführt, Abhängige folgen ihrer Voraussetzung. */
export async function decideProposals(db: Db, mail: MailService, fetchFn: typeof fetch, x: DecideInput): Promise<ProposalRow[]> {
  const now = x.now ?? new Date();
  const rows = (await db.query<ProposalRow>(`select * from ai_proposals where id = any($1::uuid[]) and kind = 'agent_action' order by seq, created_at`, [x.ids])).rows;
  if (!rows.length) throw notFound('Vorschlag nicht gefunden');
  const pending = rows.filter((r) => r.status === 'pending');
  if (!pending.length) throw badRequest('Vorschlag ist bereits entschieden');
  for (const p of pending) if (!(await canDecideProposal(db, x.user, p))) throw forbidden('Bestätigen darf die PL, wer „Freigeben“ und das Recht der Aktion hat, oder der Ansprechpartner des Arbeitspakets');
  const reason = String(x.reason ?? '').trim();
  if (!x.approve && !reason) throw badRequest('Ablehnen braucht einen Grund');
  const log = (taskId: string | null, userId: string, body: string) => (taskId ? db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'system')`, [taskId, userId, body]) : Promise.resolve());
  const set = (id: string, status: string, result: string | null) => db.query(`update ai_proposals set status = $2, decided_by = $3, decided_at = now(), note = $4, result = $5 where id = $1`, [id, status, x.user.id, x.approve ? null : reason || null, result]);

  if (!x.approve) {
    for (const p of pending) {
      await set(p.id, 'rejected', null);
      await log(p.task_id, x.user.id, `Abgelehnt von ${x.user.name}: ${p.payload?.label ?? p.action_class ?? 'Aktion'} – ${reason}`);
      // Abhängige Vorschläge (z. B. PDF-Versand nach Final-Setzen) fallen mit
      const deps = await db.query<ProposalRow>(`select * from ai_proposals where depends_on = $1 and status = 'pending'`, [p.id]);
      for (const d of deps.rows) { await set(d.id, 'rejected', 'Voraussetzung abgelehnt'); await log(d.task_id, x.user.id, `Entfällt mit der Ablehnung: ${d.payload?.label ?? 'Aktion'}`); }
      await audit(db, { orgId: p.org_id, projectId: p.project_id, userId: x.user.id, action: 'agent.action.rejected', objectType: 'ai_proposal', objectId: p.id, details: { reason, label: p.payload?.label } });
    }
  } else {
    // Je Arbeitspaket ein Kontext (Rechte des Agenten jetzt)
    const byTask = new Map<string, ProposalRow[]>();
    for (const p of pending) { const k = p.task_id ?? ''; byTask.set(k, [...(byTask.get(k) ?? []), p]); }
    for (const [taskId, list] of byTask) {
      const task = taskId ? await loadTaskForAgent(db, taskId) : null;
      const agent = list[0].created_by ? await db.maybeOne(`select id, name, org_id, persona from users u where u.id = $1 and u.kind = 'agent' and u.active`, [list[0].created_by]) : null;
      const m = task && agent ? await db.maybeOne(`select * from project_members where project_id = $1 and user_id = $2`, [task.project_id, agent.id]) : null;
      if (!task || !agent || !m) { for (const p of list) { await set(p.id, 'failed', !task ? 'Arbeitspaket nicht mehr vorhanden' : 'Agent nicht mehr aktiv oder kein Mitglied'); } continue; }
      const gate = await aiConfigFor(db, { userId: agent.id, projectId: task.project_id, feature: 'agent.run', taskId: task.id, budget: false, now });
      if (!gate.cfg) { for (const p of list) { await set(p.id, 'failed', `Agent gesperrt: ${gate.decision.publicReason}`); await log(task.id, x.user.id, `Nicht ausgeführt (${p.payload?.label ?? 'Aktion'}): ${gate.decision.publicReason}`); } continue; }
      const ctx = await loadRunCtx(db, mail, fetchFn, agent, task, m, gate.cfg, 'approved', now);
      const applied: unknown[] = []; const errors: string[] = []; const approvedNow = new Set<string>();
      for (const p of list) {
        const a = p.payload?.action;
        if (!a) { await set(p.id, 'failed', 'Aktion fehlt'); continue; }
        if (p.depends_on) {
          const dep = await db.maybeOne(`select status from ai_proposals where id = $1`, [p.depends_on]);
          if (dep && dep.status !== 'approved') { await set(p.id, 'failed', 'Voraussetzung nicht bestätigt'); await log(task.id, x.user.id, `Nicht ausgeführt (${p.payload?.label}): Voraussetzung nicht bestätigt`); continue; }
        }
        // Stand geprüft: hat sich die Grundlage geändert, ist der Vorschlag veraltet (nicht, wenn die eben bestätigte Voraussetzung sie geändert hat)
        const base = await baseOf(ctx, a);
        if (!(p.depends_on && approvedNow.has(p.depends_on)) && stable(base) !== stable(p.payload?.base ?? {})) { await set(p.id, 'stale', 'Stand hat sich geändert'); await log(task.id, x.user.id, `Nicht ausgeführt (${p.payload?.label}): der Stand hat sich seit dem Vorschlag geändert`); continue; }
        const g = await gateAction(ctx, a, { hold: false, approvedBy: x.user.name });
        if (g.verdict === 'deny') { await set(p.id, 'failed', g.reason); await log(task.id, x.user.id, `Nicht ausgeführt: ${g.reason}`); continue; }
        const r = await applyAgentActions(ctx, [a], { hold: false, approvedBy: x.user.name });
        if (r.errors.length) { await set(p.id, 'failed', r.errors.join(' | ').slice(0, 500)); errors.push(...r.errors); await log(task.id, x.user.id, `Nicht ausgeführt (${p.payload?.label}): ${r.errors.join('; ').slice(0, 300)}`); }
        else { await set(p.id, 'approved', p.payload?.label ?? null); approvedNow.add(p.id); applied.push(...r.applied); await log(task.id, x.user.id, `Ausgeführt nach Bestätigung durch ${x.user.name}: ${p.payload?.label ?? a.type}`); }
        await audit(db, { orgId: p.org_id, projectId: p.project_id, userId: x.user.id, action: 'agent.action.approved', objectType: 'ai_proposal', objectId: p.id, details: { label: p.payload?.label, ok: !r.errors.length } });
      }
      // Lauf-Protokoll der Ausführung (Projekt › KI), ohne LLM-Aufruf
      await db.query(`insert into agent_runs (org_id, agent_user_id, project_id, task_id, trigger, status, reasoning, actions, input_tokens, output_tokens, error) values ($1,$2,$3,$4,'approved',$5,$6,$7,$8,$9,$10)`,
        [agent.org_id, agent.id, task.project_id, task.id, errors.length ? 'error' : 'ok', `Bestätigt von ${x.user.name}: ${list.map((p) => p.payload?.label).filter(Boolean).join('; ')}`.slice(0, 2000), JSON.stringify(applied), ctx.tokens.input, ctx.tokens.output, errors.length ? errors.join(' | ').slice(0, 1000) : null]);
    }
  }
  // Frage abschließen, wenn nichts mehr offen ist; der Agent läuft mit Anlass approved bzw. rejected weiter
  for (const qid of new Set(pending.map((p) => p.question_id).filter((v): v is string => Boolean(v)))) {
    const open = await db.maybeOne(`select 1 from ai_proposals where question_id = $1 and status = 'pending'`, [qid]);
    if (open) continue;
    const q = await db.maybeOne<QuestionRow>(`select * from questions where id = $1 and status = 'open'`, [qid]);
    if (!q) continue;
    const all = (await db.query(`select status, payload from ai_proposals where question_id = $1 order by seq`, [qid])).rows;
    const n = (st: string) => all.filter((r: any) => r.status === st).length;
    const text = [`${n('approved')} ausgeführt`, n('rejected') ? `${n('rejected')} abgelehnt` : '', n('stale') ? `${n('stale')} veraltet` : '', n('failed') ? `${n('failed')} fehlgeschlagen` : ''].filter(Boolean).join(', ');
    await answerQuestion(db, q, { source: 'task', userId: x.user.id, text, option: x.approve ? 'approved' : 'rejected', now, trigger: n('approved') ? 'approved' : 'rejected' });
  }
  return (await db.query<ProposalRow>(`select * from ai_proposals where id = any($1::uuid[]) order by seq, created_at`, [x.ids])).rows;
}

/** Offene Vorschläge nach 14 Tagen verfallen lassen; die Frage dazu erledigt sich (Worker). */
export async function expireProposals(db: Db, now = new Date()): Promise<number> {
  const rows = await db.query<ProposalRow>(`update ai_proposals set status = 'expired', result = 'abgelaufen' where kind = 'agent_action' and status = 'pending' and created_at < $1 returning *`, [new Date(now.getTime() - EXPIRE_H * 3600_000)]);
  for (const p of rows.rows) {
    await audit(db, { orgId: p.org_id, projectId: p.project_id, userId: null, action: 'agent.action.expired', objectType: 'ai_proposal', objectId: p.id, details: { label: p.payload?.label } });
    if (p.question_id && !(await db.maybeOne(`select 1 from ai_proposals where question_id = $1 and status = 'pending'`, [p.question_id]))) await cancelQuestions(db, { questionId: p.question_id }, 'Bestätigung nach 14 Tagen abgelaufen');
  }
  return rows.rows.length;
}
