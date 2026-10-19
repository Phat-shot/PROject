import type { Db } from '../db.js';
import { audit } from '../audit.js';
import { notify } from '../notify.js';
import { visibleSubprojectSql } from '../rights.js';
import { aiConfigFor, complete, parseJson } from './client.js';
import { aiAllowed } from './policy.js';
import { queueAgentRun } from './agentEvents.js';
import { styleText } from './agent.js';
import { AGENT_SHEET, CHAT_RULES } from './sheet.js';
import { EFFECTIVE_JOINS, EFFECTIVE_RESPONSIBLE_SQL } from './plan.js';
import { isInternal } from '../outbound.js';

/**
 * KI-Agent im Chat: antwortet auf Direktnachrichten, auf @Erwähnungen im Projektkanal und in Threads, in denen er
 * schon geantwortet hat. Auskunft gibt er nur über seine eigenen Arbeitspakete und nur aus Projekten, die die
 * fragende Person sehen darf. Enthält die Nachricht etwas für eines seiner Arbeitspakete, hält er es dort im Log fest
 * (danach prüft er das Arbeitspaket wie bei einem Kommentar neu). Jeder Lauf zählt gegen das Tagesbudget.
 * KI-Freigaben (agent.chat) gelten für Absender und Agent; in Direktnachrichten ohne Projekt, danach antwortet der Agent
 * nur aus Projekten, in denen der Absender „KI nutzen“ hat oder PL ist und beide freigegeben sind. Gesperrt antwortet er
 * nur auf Direktnachrichten und Erwähnungen (nicht auf jede Folgenachricht im Thread); im Projektkanal ohne Namen und Notiz
 * persönlicher Regeln, die volle Begründung bekommt der Absender als Meldung.
 */
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['reply', 'notes'],
  properties: {
    reply: { type: 'string', description: 'Antwort im Chat: kurz, im vorgegebenen Schreibstil, ohne Unterschrift' },
    notes: {
      type: 'array', description: 'Log-Einträge an deinen Arbeitspaketen (taskId aus der Liste), wenn die Nachricht eine Information dazu enthält; sonst leer',
      items: { type: 'object', additionalProperties: false, required: ['taskId', 'text'], properties: { taskId: { type: 'string' }, text: { type: 'string' } } }
    }
  }
};

const cut = (s: string | null | undefined, n: number) => { const t = (s ?? '').trim(); return t.length > n ? t.slice(0, n) + ' …' : t; };
const hhmm = (d: string | Date) => new Date(d).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });

export interface AgentChatResult { status: 'ok' | 'error' | 'skipped'; reply?: string; notes?: { taskId: string; text: string }[]; error?: string }

export async function runAgentChat(db: Db, fetchFn: typeof fetch, agentId: string, channelId: string, messageId: string, now = new Date()): Promise<AgentChatResult> {
  const agent = await db.maybeOne(`select id, name, org_id, persona from users where id = $1 and kind = 'agent' and active`, [agentId]);
  if (!agent) return { status: 'skipped', error: 'Agent nicht aktiv' };
  const channel = await db.maybeOne(`select * from chat_channels where id = $1 and org_id = $2`, [channelId, agent.org_id]);
  const msg = await db.maybeOne(`select m.*, u.name as user_name from chat_messages m join users u on u.id = m.user_id where m.id = $1 and m.channel_id = $2 and m.kind = 'user' and m.deleted_at is null`, [messageId, channelId]);
  if (!channel || !msg || msg.user_id === agent.id) return { status: 'skipped' };
  let project: any = null;
  if (channel.kind === 'project') {
    project = await db.maybeOne(`select p.id, p.key, p.name from projects p join project_members m on m.project_id = p.id and m.user_id = $2 where p.id = $1`, [channel.project_id, agent.id]);
    if (!project) return { status: 'skipped', error: 'Agent ist kein Mitglied des Projekts' };
  } else if (!(await db.maybeOne(`select 1 from chat_channel_members where channel_id = $1 and user_id = $2`, [channel.id, agent.id]))) return { status: 'skipped' };
  // Im Projektkanal antwortet der Agent im Thread der Nachricht, in Direktnachrichten direkt
  const threadId: string | null = channel.kind === 'project' ? msg.thread_id ?? msg.id : null;

  /** Antwort im Chat; die Meldung an den Absender trägt note statt des Texts (volle Begründung, die der Kanal nicht zeigt). */
  const post = async (body: string, note = body) => {
    await db.query(`insert into chat_messages (channel_id, user_id, thread_id, body) values ($1,$2,$3,$4)`, [channel.id, agent.id, threadId, body.slice(0, 8000)]);
    await db.query(`insert into chat_channel_members (channel_id, user_id, last_read_at) values ($1,$2,now()) on conflict (channel_id, user_id) do update set last_read_at = now()`, [channel.id, agent.id]);
    const link = channel.kind === 'project' ? `/chat/${channel.id}?thread=${threadId}` : `/chat/${channel.id}`;
    await notify(db, { userId: msg.user_id, projectId: channel.project_id ?? null, type: channel.kind === 'project' ? 'chat.reply' : 'chat.dm', title: `${channel.kind === 'project' ? `Antwort im Chat ${project.key}` : 'Nachricht'} von ${agent.name}`, body: cut(note, note === body ? 160 : 400), link, ref: threadId ? { type: 'chat_thread', id: threadId } : { type: 'chat_channel', id: channel.id }, actorId: agent.id, chatted: true, dedupeKey: null });
  };

  // Gesperrt antwortet der Agent nur, wenn er gemeint ist (Direktnachricht oder Erwähnung), nicht auf jede Folgenachricht im Thread
  const mentions: string[] = typeof msg.mentions === 'string' ? JSON.parse(msg.mentions) : msg.mentions ?? [];
  const addressed = channel.kind !== 'project' || mentions.includes(agent.id);
  /**
   * Gesperrt: kein LLM-Aufruf, Begründung im Chat und als übersprungener Lauf. Lauflisten und Projektkanal sehen alle
   * Mitglieder, daher dort die Begründung ohne Namen und Notiz persönlicher Regeln (shown); full nur für den Absender.
   */
  const blocked = async (shown: string, full: string, logged: string): Promise<AgentChatResult> => {
    if (!addressed) return { status: 'skipped', error: logged };
    await post(channel.kind === 'project' ? shown : full, full);
    await db.query(`insert into agent_runs (org_id, agent_user_id, project_id, task_id, trigger, status, error, channel_id) values ($1,$2,$3,null,'chat','skipped',$4,$5)`, [agent.org_id, agent.id, channel.project_id ?? null, logged.slice(0, 500), channel.id]);
    return { status: 'skipped', error: logged };
  };
  const sender = await aiAllowed(db, { userId: msg.user_id, projectId: channel.project_id ?? null, feature: 'agent.chat' });
  if (!sender.allowed) return blocked(`Ich kann dir hier nicht antworten: ${sender.publicReason}`, `Ich kann dir hier nicht antworten: ${sender.reason}`, `Absender: ${sender.publicReason}`);
  const { cfg, decision } = await aiConfigFor(db, { userId: agent.id, projectId: channel.project_id ?? null, feature: 'agent.chat', now });
  if (!cfg && decision.stage === 'profile') { await post('Mir ist gerade kein aktives KI-Profil zugewiesen, ich kann nicht antworten. Bitte an die Verwaltung (KI-Agenten) wenden.'); return { status: 'skipped', error: 'kein KI-Profil' }; }
  if (!cfg && decision.stage === 'budget') { await post('Mein Tagesbudget ist aufgebraucht. Ich melde mich morgen; Dringendes bitte an die Projektleitung.'); return { status: 'skipped', error: 'Tagesbudget' }; }
  // Sperre des Agenten (auch „Eigene Agenten der PL“ für die PL, die ihn angelegt hat): nie mit Namen und Notiz persönlicher Regeln
  if (!cfg) return blocked(`Ich bin hier gesperrt: ${decision.publicReason}`, `Ich bin hier gesperrt: ${decision.publicReason}`, decision.publicReason);

  // Verlauf: Thread (Ursprung und Antworten) bzw. die letzten Nachrichten des Gesprächs
  const history = threadId
    ? await db.query(`select m.body, m.created_at, m.kind, u.name, u.id as uid from chat_messages m left join users u on u.id = m.user_id where (m.id = $1 or m.thread_id = $1) and m.deleted_at is null order by m.created_at desc limit 20`, [threadId])
    : await db.query(`select m.body, m.created_at, m.kind, u.name, u.id as uid from chat_messages m left join users u on u.id = m.user_id where m.channel_id = $1 and m.thread_id is null and m.deleted_at is null order by m.created_at desc limit 16`, [channel.id]);
  // Eigene Arbeitspakete: im Projektkanal nur dieses Projekt und keine eingeschränkten Teilprojekte (alle Mitglieder lesen mit),
  // in Direktnachrichten nur Projekte und Teilprojekte, die die fragende Person sieht
  const tasks = await db.query(
    `select t.id, t.project_id, t.subproject_id, t.number, t.title, t.due_date, t.agent_wait, t.blocked, t.blocked_reason, c.name as column_name, p.key, pt.title as parent_title,
       (select string_agg(x.body, ' | ' order by x.created_at desc) from (select body, created_at from task_comments where task_id = t.id order by created_at desc limit 3) x) as recent
     from tasks t join board_columns c on c.id = t.column_id join projects p on p.id = t.project_id ${EFFECTIVE_JOINS}
     where (${EFFECTIVE_RESPONSIBLE_SQL}) = $1 and t.deleted_at is null and t.archived_at is null and not c.is_done and p.status = 'active'
       and ${project ? `t.project_id = $2 and (t.subproject_id is null or not exists (select 1 from subprojects s where s.id = t.subproject_id and s.restricted))`
                     : `exists (select 1 from project_members pm where pm.project_id = t.project_id and pm.user_id = $2 and (pm.role = 'pl' or pm.can_use_ai)) and ${visibleSubprojectSql(2)}`}
     order by t.due_date nulls last limit 25`,
    [agent.id, project ? project.id : msg.user_id]
  );
  // Direktnachricht: nur Projekte, in denen Absender und Agent freigegeben sind (Projektregeln, Ausnahmen), und nur Arbeitspakete,
  // für die der Absender intern ist (Regel E); Org-Benutzer ohne Projektzugriff (outside) bekommen nichts aus dem Projekt
  if (!project) {
    const ok = new Map<string, boolean>();
    for (const pid of new Set<string>(tasks.rows.map((t: any) => t.project_id))) {
      ok.set(pid, (await aiAllowed(db, { userId: msg.user_id, projectId: pid, feature: 'agent.chat' })).allowed && (await aiAllowed(db, { userId: agent.id, projectId: pid, feature: 'agent.chat', budget: false })).allowed);
    }
    const inner: any[] = [];
    for (const t of tasks.rows as any[]) if (ok.get(t.project_id) && (await isInternal(db, { projectId: t.project_id, subprojectId: t.subproject_id, userId: msg.user_id }))) inner.push(t);
    tasks.rows = inner;
  }
  const known = new Map<string, any>(tasks.rows.map((t: any) => [t.id, t]));
  const system = `${AGENT_SHEET}\n\n${CHAT_RULES}\n\n# Du\nDu bist „${agent.name}“, KI-Agent im Projekttool. ${styleText(agent.persona)}`;
  const prompt = `Jetzt: ${hhmm(now)}
Gespräch: ${project ? `Projektkanal ${project.key} „${project.name}“${threadId ? ' (Thread)' : ''}` : `Direktnachricht mit ${msg.user_name}`}
Deine offenen Arbeitspakete${project ? ` in ${project.key}` : ''}:
${tasks.rows.map((t: any) => `- ${t.key}-${t.number} „${t.title}“${t.parent_title ? ` (Aufgabe in „${t.parent_title}“)` : ''} · ${t.column_name}${t.due_date ? ` · fällig ${String(t.due_date instanceof Date ? t.due_date.toISOString() : t.due_date).slice(0, 10)}` : ''}${t.blocked ? ` · blockiert: ${t.blocked_reason ?? ''}` : ''}${t.agent_wait ? ` · du wartest auf: ${t.agent_wait.reason}` : ''} (taskId ${t.id})${t.recent ? `\n  Log: ${cut(t.recent, 500)}` : ''}`).join('\n') || '– keine –'}
Verlauf (älteste zuerst):
${[...history.rows].reverse().map((h: any) => `${hhmm(h.created_at)} ${h.kind === 'system' ? 'System' : h.uid === agent.id ? 'Du' : h.name}: ${cut(h.body, 600)}`).join('\n')}

Antworte auf die letzte Nachricht von ${msg.user_name}.`;
  try {
    const r = await complete(cfg, fetchFn, { system, prompt, maxTokens: cfg.enableThinking === true ? 5200 : 1200, schema: SCHEMA });
    const j = parseJson<{ reply?: string; notes?: { taskId: string; text: string }[] }>(r.text);
    const reply = String(j.reply ?? '').trim() || 'Dazu kann ich gerade nichts sagen.';
    const notes = (Array.isArray(j.notes) ? j.notes : []).filter((n) => known.has(n.taskId) && String(n.text ?? '').trim()).slice(0, 3);
    await post(reply);
    for (const n of notes) {
      await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [n.taskId, agent.id, `Aus dem Chat (${msg.user_name}): ${cut(n.text, 1000)}`]);
      queueAgentRun(n.taskId, 'comment');
    }
    const actions = [{ type: 'chat_reply', text: cut(reply, 300) }, ...notes.map((n) => ({ type: 'chat_note', taskId: n.taskId, text: cut(n.text, 300) }))];
    const run = await db.one(`insert into agent_runs (org_id, agent_user_id, project_id, task_id, trigger, status, reasoning, actions, input_tokens, output_tokens, channel_id) values ($1,$2,$3,null,'chat','ok',$4,$5,$6,$7,$8) returning id`,
      [agent.org_id, agent.id, channel.project_id ?? null, `Chat mit ${msg.user_name}`, JSON.stringify(actions), r.inputTokens, r.outputTokens, channel.id]);
    await audit(db, { orgId: agent.org_id, projectId: channel.project_id ?? null, userId: agent.id, action: 'agent.chat', objectType: 'chat_channel', objectId: channel.id, details: { runId: run.id, notes: notes.length, profile: cfg.name, model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens } });
    return { status: 'ok', reply, notes };
  } catch (e: any) {
    const err = String(e?.message ?? e).slice(0, 300);
    await db.query(`insert into agent_runs (org_id, agent_user_id, project_id, task_id, trigger, status, error, channel_id) values ($1,$2,$3,null,'chat','error',$4,$5)`, [agent.org_id, agent.id, channel.project_id ?? null, err, channel.id]);
    await post('Ich konnte gerade nicht antworten (Fehler beim KI-Dienst). Bitte später noch einmal versuchen.');
    return { status: 'error', error: err };
  }
}
