import type { Db } from '../db.js';
import type { MailService } from '../mail/service.js';
import type { AccountRow } from '../mail/types.js';
import { audit } from '../audit.js';
import { notify } from '../notify.js';
import { touchTask } from '../tasks/service.js';
import { aiConfigForAgent, complete, orgAiSettings, parseJson, type AiConfig } from './client.js';

/**
 * KI-Agent als Benutzer: handelt nur bei Arbeitspaketen, die ihm eine PL direkt zugewiesen hat, im Rahmen seiner
 * Mitgliedschaft (Mitglied mit Stellvertretung). Je Lauf bekommt das Modell den Kontext (Arbeitspaket, Log, Tasks,
 * Mails, Projekt) und liefert Aktionen als JSON: Log-Eintrag, Status, Task abhaken, Mail (direkt oder als Entwurf
 * zur Freigabe, je nach „darf Mails senden“), Blockade melden, Eskalation an die PL. Jeder Lauf wird mit Begründung,
 * Aktionen und Token gespeichert und steht im Audit; die PL kann den Agenten je Arbeitspaket pausieren.
 */
export type AgentAction =
  | { type: 'comment'; text: string }
  | { type: 'set_status'; column: string }
  | { type: 'check_item'; itemId: string }
  | { type: 'mail'; to: string[]; subject: string; text: string }
  | { type: 'blocked'; reason: string }
  | { type: 'escalate'; text: string }
  | { type: 'wait'; kind: 'reply' | 'date' | 'task' | 'info'; reason: string; checkAfterHours?: number; until?: string; remindAfterHours?: number; escalateAfterHours?: number }
  | { type: 'none'; reason?: string };

export interface AgentWait { kind: 'reply' | 'date' | 'task' | 'info'; reason: string; since: string; remindAt?: string | null; escalateAt?: string | null; reminded?: boolean; escalated?: boolean }
const H = 3600_000;
const clampH = (v: unknown, def: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(24 * 14, Math.max(0.5, n)) : def; };

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['note', 'actions'],
  properties: {
    note: { type: 'string', description: 'Kurze Notiz für das Protokoll: was veranlasst wurde und warum' },
    actions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['type'], properties: {
      type: { type: 'string', enum: ['comment', 'set_status', 'check_item', 'mail', 'blocked', 'escalate', 'wait', 'none'] },
      text: { type: 'string' }, column: { type: 'string' }, itemId: { type: 'string' }, to: { type: 'array', items: { type: 'string' } }, subject: { type: 'string' }, reason: { type: 'string' },
      kind: { type: 'string', enum: ['reply', 'date', 'task', 'info'] }, checkAfterHours: { type: 'number' }, until: { type: 'string' }, remindAfterHours: { type: 'number' }, escalateAfterHours: { type: 'number' }
    } } }
  }
};

const cut = (s: string | null | undefined, n: number) => { const t = (s ?? '').trim(); return t.length > n ? t.slice(0, n) + ' …' : t; };

export interface AgentRunResult { runId: string | null; taskId: string; status: 'ok' | 'error' | 'skipped'; actions: AgentAction[]; error?: string }

/** Ein Lauf für ein Arbeitspaket. trigger beschreibt den Anlass (assigned, mail, comment, due, daily, manual). */
export async function runAgentOnTask(db: Db, mail: MailService, fetchFn: typeof fetch, agent: { id: string; name: string; org_id: string }, taskId: string, trigger: string, cfg?: AiConfig | null, now = new Date()): Promise<AgentRunResult> {
  const task = await db.maybeOne(`select t.*, c.name as column_name, p.key as project_key, p.name as project_name, s.name as subproject_name from tasks t join board_columns c on c.id = t.column_id join projects p on p.id = t.project_id left join subprojects s on s.id = t.subproject_id where t.id = $1 and t.deleted_at is null`, [taskId]);
  if (!task) return { runId: null, taskId, status: 'skipped', actions: [], error: 'Arbeitspaket nicht gefunden' };
  const m = await db.maybeOne(`select * from project_members where project_id = $1 and user_id = $2`, [task.project_id, agent.id]);
  if (!m) return { runId: null, taskId, status: 'skipped', actions: [], error: 'Agent ist kein Mitglied' };
  const c = cfg ?? (await aiConfigForAgent(db, agent.id));
  if (!c) return { runId: null, taskId, status: 'skipped', actions: [], error: 'Dem Agenten ist kein aktives KI-Profil zugewiesen (Verwaltung › KI-Agenten)' };
  const columns = await db.query(`select name, is_done from board_columns where project_id = $1 order by position`, [task.project_id]);
  const items = await db.query(`select id, title, done, responsible_email from checklist_items where task_id = $1 order by position`, [task.id]);
  const comments = await db.query(`select c.body, c.source, c.created_at, u.name from task_comments c left join users u on u.id = c.user_id where c.task_id = $1 order by c.created_at desc limit 12`, [task.id]);
  const mails = await db.query(`select m.subject, m.from_addr, m.date, m.snippet, m.text_body, m.outgoing from mail_task_links l join mails m on m.id = l.mail_id where l.task_id = $1 order by m.date desc limit 6`, [task.id]);
  const members = await db.query(`select u.name, u.email, m.role, m.is_deputy, u.kind from project_members m join users u on u.id = m.user_id where m.project_id = $1`, [task.project_id]);
  const pls = members.rows.filter((x: any) => x.role === 'pl' && !x.is_deputy);
  const today = now.toISOString().slice(0, 10);
  const account = await db.maybeOne<AccountRow>(`select * from mail_accounts where project_id = $1 and type = 'project' order by created_at limit 1`, [task.project_id]);
  const canMail = Boolean(m.agent_can_mail) && Boolean(account);
  const system = `Du bist „${agent.name}“, ein KI-Agent im Projekttool und Mitglied des Projekts ${task.project_key} „${task.project_name}“. Dir ist ein Arbeitspaket zugewiesen; du treibst es im Rahmen deiner Rechte voran wie eine zuständige Person: nachfragen, Stand festhalten, Tasks abhaken, Status setzen, Blockaden melden, an die Projektleitung eskalieren. Du erfindest keine Fakten, versprichst nichts im Namen anderer und änderst keine Termine. Antworte ausschließlich mit JSON nach dem vorgegebenen Schema: note = kurze Protokollnotiz (ein bis zwei Sätze, was du veranlasst hast und warum), actions = Liste der Aktionen. Wenn du auf etwas wartest, setze immer eine Aktion wait: kind reply (Rückmeldung einer Person), date (Termin, dann until als Datum), task (Erledigung durch andere) oder info; checkAfterHours = wann du das Arbeitspaket wieder prüfst. Bei kind reply zusätzlich remindAfterHours (wann du nachfasst, z. B. 48) und escalateAfterHours (wann du an die Projektleitung eskalierst, z. B. 120). Wenn nichts zu tun ist und nichts erwartet wird, gib none mit kurzem reason. Jede Nachricht nach außen ist sachlich, kurz, auf Deutsch, mit Anrede und Unterschrift „${agent.name} (KI-Agent, Projekt ${task.project_key})“.`;
  const prompt = `Heute: ${today}
Arbeitspaket ${task.project_key}-${task.number} „${task.title}“ · Status ${task.column_name}${task.due_date ? ` · fällig ${String(task.due_date).slice(0, 10)}` : ''}${task.subproject_name ? ` · Teilprojekt ${task.subproject_name}` : ''}${task.blocked ? ` · BLOCKIERT: ${task.blocked_reason ?? ''}` : ''}
Beschreibung: ${cut(task.description, 2000) || '–'}
Mögliche Status: ${columns.rows.map((x: any) => x.name + (x.is_done ? ' (erledigt)' : '')).join(', ')}
Tasks:
${items.rows.map((i: any) => `- [${i.done ? 'x' : ' '}] ${i.title} (itemId ${i.id})${i.responsible_email ? ` · extern ${i.responsible_email}` : ''}`).join('\n') || '–'}
Log (neueste zuerst):
${comments.rows.map((x: any) => `- ${new Date(x.created_at).toLocaleDateString('de-DE')} ${x.name ?? 'System'}${x.source === 'ai' ? ' (KI)' : ''}: ${cut(x.body, 400)}`).join('\n') || '–'}
Mails zum Arbeitspaket:
${mails.rows.map((x: any) => `- ${new Date(x.date).toLocaleDateString('de-DE')} ${x.outgoing ? 'AN' : 'VON'} ${x.from_addr}: ${x.subject} – ${cut(x.text_body ?? x.snippet, 500)}`).join('\n') || '–'}
Projektmitglieder: ${members.rows.map((x: any) => `${x.name} <${x.email}>${x.role === 'pl' ? (x.is_deputy ? ' (PL-Stellvertretung)' : ' (PL)') : ''}${x.kind === 'agent' ? ' (Agent)' : ''}`).join(', ')}
Deine Rechte: Mails ${canMail ? 'direkt senden' : 'nur als Entwurf zur Freigabe'}${account ? '' : ' (kein Projektkonto)'}; Status setzen; Tasks abhaken; Log schreiben; Blockade melden; an PL eskalieren.
${waitText(task, now)}Anlass dieses Laufs: ${triggerText(trigger, task)}

Entscheide, was jetzt sinnvoll ist. Keine Wiederholung bereits erledigter oder bereits gefragter Dinge (siehe Log und Mails). Höchstens eine Mail je Lauf.`;
  try {
    const r = await complete(c, fetchFn, { system, prompt, maxTokens: 1500, schema: SCHEMA });
    const j = parseJson(r.text);
    const actions: AgentAction[] = Array.isArray(j.actions) ? j.actions.slice(0, 5) : [];
    const applied: AgentAction[] = [];
    let mailed = false;
    let waited = false;
    for (const a of actions) {
      if (a.type === 'comment' && a.text?.trim()) {
        await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [task.id, agent.id, a.text.trim()]);
        applied.push(a);
      } else if (a.type === 'set_status' && a.column) {
        const col = await db.maybeOne(`select id, name from board_columns where project_id = $1 and lower(name) = lower($2)`, [task.project_id, a.column]);
        if (col && col.id !== task.column_id) { await db.query(`update tasks set column_id = $2 where id = $1`, [task.id, col.id]); await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [task.id, agent.id, `Status → ${col.name}`]); applied.push({ type: 'set_status', column: col.name }); }
      } else if (a.type === 'check_item' && a.itemId) {
        const it = items.rows.find((i: any) => i.id === a.itemId && !i.done);
        if (it) { await db.query(`update checklist_items set done = true where id = $1`, [it.id]); await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [task.id, agent.id, `Task erledigt: ${it.title}`]); applied.push(a); }
      } else if (a.type === 'mail' && !mailed && Array.isArray(a.to) && a.to.length && a.subject && a.text) {
        const to = a.to.map((x) => String(x).trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)).slice(0, 5);
        if (to.length && account) {
          mailed = true;
          if (canMail) {
            await mail.sendFromAccount(account, { to, subject: a.subject, text: a.text, taskId: task.id, userId: agent.id, projectId: task.project_id });
            applied.push({ type: 'mail', to, subject: a.subject, text: a.text });
          } else {
            await db.query(`insert into mail_drafts (account_id, task_id, project_id, user_id, to_addrs, cc_addrs, subject, body, status) values ($1,$2,$3,$4,$5,'[]',$6,$7,'pending_approval')`, [account.id, task.id, task.project_id, agent.id, JSON.stringify(to), a.subject, a.text]);
            for (const pl of pls) await notify(db, { userId: pl.user_id ?? (await db.one(`select id from users where email = $1`, [pl.email])).id, projectId: task.project_id, type: 'draft.review', title: `Mail-Entwurf von ${agent.name} zur Freigabe`, body: a.subject, link: `/projekte/${task.project_id}/mail/freigabe` });
            applied.push({ type: 'mail', to, subject: a.subject, text: `[Entwurf zur Freigabe] ${a.text}` });
          }
        }
      } else if (a.type === 'blocked' && a.reason) {
        await db.query(`update tasks set blocked = true, blocked_reason = $2 where id = $1`, [task.id, a.reason]);
        await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [task.id, agent.id, `Blockiert gemeldet: ${a.reason}`]);
        for (const pl of pls) await notify(db, { userId: (await db.one(`select id from users where email = $1`, [pl.email])).id, projectId: task.project_id, type: 'escalation', title: `Blockiert (Agent): ${task.title}`, body: a.reason, link: `/projekte/${task.project_id}/board?task=${task.id}` });
        applied.push(a);
      } else if (a.type === 'escalate' && a.text) {
        await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [task.id, agent.id, `An die Projektleitung: ${a.text}`]);
        for (const pl of pls) await notify(db, { userId: (await db.one(`select id from users where email = $1`, [pl.email])).id, projectId: task.project_id, type: 'escalation', title: `${agent.name} braucht eine Entscheidung: ${task.title}`, body: a.text, link: `/projekte/${task.project_id}/board?task=${task.id}` });
        applied.push(a);
      } else if (a.type === 'wait' && a.kind) {
        const prev: AgentWait | null = task.agent_wait ?? null;
        const keepSince = prev && prev.kind === a.kind && trigger !== 'reply' && trigger !== 'comment' && trigger !== 'mail' ? prev.since : now.toISOString();
        const check = a.kind === 'date' && a.until && !isNaN(new Date(a.until).getTime()) ? new Date(a.until) : new Date(now.getTime() + clampH(a.checkAfterHours, a.kind === 'reply' ? 24 : 24) * H);
        const w: AgentWait = { kind: a.kind, reason: String(a.reason ?? '').slice(0, 300), since: keepSince };
        if (a.kind === 'reply') {
          const base = new Date(keepSince).getTime();
          w.remindAt = prev?.kind === 'reply' && prev.reminded ? prev.remindAt : new Date(base + clampH(a.remindAfterHours, 48) * H).toISOString();
          w.escalateAt = new Date(base + clampH(a.escalateAfterHours, 120) * H).toISOString();
          w.reminded = prev?.kind === 'reply' ? Boolean(prev.reminded) : false;
          w.escalated = prev?.kind === 'reply' ? Boolean(prev.escalated) : false;
        }
        const nextCheck = a.kind === 'reply' ? new Date(Math.min(check.getTime(), ...[w.remindAt, w.escalateAt].filter((x): x is string => Boolean(x)).map((x) => new Date(x).getTime()).filter((x) => x > now.getTime()))) : check;
        await db.query(`update tasks set agent_wait = $2, agent_next_check_at = $3 where id = $1`, [task.id, JSON.stringify(w), nextCheck]);
        applied.push({ ...a, reason: w.reason });
        waited = true;
      } else if (a.type === 'none') applied.push(a);
    }
    if (!waited) await db.query(`update tasks set agent_wait = null, agent_next_check_at = null where id = $1`, [task.id]);
    if (applied.some((x) => x.type !== 'none')) await touchTask(db, task.id);
    const run = await db.one(`insert into agent_runs (org_id, agent_user_id, project_id, task_id, trigger, status, reasoning, actions, fingerprint, input_tokens, output_tokens) values ($1,$2,$3,$4,$5,'ok',$6,$7,$8,$9,$10) returning id`,
      [agent.org_id, agent.id, task.project_id, task.id, trigger, cut(String(j.note ?? j.reasoning ?? ''), 2000), JSON.stringify(applied), await fingerprintOf(db, task.id), r.inputTokens, r.outputTokens]);
    await audit(db, { orgId: agent.org_id, projectId: task.project_id, userId: agent.id, action: 'agent.run', objectType: 'task', objectId: task.id, details: { runId: run.id, trigger, actions: applied.map((x) => x.type), profile: c.name, model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens } });
    return { runId: run.id, taskId: task.id, status: 'ok', actions: applied };
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 300);
    const er = await db.one(`insert into agent_runs (org_id, agent_user_id, project_id, task_id, trigger, status, error, fingerprint) values ($1,$2,$3,$4,$5,'error',$6,$7) returning id`, [agent.org_id, agent.id, task.project_id, task.id, trigger, msg, await fingerprintOf(db, task.id)]);
    await audit(db, { orgId: agent.org_id, projectId: task.project_id, userId: agent.id, action: 'agent.run_failed', objectType: 'task', objectId: task.id, details: { runId: er.id, trigger, error: msg } });
    return { runId: er.id, taskId: task.id, status: 'error', actions: [], error: msg };
  }
}

const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }) : '–');
const KIND_DE: Record<string, string> = { reply: 'Rückmeldung', date: 'Termin', task: 'Erledigung durch andere', info: 'Information' };
function waitText(task: any, now: Date): string {
  const w: AgentWait | null = task.agent_wait ?? null;
  if (!w) return '';
  const hours = Math.round((now.getTime() - new Date(w.since).getTime()) / H);
  return `Du wartest seit ${fmt(w.since)} (${hours} h) auf ${KIND_DE[w.kind] ?? w.kind}: ${w.reason}${w.remindAt ? ` · Nachfassen geplant ${fmt(w.remindAt)}${w.reminded ? ' (erledigt)' : ''}` : ''}${w.escalateAt ? ` · Eskalation geplant ${fmt(w.escalateAt)}${w.escalated ? ' (erledigt)' : ''}` : ''}\n`;
}
function triggerText(trigger: string, task: any): string {
  const w: AgentWait | null = task.agent_wait ?? null;
  switch (trigger) {
    case 'assigned': return 'Das Arbeitspaket wurde dir gerade zugewiesen. Verschaffe dir den Stand und beginne.';
    case 'comment': return 'Neuer Log-Eintrag oder Kommentar einer Person am Arbeitspaket.';
    case 'mail': case 'reply': return 'Neue Mail zum Arbeitspaket (möglicherweise die erwartete Rückmeldung). Werte sie aus.';
    case 'check': return `Wiedervorlage: deine Wartefrist ist abgelaufen${w ? ` (gewartet auf ${KIND_DE[w.kind] ?? w.kind})` : ''}. Prüfe, ob das Erwartete eingetreten ist.`;
    case 'reminder_due': return 'Nachfassen fällig: die Rückmeldung ist bisher nicht eingegangen. Fasse jetzt nach (Erinnerung per Mail oder Log) oder begründe, warum nicht; setze danach erneut wait.';
    case 'escalation_due': return 'Eskalation fällig: trotz Nachfassen keine Rückmeldung. Eskaliere jetzt an die Projektleitung (escalate) oder begründe, warum du weiter wartest.';
    case 'due_soon': return 'Die Fälligkeit des Arbeitspakets ist nah.';
    case 'overdue': return 'Das Arbeitspaket ist überfällig.';
    case 'manual': return 'Die Projektleitung hat den Lauf manuell gestartet.';
    default: return trigger;
  }
}

/** Ereignislauf: der dem Arbeitspaket zugewiesene Agent läuft sofort (von Routen über queueAgentRun ausgelöst). */
export async function runForTask(db: Db, mail: MailService, fetchFn: typeof fetch, taskId: string, trigger: string): Promise<AgentRunResult | null> {
  const t = await db.maybeOne(`select t.responsible_user_id, t.agent_paused, c.is_done from tasks t join board_columns c on c.id = t.column_id where t.id = $1 and t.deleted_at is null and t.archived_at is null`, [taskId]);
  if (!t || t.agent_paused || t.is_done || !t.responsible_user_id) return null;
  const agent = await db.maybeOne(`select id, name, org_id from users where id = $1 and kind = 'agent' and active`, [t.responsible_user_id]);
  if (!agent) return null;
  return runAgentOnTask(db, mail, fetchFn, agent, taskId, trigger);
}

/** Kennung des Zustands: ändert sich bei neuen Log-Einträgen anderer, neuen Mails, Status- oder Terminänderung. */
export async function fingerprintOf(db: Db, taskId: string): Promise<string> {
  const r = await db.one(`select t.column_id, t.due_date, t.blocked,
      (select count(*)::int from task_comments c where c.task_id = t.id and c.source <> 'ai') as comments,
      (select count(*)::int from mail_task_links l join mails m on m.id = l.mail_id where l.task_id = t.id and not m.outgoing) as mails,
      (select count(*)::int from checklist_items i where i.task_id = t.id and i.done) as done_items
    from tasks t where t.id = $1`, [taskId]);
  return `${r.column_id}|${r.due_date ? String(r.due_date).slice(0, 10) : ''}|${r.blocked}|${r.comments}|${r.mails}|${r.done_items}`;
}

/** Worker: alle aktiven Agenten über ihre offenen, direkt zugewiesenen Arbeitspakete; Anlass aus Zustandsänderung, Fälligkeit oder Tagesrhythmus; Tagesbudget je Agent. */
export async function runAgents(db: Db, mail: MailService, fetchFn: typeof fetch, now = new Date()): Promise<AgentRunResult[]> {
  const out: AgentRunResult[] = [];
  const agents = await db.query(`select id, name, org_id from users where kind = 'agent' and active`);
  for (const agent of agents.rows as any[]) {
    const cfg = await aiConfigForAgent(db, agent.id);
    if (!cfg) continue;
    const settings = await orgAiSettings(db, agent.org_id);
    const used = await db.one(`select count(*)::int as c from agent_runs where agent_user_id = $1 and created_at >= $2::date`, [agent.id, now.toISOString().slice(0, 10)]);
    let budget = Math.max(0, settings.agentDailyBudget - used.c);
    const tasks = await db.query(
      `select t.id, t.due_date, t.agent_next_check_at, t.agent_wait from tasks t join projects p on p.id = t.project_id join board_columns c on c.id = t.column_id
       where t.responsible_user_id = $1 and t.deleted_at is null and t.archived_at is null and not c.is_done and not t.agent_paused and p.status = 'active' order by t.due_date nulls last`, [agent.id]);
    for (const t of tasks.rows as any[]) {
      if (budget <= 0) break;
      const last = await db.maybeOne(`select created_at, fingerprint from agent_runs where task_id = $1 and agent_user_id = $2 order by created_at desc limit 1`, [t.id, agent.id]);
      const fp = await fingerprintOf(db, t.id);
      const hours = last ? (now.getTime() - new Date(last.created_at).getTime()) / 3600_000 : Infinity;
      const due = t.due_date ? (new Date(String(t.due_date).slice(0, 10)).getTime() - now.getTime()) / 86400_000 : null;
      let trigger: string | null = null;
      const w: AgentWait | null = t.agent_wait ?? null;
      if (w?.kind === 'reply' && w.escalateAt && !w.escalated && now >= new Date(w.escalateAt)) {
        trigger = 'escalation_due';
        await db.query(`update tasks set agent_wait = $2 where id = $1`, [t.id, JSON.stringify({ ...w, escalated: true })]);
      } else if (w?.kind === 'reply' && w.remindAt && !w.reminded && now >= new Date(w.remindAt)) {
        trigger = 'reminder_due';
        await db.query(`update tasks set agent_wait = $2 where id = $1`, [t.id, JSON.stringify({ ...w, reminded: true })]);
      } else if (t.agent_next_check_at && now >= new Date(t.agent_next_check_at)) trigger = 'check';
      else if (!last) trigger = 'assigned';
      else if (last.fingerprint !== fp && hours >= 0.5) trigger = 'changed';
      else if (due != null && due <= 2 && hours >= 24) trigger = due < 0 ? 'overdue' : 'due_soon';
      else if (hours >= 24 * 3) trigger = 'periodic';
      if (!trigger) continue;
      if (trigger === 'check') await db.query(`update tasks set agent_next_check_at = null where id = $1`, [t.id]);
      budget--;
      out.push(await runAgentOnTask(db, mail, fetchFn, agent, t.id, trigger, cfg, now));
    }
  }
  return out;
}
