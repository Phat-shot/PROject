import type { ChatOrdersLevel, EffectiveAgentPolicy } from '@projekttool/shared';
import type { Db } from '../db.js';
import { audit } from '../audit.js';
import { notify, systemMessage } from '../notify.js';
import { canSeeSubproject, getMembership } from '../rights.js';
import { contactChain, touchTask } from '../tasks/service.js';
import { askQuestion, cancelQuestions, type Asker } from '../questions.js';
import { setRules } from '../rules.js';
import { cleanTitle, createPlannedTask, findTaskByRef, ymd, type PlanActor } from './plan.js';
import { queueAgentRun } from './agentEvents.js';
import { CHAT_ORDERS, MODE_ORDER, effectiveAgentPolicy, parseAgentPolicy } from './agentPolicy.js';
import { aiAllowed } from './policy.js';
import { SQL } from '../projectPolicy.js';

/**
 * Steuerung der Agenten im Chat (Konzept 7). Das Modell liefert Befehle, das System prüft sie (Rechte des Absenders nach 7.1,
 * Agenten-Policy, Rechte) und führt sie aus; erst danach wird gepostet: die Antwort des Agenten und darunter eine Systemkarte
 * mit dem tatsächlichen Ergebnis je Befehl. Aufträge legt createPlannedTask mit den Rechten des Auftraggebers an; der Agent wird
 * zuständig und läuft mit Anlass order. Freigaben führt der Agent nie selbst aus: approve zeigt die Karte mit den offenen Vorschlägen.
 */
export type ChatCommandType = 'order' | 'note' | 'pause' | 'resume' | 'stop' | 'priority' | 'approve' | 'reject' | 'policy' | 'report' | 'refer';
export const COMMAND_TYPES: ChatCommandType[] = ['order', 'note', 'pause', 'resume', 'stop', 'priority', 'approve', 'reject', 'policy', 'report', 'refer'];
export interface ChatCommand { type: ChatCommandType; ref?: string | null; text?: string | null; title?: string | null; parent?: string | null; project?: string | null; subproject?: string | null; dueDate?: string | null; deliverables?: string[] | null; every?: string | null; level?: string | null; mode?: string | null; depth?: string | null; reason?: string | null; mail?: boolean | null }
export interface CommandResult { type: ChatCommandType; status: 'ok' | 'held' | 'denied'; text: string; link?: string | null; taskId?: string | null; questionId?: string | null; undoUntil?: string | null }

export type SenderRole = 'pl' | 'tp' | 'responsible' | 'member' | 'reader' | 'none';
const RANK: Record<ChatOrdersLevel, number> = { pl: 0, tp: 1, responsible: 2, members: 3 };
const cut = (s: unknown, n: number) => { const t = String(s ?? '').trim(); return t.length > n ? t.slice(0, n) + ' …' : t; };

export interface CommandCtx {
  db: Db; agent: Asker & { persona?: string | null }; sender: { id: string; name: string; orgId: string; kind?: string };
  /** Projekt des Gesprächs (Projektkanal) bzw. das einzige gemeinsame Projekt der DM; null = nicht eindeutig */
  project: { id: string; key: string; name: string } | null;
  /** weitere gemeinsame Projekte (DM), wenn kein eindeutiges */
  projects: { id: string; key: string; name: string }[];
  channelId: string; threadId: string | null; messageId: string; now: Date;
  policy: EffectiveAgentPolicy | null;
}

/** Rolle des Absenders gegenüber einem Arbeitspaket (oder dem Projekt, ohne task). */
export async function senderRole(db: Db, senderId: string, projectId: string, task: any | null): Promise<SenderRole> {
  const m = await getMembership(db, projectId, senderId);
  if (!m) return 'none';
  if (m.role === 'pl') return 'pl';
  if (m.role === 'reader') return 'reader';
  if (task) {
    if (task.subproject_id && (await db.maybeOne(`select 1 from subprojects where id = $1 and responsible_user_id = $2`, [task.subproject_id, senderId]))) return 'tp';
    if (task.responsible_user_id === senderId || task.requested_by === senderId) return 'responsible';
    const chain = await contactChain(db, task, {});
    if (chain[0]?.id === senderId) return 'responsible';
  }
  return 'member';
}

/** Erlaubte Befehle eines Absenders (für Kontext und Gate), nach 7.1. */
export function allowedCommands(role: SenderRole, policy: EffectiveAgentPolicy | null): { orders: boolean; control: boolean; approve: boolean; policy: boolean; note: boolean } {
  const lvl = policy?.chatOrders ?? 'pl';
  const orders = role === 'pl' || (role === 'tp' && RANK[lvl] >= RANK.tp) || (role === 'responsible' && RANK[lvl] >= RANK.responsible) || (role === 'member' && RANK[lvl] >= RANK.members);
  return { orders, control: role === 'pl' || role === 'tp' || role === 'responsible', approve: role !== 'reader' && role !== 'none', policy: role === 'pl', note: role !== 'reader' && role !== 'none' };
}

export const commandsText = (role: SenderRole, a: ReturnType<typeof allowedCommands>, policy: EffectiveAgentPolicy | null) => {
  const r: Record<SenderRole, string> = { pl: 'Projektleitung', tp: 'Teilprojekt-Verantwortung', responsible: 'Zuständige/r bzw. Ansprechpartner', member: 'Mitglied', reader: 'Leser (nur Auskunft)', none: 'ohne Projektzugriff (nur Auskunft)' };
  const can: string[] = [];
  if (a.orders) can.push(`Aufträge (order${role === 'pl' ? ', überall im Projekt' : role === 'tp' ? ', im eigenen Teilprojekt' : role === 'responsible' ? ', Aufgaben unter dem eigenen AP' : ''})`);
  else if (role !== 'reader' && role !== 'none') can.push(`keine Aufträge (Policy chatOrders = ${policy?.chatOrders ?? 'pl'}: Vorschlag an die PL als order_request über refer)`);
  if (a.control) can.push(`Steuerbefehle pause, resume, stop, priority${role === 'pl' ? ' an allen Arbeitspaketen' : ' an eigenen Arbeitspaketen'}`);
  if (a.approve) can.push('approve/reject zeigt die Karte mit offenen Bestätigungen (Klick entscheidet)');
  if (a.policy) can.push('policy (Selbstständigkeit je AP), report (Zwischenstände)');
  else if (a.note) can.push('report (eigene Zwischenstände)');
  if (a.note) can.push('note (Information ins Log)');
  return `${r[role]}; darf: ${can.join('; ') || 'nur Auskunft'}`;
};

/** Alle Befehle prüfen und ausführen; Ergebnisse in Reihenfolge. */
export async function runCommands(ctx: CommandCtx, cmds: ChatCommand[]): Promise<CommandResult[]> {
  const out: CommandResult[] = [];
  let orders = 0;
  // Auftrag zuerst: Folgebefehle derselben Antwort (report, note, priority …) beziehen sich oft auf das neue AP, dessen Kennung das Modell nicht kennt
  const list = cmds.slice(0, 5).map((c, i) => ({ c, i })).sort((a, b) => Number(b.c?.type === 'order') - Number(a.c?.type === 'order') || a.i - b.i).map((x) => x.c);
  let ordered: Ordered = null;
  for (const c of list) {
    if (!COMMAND_TYPES.includes(c?.type)) continue;
    if (c.type === 'order' && orders++ >= 1) { out.push({ type: c.type, status: 'denied', text: 'Höchstens ein Auftrag je Nachricht' }); continue; }
    try {
      const r = await runOne(ctx, c, ordered);
      if (c.type === 'order' && r.status === 'ok' && r.taskId) ordered = { taskId: r.taskId, projectId: (await ctx.db.one(`select project_id from tasks where id = $1`, [r.taskId])).project_id };
      out.push(r);
    }
    catch (e: any) { out.push({ type: c.type, status: 'denied', text: `${c.type}: ${String(e?.message ?? e).slice(0, 200)}` }); }
  }
  return out;
}

/** In dieser Antwort per order angelegtes AP: Ziel für „neu“ und für eine Kennung im selben Projekt, die es (noch) nicht gibt. */
type Ordered = { taskId: string; projectId: string } | null;
type ScopeProject = { id: string; key: string; name: string };
/** Projekt einer Kennung (Kürzel vor dem Bindestrich) unter den gemeinsamen Projekten, sonst das Gesprächsprojekt. */
const projectOf = (ctx: CommandCtx, ref: string): ScopeProject | null => { const key = ref.split('-')[0].toUpperCase(); return ctx.project && ctx.project.key === key ? ctx.project : ctx.projects.find((p) => p.key === key) ?? ctx.project; };

async function targetTask(ctx: CommandCtx, c: ChatCommand, ordered: Ordered = null): Promise<{ task: any; project: ScopeProject } | { error: string }> {
  const ref = String(c.ref ?? '').trim();
  const fromOrder = async () => {
    const task = await ctx.db.one(`select * from tasks where id = $1`, [ordered!.taskId]);
    const project: ScopeProject = [ctx.project, ...ctx.projects].find((p) => p?.id === task.project_id) ?? await ctx.db.one(`select id, key, name from projects where id = $1`, [task.project_id]);
    return { task, project };
  };
  if ((!ref || /^(neu|new)$/i.test(ref)) && ordered) return fromOrder();
  if (!ref) return { error: 'Kennung fehlt' };
  const project = projectOf(ctx, ref);
  if (!project) return { error: `${ref}: kein gemeinsames Projekt` };
  const task = await findTaskByRef(ctx.db, project.id, ref);
  if (!task && ordered?.projectId === project.id) return fromOrder();
  if (!task) return { error: `${ref} nicht gefunden` };
  if (!(await canSeeSubproject(ctx.db, ctx.sender.id, task.subproject_id)) || !(await canSeeSubproject(ctx.db, ctx.agent.id, task.subproject_id))) return { error: `${ref}: kein Zugriff` };
  return { task, project };
}

const link = (projectId: string, taskId: string) => `/projekte/${projectId}/board?task=${taskId}`;

async function runOne(ctx: CommandCtx, c: ChatCommand, ordered: Ordered = null): Promise<CommandResult> {
  const { db, agent, sender, now } = ctx;
  if (c.type === 'order') return createOrder(ctx, c);
  if (c.type === 'refer') {
    // Absender ohne Auftragsrecht: Vorschlag als Frage order_request an die PL
    if (!ctx.project) return { type: c.type, status: 'denied', text: 'Projekt nicht eindeutig' };
    const text = cut(c.text ?? c.title, 1500);
    if (!text) return { type: c.type, status: 'denied', text: 'refer ohne Text' };
    return orderRequest(ctx, ctx.project, text, null);
  }
  const t = await targetTask(ctx, c, ordered);
  if ('error' in t) return { type: c.type, status: 'denied', text: t.error };
  const { task, project } = t;
  const code = `${project.key}-${task.number}`;
  const role = await senderRole(db, sender.id, project.id, task);
  const policy = await effectiveAgentPolicy(db, { agentId: agent.id, projectId: project.id, taskId: task.id });
  const a = allowedCommands(role, policy);
  const lnk = link(project.id, task.id);
  switch (c.type) {
    case 'note': {
      if (!a.note) return { type: c.type, status: 'denied', text: `${code}: Leser schreiben keine Notizen ins Log` };
      const text = cut(c.text, 2000);
      if (!text) return { type: c.type, status: 'denied', text: `${code}: Notiz ohne Text` };
      await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'chat')`, [task.id, sender.id, text]);
      await touchTask(db, task.id);
      queueAgentRun(task.id, 'comment');
      return { type: c.type, status: 'ok', text: `${code}: im Log vermerkt (${sender.name})`, link: lnk, taskId: task.id };
    }
    case 'pause': case 'resume': case 'stop': case 'priority': {
      if (!a.control) return { type: c.type, status: 'denied', text: `${code}: Steuerbefehle geben PL, Teilprojekt-Verantwortung oder Zuständige` };
      if (role !== 'pl' && role !== 'tp' && !(task.responsible_user_id === sender.id || task.requested_by === sender.id || task.parent_id && (await db.maybeOne(`select 1 from tasks where id = $1 and (responsible_user_id = $2 or requested_by = $2)`, [task.parent_id, sender.id])))) {
        const chain = await contactChain(db, task, {});
        if (chain[0]?.id !== sender.id) return { type: c.type, status: 'denied', text: `${code}: nur am eigenen Arbeitspaket` };
      }
      if (c.type === 'priority') {
        const lv = String(c.level ?? '').trim().toLowerCase();
        const map: Record<string, string> = { niedrig: 'low', low: 'low', normal: 'normal', hoch: 'high', high: 'high', kritisch: 'critical', critical: 'critical' };
        if (!map[lv]) return { type: c.type, status: 'denied', text: `${code}: Priorität ${lv || '?'} unbekannt (niedrig, normal, hoch, kritisch)` };
        await db.query(`update tasks set priority = $2 where id = $1`, [task.id, map[lv]]);
        await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'chat')`, [task.id, sender.id, `Priorität → ${map[lv]} (per Chat)`]);
        await audit(db, { orgId: sender.orgId, projectId: project.id, userId: sender.id, action: 'task.update', objectType: 'task', objectId: task.id, details: { priority: map[lv], via: 'chat' } });
        return { type: c.type, status: 'ok', text: `${code}: Priorität ${map[lv]}`, link: lnk, taskId: task.id };
      }
      const paused = c.type !== 'resume';
      await db.query(`update tasks set agent_paused = $2 where id = $1`, [task.id, paused]);
      await audit(db, { orgId: sender.orgId, projectId: project.id, userId: sender.id, action: 'agent.pause', objectType: 'task', objectId: task.id, details: { paused, via: 'chat', stop: c.type === 'stop' } });
      if (c.type === 'stop') {
        const reason = cut(c.reason ?? c.text, 300) || 'per Chat gestoppt';
        await cancelQuestions(db, { taskId: task.id, askedBy: agent.id }, `gestoppt: ${reason}`, sender.id);
        await db.query(`update ai_proposals set status = 'withdrawn', result = $2 where task_id = $1 and status = 'pending' and kind = 'agent_action'`, [task.id, `gestoppt: ${reason}`]);
        await db.query(`update tasks set agent_wait = null, agent_next_check_at = null where id = $1`, [task.id]);
        await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'chat')`, [task.id, sender.id, `Agent gestoppt: ${reason}`]);
        return { type: c.type, status: 'ok', text: `${code}: Agent gestoppt (${reason}); offene Fragen und Vorschläge zurückgezogen`, link: lnk, taskId: task.id };
      }
      await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'chat')`, [task.id, sender.id, paused ? 'Agent pausiert (per Chat)' : 'Agent fortgesetzt (per Chat)']);
      if (!paused) queueAgentRun(task.id, 'manual');
      return { type: c.type, status: 'ok', text: `${code}: Agent ${paused ? 'pausiert' : 'fortgesetzt'}`, link: lnk, taskId: task.id };
    }
    case 'approve': case 'reject': {
      // Der Agent führt nichts aus: die Karte mit den offenen Vorschlägen erscheint, entschieden wird per Klick
      const q = await db.maybeOne(`select id from questions where task_id = $1 and kind = 'approval' and status = 'open' order by created_at desc limit 1`, [task.id]);
      if (q) return { type: c.type, status: 'held', text: `${code}: offene Bestätigung – bitte auf der Karte entscheiden`, link: lnk, taskId: task.id, questionId: q.id };
      if (c.type === 'approve') {
        if (!a.orders && role !== 'pl') return { type: c.type, status: 'denied', text: `${code}: nichts angehalten; einen Lauf starten dürfen Berechtigte für Aufträge` };
        if (task.agent_paused) return { type: c.type, status: 'denied', text: `${code}: Agent ist pausiert (resume)` };
        queueAgentRun(task.id, 'order');
        return { type: c.type, status: 'ok', text: `${code}: nichts angehalten; Lauf gestartet`, link: lnk, taskId: task.id };
      }
      return { type: c.type, status: 'denied', text: `${code}: nichts zum Ablehnen offen` };
    }
    case 'policy': {
      if (!a.policy) return { type: c.type, status: 'denied', text: `${code}: die Selbstständigkeit setzt nur die PL` };
      const mode = String(c.mode ?? '').trim().toLowerCase().replace(/^selbstständig$/, 'auto').replace(/^(rückfrage bei wichtigen schritten|wichtig)$/, 'confirm_critical').replace(/^(rückfrage bei allem|alles)$/, 'confirm_all');
      const depth = String(c.depth ?? '').trim().toLowerCase().replace(/^schnell$/, 'quick').replace(/^(gründlich|tief)$/, 'deep').replace(/^(normal|standard)$/, 'standard');
      if (!mode && !depth) return { type: c.type, status: 'denied', text: `${code}: policy ohne mode oder depth` };
      let v: any;
      try { v = parseAgentPolicy({ ...(mode ? { mode } : {}), ...(depth ? { depth } : {}) }, { limits: false, workflows: false }); } catch (e: any) { return { type: c.type, status: 'denied', text: `${code}: ${e.message}` }; }
      const curPol = (await db.maybeOne(`select agent_policy from tasks where id = $1`, [task.id]))?.agent_policy ?? {};
      v = { ...(curPol && typeof curPol === 'object' ? curPol : {}), ...v };
      const base = await effectiveAgentPolicy(db, { agentId: agent.id, projectId: project.id, taskId: null });
      const caps = await db.one(`select p.agent_policy->>'maxMode' as pmax, (select u.agent_policy->>'maxMode' from users u where u.id = $2) as amax from projects p where p.id = $1`, [project.id, agent.id]);
      for (const cap of [caps.pmax, caps.amax]) if (cap && v.mode && MODE_ORDER.indexOf(v.mode) < MODE_ORDER.indexOf(cap)) return { type: c.type, status: 'denied', text: `${code}: ${v.mode} unterschreitet die Grenze ${cap} (Agent/Projekt)` };
      await db.query(`update tasks set agent_policy = $2::jsonb where id = $1`, [task.id, JSON.stringify(v)]);
      await audit(db, { orgId: sender.orgId, projectId: project.id, userId: sender.id, action: 'agent.policy', objectType: 'task', objectId: task.id, details: { ...v, via: 'chat' } });
      const eff = await effectiveAgentPolicy(db, { agentId: agent.id, projectId: project.id, taskId: task.id });
      const what = [mode ? `Selbstständigkeit ${v.mode}` : '', depth ? `Denktiefe ${eff.depth}${eff.depth !== v.depth ? ` (${v.depth} über der Grenze)` : ''}` : ''].filter(Boolean).join(', ');
      await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'chat')`, [task.id, sender.id, `Policy für dieses AP: ${what} (per Chat; vorher ${base.mode}, ${base.depth})`]);
      return { type: c.type, status: 'ok', text: `${code}: ${what}`, link: lnk, taskId: task.id };
    }
    case 'report': {
      if (!a.note) return { type: c.type, status: 'denied', text: `${code}: Berichtswünsche setzen Mitglieder` };
      const every = String(c.every ?? 'milestones').trim().toLowerCase();
      if (!['each', 'milestones', 'daily', 'done'].includes(every)) return { type: c.type, status: 'denied', text: `${code}: every muss each, milestones, daily oder done sein` };
      await setRules(db, { id: sender.id, orgId: sender.orgId, name: sender.name, kind: 'person' } as any, 'user_task', { orgId: sender.orgId, projectId: project.id, taskId: task.id, userId: sender.id }, [{ event: 'progress', channels: { chat: 'thread', ...(c.mail ? { mail: 'now' } : {}) }, timing: { every } }]);
      return { type: c.type, status: 'ok', text: `${code}: Zwischenstände ${every}${c.mail ? ' auch per Mail' : ''} an ${sender.name}`, link: lnk, taskId: task.id };
    }
    default: return { type: c.type, status: 'denied', text: `${c.type}: unbekannt` };
  }
}

/** Auftrag ohne Recht: Frage order_request an die PL (der Auftraggeber wird genannt). */
async function orderRequest(ctx: CommandCtx, project: { id: string; key: string }, text: string, parentTask: any | null): Promise<CommandResult> {
  const { db, agent, sender, now } = ctx;
  // Frage braucht ein AP: das genannte Über-AP, sonst das jüngste eigene AP des Agenten im Projekt
  const anchor = parentTask ?? (await db.maybeOne(`select t.* from tasks t where t.project_id = $1 and t.responsible_user_id = $2 and t.deleted_at is null and t.archived_at is null order by t.updated_at desc nulls last limit 1`, [project.id, agent.id]));
  if (!anchor) return { type: 'refer', status: 'denied', text: `${project.key}: kein Arbeitspaket, an dem die Anfrage hängen kann; bitte an die Projektleitung wenden` };
  const r = await askQuestion(db, { taskId: anchor.id, asker: agent, kind: 'order_request', to: 'pl', body: `${sender.name} möchte beauftragen: ${text}`, now, type: 'order_request', title: `${agent.name}: Auftragsvorschlag von ${sender.name}`, context: { topic: 'order_request', senderId: sender.id, text } });
  if ('error' in r) return { type: 'refer', status: 'denied', text: r.error };
  return { type: 'refer', status: 'held', text: `Vorschlag an die Projektleitung weitergegeben (${project.key}-${anchor.number})`, questionId: r.question.id, link: link(project.id, anchor.id) };
}

/** Auftrag aus dem Chat (7.4): Projekt bestimmen, Rechte des Auftraggebers, Dubletten, Anlage, Kette, Lauf mit Anlass order, Karte mit Rückgängig. */
async function createOrder(ctx: CommandCtx, c: ChatCommand): Promise<CommandResult> {
  const { db, agent, sender, now } = ctx;
  const title = cut(cleanTitle(c.title), 200);
  if (!title) return { type: 'order', status: 'denied', text: 'Auftrag ohne Titel' };
  // Projekt: Kanalprojekt, Projekt des genannten Über-AP, sonst einziges gemeinsames
  let project = ctx.project;
  // Zielprojekt per Kürzel oder Name (nur gemeinsame Projekte); sonst Thema bzw. persönliches Projekt
  const named = String(c.project ?? '').trim().toLowerCase();
  if (named) {
    const hit = [ctx.project, ...ctx.projects].find((p) => p && (p.key.toLowerCase() === named || p.name.toLowerCase() === named));
    if (!hit) return { type: 'order', status: 'denied', text: `Projekt „${c.project}“: dort bin ich nicht Mitglied oder du hast dort keinen Zugriff auf KI` };
    project = hit;
  }
  let parent: any = null;
  let parentNote = '';
  if (c.parent) {
    const t = await targetTask(ctx, { type: 'order', ref: c.parent });
    // Unbekanntes Über-AP in einem gemeinsamen Projekt (Modell hat eine Kennung geraten): eigenes AP in diesem Projekt statt nichts
    const guessed = 'error' in t && /nicht gefunden$/.test(t.error) ? projectOf(ctx, String(c.parent).trim()) : null;
    if ('error' in t && !guessed) return { type: 'order', status: 'denied', text: `Über-AP ${c.parent}: ${t.error}` };
    if ('error' in t) { project = guessed; parentNote = ` (Über-AP ${c.parent} gibt es nicht: als eigenes Arbeitspaket)`; }
    else { parent = t.task; project = t.project; }
    if (parent?.parent_id) return { type: 'order', status: 'denied', text: `${c.parent} ist eine Aufgabe; Aufgaben haben keine eigenen Aufgaben` };
  }
  if (!project) return { type: 'order', status: 'denied', text: ctx.projects.length > 1 ? `Projekt nicht eindeutig (${ctx.projects.map((p) => p.key).join(', ')}); bitte das Projekt nennen` : 'kein gemeinsames Projekt' };
  const d = await aiAllowed(db, { userId: agent.id, projectId: project.id, feature: 'agent.order', budget: false });
  if (!d.allowed) return { type: 'order', status: 'denied', text: `Aufträge per Chat gesperrt: ${d.publicReason}` };
  const ds = await aiAllowed(db, { userId: sender.id, projectId: project.id, feature: 'agent.order' });
  if (!ds.allowed) return { type: 'order', status: 'denied', text: `Aufträge per Chat für ${sender.name} gesperrt: ${ds.publicReason}` };
  const m = await getMembership(db, project.id, sender.id);
  if (!m || m.role === 'reader') return { type: 'order', status: 'denied', text: `${project.key}: nur Mitglieder geben Aufträge` };
  const role = await senderRole(db, sender.id, project.id, parent);
  const policy = await effectiveAgentPolicy(db, { agentId: agent.id, projectId: project.id });
  // Teilprojekt: nur ein vorhandenes; Projektkürzel oder -name (vom Modell oft dort eingesetzt) heißt „kein Teilprojekt“, ein unbekanntes Name legt im Projekt an
  const spName = String(c.subproject ?? '').trim();
  const spIsProject = spName && [project.key, project.name].some((x) => x.toLowerCase() === spName.toLowerCase());
  const subproject = spName && !spIsProject ? await db.maybeOne(`select id, name, responsible_user_id from subprojects where project_id = $1 and lower(name) = lower($2)`, [project.id, spName]) : null;
  if (spName && !spIsProject && !subproject) parentNote += ` (Teilprojekt „${spName}“ gibt es nicht: ohne Teilprojekt)`;
  const effRole: SenderRole = role === 'member' && subproject?.responsible_user_id === sender.id ? 'tp' : role;
  const a = allowedCommands(effRole, policy);
  // Zuständige dürfen nur Aufgaben unter dem eigenen AP beauftragen
  const text = cut(c.text, 5000);
  if (!a.orders || (effRole === 'responsible' && !parent)) return orderRequest(ctx, project, `${title}${text ? ` – ${text}` : ''}`, parent);
  const subprojectId = parent ? parent.subproject_id : subproject?.id ?? null;
  if (!(await canSeeSubproject(db, sender.id, subprojectId)) || !(await canSeeSubproject(db, agent.id, subprojectId))) return { type: 'order', status: 'denied', text: 'Teilprojekt ist eingeschränkt sichtbar' };
  // Dubletten: gleicher Titel unter demselben Über-AP (offen) → nachfragen statt anlegen
  const dup = await db.maybeOne(`select t.number from tasks t join board_columns c on c.id = t.column_id where t.project_id = $1 and t.deleted_at is null and t.archived_at is null and not c.is_done and lower(t.title) = lower($2) and t.parent_id is not distinct from $3::uuid`, [project.id, title, parent?.id ?? null]);
  if (dup) return { type: 'order', status: 'denied', text: `„${title}“ gibt es schon offen als ${project.key}-${dup.number} – dort weiter?`, link: null };
  // Unlesbarer Termin hält den Auftrag nicht auf: ohne Termin anlegen, Hinweis auf der Karte
  const due0 = ymd(c.dueDate);
  const due = due0 === undefined ? null : due0;
  if (due0 === undefined) parentNote += ` (Termin „${c.dueDate}“ nicht lesbar: ohne Termin)`;
  const actor: PlanActor = { id: sender.id, name: sender.name, orgId: sender.orgId, role: m.role, label: `${sender.name} (per Chat)`, isAgent: false };
  const t = await createPlannedTask(db, actor, { projectId: project.id, projectKey: project.key, title, description: text || null, parentId: parent?.id ?? null, subprojectId, dueDate: due, items: Array.isArray(c.deliverables) ? c.deliverables : [] });
  // Auftraggeber, Ursprungsnachricht, Zuständigkeit des Agenten (Ausnahme zu „Agenten weist nur die PL zu“ nur auf diesem Weg)
  await db.query(`update tasks set requested_by = $2, origin_message_id = $3, responsible_user_id = $4 where id = $1`, [t.id, sender.id, ctx.messageId, agent.id]);
  await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'system')`, [t.id, sender.id, `Zuständig: ${agent.name} (Auftrag von ${sender.name} per Chat)`]);
  await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'chat')`, [t.id, sender.id, `Auftrag von ${sender.name} per Chat: ${cut(text || title, 1500)}`]);
  await audit(db, { orgId: sender.orgId, projectId: project.id, userId: sender.id, action: 'task.order', objectType: 'task', objectId: t.id, details: { title, parent: parent ? `${project.key}-${parent.number}` : null, agentId: agent.id, messageId: ctx.messageId } });
  // Berichtswunsch und Lieferung per Mail: Regel auf Benutzer-AP-Ebene (Ereignis progress)
  // Persönlicher Assistent: Auftrag des Eigentümers im persönlichen Projekt meldet jeden Schritt im Chat
  const ownErrand = Boolean(await db.maybeOne(`select 1 from projects p where p.id = $1 and ${SQL.isPersonal('p')} and p.created_by = $2`, [project.id, sender.id]));
  if (c.every || c.mail || ownErrand) {
    const every = ['each', 'milestones', 'daily', 'done'].includes(String(c.every ?? '').toLowerCase()) ? String(c.every).toLowerCase() : ownErrand ? 'each' : 'milestones';
    await setRules(db, { id: sender.id, orgId: sender.orgId, name: sender.name, kind: 'person' } as any, 'user_task', { orgId: sender.orgId, projectId: project.id, taskId: t.id, userId: sender.id }, [{ event: 'progress', channels: { chat: 'thread', ...(c.mail ? { mail: 'now' } : {}) }, timing: { every } }]).catch(() => undefined);
  }
  queueAgentRun(t.id, 'order', agent.id);
  const code = `${project.key}-${t.number}`;
  return { type: 'order', status: 'ok', text: `Angelegt: ${code} „${title}“${parent ? ` unter ${project.key}-${parent.number}` : subproject ? ` im Teilprojekt „${subproject.name}“` : ''} · zuständig ${agent.name} · Auftraggeber ${sender.name}${parentNote}`, link: link(project.id, t.id), taskId: t.id, undoUntil: new Date(now.getTime() + 10 * 60_000).toISOString() };
}

/** Systemkarte mit den Ergebnissen; Freigabekarten hängen an der Frage. */
export async function postResults(ctx: CommandCtx, results: CommandResult[], agentRunId: string | null): Promise<string | null> {
  if (!results.length) return null;
  // Karte nur, wenn sie etwas zu entscheiden oder zu erklären hat (abgelehnt, angehalten, Auftrag mit Rückgängig, Bestätigung); Bestätigungen von Kleinigkeiten (Notiz, Priorität …) nur mit Einstellung chatCards = all
  const needed = results.some((r) => r.status !== 'ok' || r.questionId || (r.type === 'order' && r.undoUntil));
  if (!needed) {
    const u = await ctx.db.maybeOne(`select settings from users where id = $1`, [ctx.sender.id]);
    const settings = typeof u?.settings === 'string' ? JSON.parse(u.settings) : u?.settings ?? {};
    if (settings.chatCards !== 'all') return null;
  }
  const mark = (r: CommandResult) => (r.status === 'ok' ? '✓' : r.status === 'held' ? '◔' : '✗');
  const body = results.map((r) => `${mark(r)} ${r.status === 'denied' ? 'Nicht ausgeführt: ' : ''}${r.text}`).join('\n');
  const order = results.find((r) => r.type === 'order' && r.status === 'ok');
  const approval = results.find((r) => r.questionId && (r.type === 'approve' || r.type === 'reject'));
  const id = await systemMessage(ctx.db, { channelId: ctx.channelId, threadId: ctx.threadId, body, meta: { card: 'results', results, link: order?.link ?? results.find((r) => r.link)?.link ?? null, taskId: order?.taskId ?? null, undoUntil: order?.undoUntil ?? null, approvalQuestionId: approval?.questionId ?? null } });
  if (agentRunId) await ctx.db.query(`update chat_messages set agent_run_id = $2 where id = $1`, [id, agentRunId]);
  return id;
}

/** Rückgängig (10 Minuten): der Auftraggeber oder die PL archiviert das eben angelegte AP mit Log-Eintrag. */
export async function undoOrder(db: Db, user: { id: string; name: string; orgId: string }, taskId: string, now = new Date()): Promise<{ ok: true }> {
  const t = await db.maybeOne(`select t.*, p.key from tasks t join projects p on p.id = t.project_id where t.id = $1 and t.deleted_at is null and t.archived_at is null`, [taskId]);
  if (!t) throw new Error('Arbeitspaket nicht gefunden');
  if (!t.requested_by || !t.origin_message_id) throw new Error('Kein Auftrag aus dem Chat');
  const m = await getMembership(db, t.project_id, user.id);
  if (!(t.requested_by === user.id || m?.role === 'pl')) throw new Error('Rückgängig darf der Auftraggeber oder die PL');
  if (now.getTime() - new Date(t.created_at).getTime() > 10 * 60_000) throw new Error('Rückgängig nur innerhalb von 10 Minuten; danach archivieren');
  await db.query(`update tasks set archived_at = now(), agent_wait = null, agent_next_check_at = null where id = $1 or (parent_id = $1 and archived_at is null)`, [t.id]);
  await cancelQuestions(db, { taskId: t.id }, 'Auftrag zurückgenommen', user.id);
  await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'chat')`, [t.id, user.id, `Auftrag zurückgenommen (Rückgängig im Chat) von ${user.name}`]);
  await audit(db, { orgId: user.orgId, projectId: t.project_id, userId: user.id, action: 'task.order_undo', objectType: 'task', objectId: t.id, details: {} });
  if (t.requested_by !== user.id) await notify(db, { userId: t.requested_by, projectId: t.project_id, taskId: t.id, type: 'task.archived', title: `Auftrag ${t.key}-${t.number} zurückgenommen`, body: `von ${user.name}`, link: `/projekte/${t.project_id}/board?task=${t.id}`, actorId: user.id });
  return { ok: true };
}
