import type { NotifyEvent, QuestionKind, QuestionStatus } from '@projekttool/shared';
import type { Db } from './db.js';
import { audit } from './audit.js';
import { dispatch, dmChannel, notify, projectChannelId, systemMessage } from './notify.js';
import { resolveRule } from './rules.js';
import { canSeeSubproject } from './rights.js';
import { contactChain } from './tasks/service.js';
import { queueAgentRun } from './ai/agentEvents.js';
import { onQuestionAnswered } from './ai/mailInquiry.js';
import { projectPolicy } from './projectPolicy.js';

/**
 * Offene Fragen (Konzept 5): Eine Frage ist ein Objekt. Chat-Nachricht (Thread-Wurzel), Meldungen (ref question), Log-Eintrag,
 * Wartezustand des Agenten und Antwort verweisen darauf. Den Status ändert nur dieses Modul; von hier überträgt er sich an alle
 * Stellen: Meldungen werden erledigt, der Thread bekommt eine Systemnachricht, das Warten endet, der Agent läuft erneut.
 */
export interface QuestionRow {
  id: string; org_id: string; project_id: string; task_id: string | null; meeting_id: string | null; kind: QuestionKind;
  asked_by: string; addressee_id: string | null; addressee_role: string | null; level: number; parent_id: string | null;
  body: string; options: { key: string; label: string }[] | null; channel_id: string | null; message_id: string | null; status: QuestionStatus;
  remind_at: Date | null; escalate_at: Date | null; reminded_at: Date | null;
  answered_by: string | null; answered_at: Date | null; answer_source: string | null; answer_text: string | null; answer_option: string | null;
  answer_message_id: string | null; answer_comment_id: string | null; cancel_reason: string | null; created_at: Date; booking_id?: string | null;
  /** Thema und Bezug (z. B. mail_inquiry: mailId, openPoints, waitHours) */
  context?: Record<string, unknown> | null;
}
export interface Asker { id: string; name: string; org_id: string; kind?: string }

const H = 3600_000;
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const cut = (s: string | null | undefined, n: number) => { const t = (s ?? '').trim(); return t.length > n ? t.slice(0, n) + ' …' : t; };
export const code = (t: { project_key: string; number: number }) => `${t.project_key}-${t.number}`;

async function taskRow(db: Db, taskId: string) {
  return db.maybeOne(`select t.*, p.key as project_key, p.org_id from tasks t join projects p on p.id = t.project_id where t.id = $1`, [taskId]);
}

/** Adressat nach Regel C: gewählte Stufe (to) oder Stufe 0 der Kette; null = Projektkanal (nur wenn erlaubt). */
export async function pickAddressee(db: Db, task: any, asker: Asker, opts: { to?: string | null; kind: QuestionKind; level?: number }): Promise<{ userId: string | null; role: string; name: string } | { error: string }> {
  const chain = await contactChain(db, task, { exclude: [asker.id] });
  const to = (opts.to ?? '').trim().toLowerCase();
  const channelOk = async () => {
    const p = await db.one(`select personal from projects where id = $1`, [task.project_id]);
    const restricted = task.subproject_id ? Boolean(await db.maybeOne(`select 1 from subprojects where id = $1 and restricted`, [task.subproject_id])) : false;
    return projectPolicy(p).channelPosts && !restricted;
  };
  if (to === 'projekt' || to === '#projekt' || to === 'projektkanal') {
    if (!(await channelOk())) return { error: 'Projektkanal nicht bei eingeschränkten Teilprojekten oder persönlichen Projekten' };
    return { userId: null, role: 'project', name: 'Projektkanal' };
  }
  if (to === 'pl') {
    // PL oder Stellvertretung; steht die PL schon früher in der Kette (z. B. als Auftraggeber), zählt sie trotzdem als PL
    const plIds = (await db.query(`select m.user_id from project_members m join users u on u.id = m.user_id where m.project_id = $1 and m.role = 'pl' and u.kind <> 'agent' and u.active order by m.is_deputy, m.created_at`, [task.project_id])).rows.map((r: any) => r.user_id as string);
    const c = plIds.map((id) => chain.find((x) => x.id === id)).find(Boolean) ?? chain.find((x) => x.role === 'pl' || x.role === 'deputy_pl');
    if (c) return { userId: c.id, role: c.role === 'pl' || c.role === 'deputy_pl' ? c.role : 'pl', name: c.name };
  }
  if (to === 'tp') { const c = chain.find((x) => x.role === 'subproject_lead'); if (c) return { userId: c.id, role: c.role, name: c.name }; }
  if (to.includes('@')) { const c = chain.find((x) => x.email.toLowerCase() === to); if (c) return { userId: c.id, role: c.role, name: c.name }; return { error: `${to} steht nicht in der Kette (Auftraggeber, Über-AP, Teilprojekt, PL, Eskalationskontakt)` }; }
  if (opts.kind === 'decision') { const c = chain.find((x) => ['pl', 'deputy_pl', 'escalation_contact'].includes(x.role)) ?? chain[0]; if (c) return { userId: c.id, role: c.role, name: c.name }; }
  const idx = Math.min(opts.level ?? 0, chain.length);
  const c = chain[idx];
  if (c) return { userId: c.id, role: c.role, name: c.name };
  if (await channelOk()) return { userId: null, role: 'project', name: 'Projektkanal' };
  return { error: 'Niemand in der Kette erreichbar' };
}

/** Frist aus Regel N (Klasse der Frage); dueHours des Modells verkürzt nur im Bereich [4 h, Standard]. */
async function timing(db: Db, q: { orgId: string; projectId: string; taskId: string | null; event: NotifyEvent }, dueHours?: number | null, now = new Date()) {
  const rule = await resolveRule(db, { orgId: q.orgId, projectId: q.projectId, taskId: q.taskId, event: q.event });
  const remindH = Number(rule.value.remindH ?? 48); const escalateH = Number(rule.value.escalateH ?? 0) || null;
  const wanted = dueHours && Number.isFinite(dueHours) ? Math.max(4, Math.min(Number(dueHours), remindH)) : remindH;
  return { remindAt: new Date(now.getTime() + wanted * H), escalateAt: escalateH ? new Date(now.getTime() + Math.max(wanted, escalateH) * H) : null, chat: rule.value.chat, mail: rule.value.mail };
}

export interface AskInput {
  taskId: string; asker: Asker; kind: QuestionKind; body: string; to?: string | null; dueHours?: number | null;
  meetingId?: string | null; /** Belegung, die bestätigt werden soll (Frage confirm) */ bookingId?: string | null; options?: { key: string; label: string }[] | null; level?: number; parentId?: string | null; now?: Date;
  /** Meldungstyp und Titel abweichend vom Standard */
  type?: string; title?: string;
  /** Thema und Bezug für Folgeschritte (z. B. Mail-Rückfrage) */
  context?: Record<string, unknown> | null;
}

/**
 * Frage stellen: Adressat nach Regel C, Dedupe am AP (gleicher Adressat, gleicher Text), Chat-Nachricht als Thread-Wurzel (DM oder
 * Projektkanal), Meldung je Empfänger mit Bezug, Log-Eintrag, Wartezustand des Agenten.
 */
export async function askQuestion(db: Db, a: AskInput): Promise<{ question: QuestionRow } | { error: string; existing?: QuestionRow }> {
  const now = a.now ?? new Date();
  const task = await taskRow(db, a.taskId);
  if (!task) return { error: 'Arbeitspaket nicht gefunden' };
  const body = a.body.trim().slice(0, 4000);
  if (!body) return { error: 'Frage ohne Text' };
  const target = await pickAddressee(db, task, a.asker, { to: a.to, kind: a.kind, level: a.level });
  if ('error' in target) return target;
  const dup = await db.maybeOne<QuestionRow>(`select * from questions where task_id = $1 and status = 'open' and addressee_id is not distinct from $2::uuid and lower(regexp_replace(body, '\\s+', ' ', 'g')) = $3`, [task.id, target.userId, norm(body)]);
  if (dup) return { error: `Frage an ${target.name} ist seit ${new Date(dup.created_at).toLocaleDateString('de-DE')} offen; nicht erneut fragen`, existing: dup };
  const event: NotifyEvent = a.kind === 'confirm' ? 'confirm' : a.kind === 'decision' ? 'decision' : a.kind === 'external_referral' ? 'external_referral' : a.kind === 'approval' ? 'approval' : a.kind === 'synergy' ? 'synergy' : a.kind === 'order_request' ? 'order_request' : 'question';
  const t = await timing(db, { orgId: task.org_id, projectId: task.project_id, taskId: task.id, event }, a.dueHours, now);
  const channelId = target.userId ? await dmChannel(db, task.org_id, a.asker.id, target.userId) : await projectChannelId(db, task.org_id, task.project_id);
  const text = `${code(task)} „${task.title}“: ${body}`;
  // Fragenachricht: Nachricht des Agenten bzw. der Person (kind user), damit der Thread darunter entsteht; Karte in meta
  const msg = await db.one(`insert into chat_messages (channel_id, user_id, body, meta) values ($1,$2,$3,$4) returning id`,
    [channelId, a.asker.id, text.slice(0, 8000), JSON.stringify({ question: true, kind: a.kind, options: a.options ?? null, taskId: task.id, link: `/projekte/${task.project_id}/board?task=${task.id}` })]);
  await db.query(`insert into chat_channel_members (channel_id, user_id, last_read_at) values ($1,$2,now()) on conflict (channel_id, user_id) do update set last_read_at = now()`, [channelId, a.asker.id]);
  const q = await db.one<QuestionRow>(
    `insert into questions (org_id, project_id, task_id, meeting_id, kind, asked_by, addressee_id, addressee_role, level, parent_id, body, options, channel_id, message_id, remind_at, escalate_at, context, booking_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning *`,
    [task.org_id, task.project_id, task.id, a.meetingId ?? null, a.kind, a.asker.id, target.userId, target.role, a.level ?? 0, a.parentId ?? null, body, a.options ? JSON.stringify(a.options) : null, channelId, msg.id, t.remindAt, t.escalateAt, a.context ? JSON.stringify(a.context) : null, a.bookingId ?? null]);
  await db.query(`update chat_messages set meta = meta || $2::jsonb where id = $1`, [msg.id, JSON.stringify({ questionId: q.id })]);
  // Meldungen: an den Adressaten, im Projektkanal an alle Mitglieder mit Sicht auf das AP (ohne Agenten, ohne Fragenden)
  const recipients: string[] = target.userId ? [target.userId] : (await db.query(`select m.user_id from project_members m join users u on u.id = m.user_id where m.project_id = $1 and u.active and u.kind <> 'agent' and m.role <> 'reader'`, [task.project_id])).rows.map((r: any) => r.user_id);
  const link = `/chat/${channelId}?thread=${msg.id}&msg=${msg.id}`;
  const label = a.kind === 'confirm' ? 'Bestätigung' : a.kind === 'decision' ? 'Entscheidung' : a.kind === 'external_referral' ? 'Rückfrage von extern' : a.kind === 'approval' ? 'Freigabe' : a.kind === 'order_request' ? 'Auftragsvorschlag' : 'Frage';
  const type = a.type ?? `question.${a.kind}`; const title = a.title ?? `${label} von ${a.asker.name} zu ${code(task)}`;
  for (const u of recipients) {
    if (u === a.asker.id || (!target.userId && !(await canSeeSubproject(db, u, task.subproject_id)))) continue;
    await notify(db, { userId: u, projectId: task.project_id, taskId: task.id, type, event, title, body: cut(body, 300), link, ref: { type: 'question', id: q.id }, actorId: a.asker.id, dedupeKey: `q:${q.id}:${a.level ?? 0}`, chatted: true });
  }
  // Weitere Empfänger nach Regel N (z. B. Entscheidungen an PL und Stellvertretung): Meldung mit Link zum Arbeitspaket, da der Chat-Thread nur dem Adressaten gehört
  await dispatch(db, { event, projectId: task.project_id, taskId: task.id, type, title, body: cut(body, 300), link: `/projekte/${task.project_id}/board?task=${task.id}`, ref: { type: 'question', id: q.id }, actorId: a.asker.id, dedupeKey: `q:${q.id}:${a.level ?? 0}`, chatted: true, logged: true });
  const isAgent = a.asker.kind === 'agent' || Boolean(await db.maybeOne(`select 1 from users where id = $1 and kind = 'agent'`, [a.asker.id]));
  await db.query(`insert into task_comments (task_id, user_id, body, source, question_id) values ($1,$2,$3,$4,$5)`, [task.id, a.asker.id, `${label} an ${target.name} (Chat): ${cut(body, 1500)}`, isAgent ? 'ai' : 'user', q.id]);
  if (isAgent) {
    const wait = { kind: 'reply', reason: cut(body, 300), since: now.toISOString(), questionId: q.id, remindAt: t.remindAt.toISOString(), escalateAt: t.escalateAt?.toISOString() ?? null, reminded: false, escalated: false };
    await db.query(`update tasks set agent_wait = $2, agent_next_check_at = $3 where id = $1`, [task.id, JSON.stringify(wait), t.escalateAt ?? t.remindAt]);
  }
  await audit(db, { orgId: task.org_id, projectId: task.project_id, userId: a.asker.id, action: 'question.ask', objectType: 'question', objectId: q.id, details: { kind: a.kind, to: target.name, level: a.level ?? 0 } });
  return { question: q };
}

export interface AnswerInput { source: 'chat' | 'task' | 'meeting' | 'mail' | 'system'; userId: string | null; text: string; option?: string | null; messageId?: string | null; commentId?: string | null; now?: Date; /** Anlass des Folgelaufs des fragenden Agenten (Standard answer) */ trigger?: string }

/** Meldungen zur Frage und ihren Vorgängern erledigen (für alle Empfänger). */
async function resolveNotifications(db: Db, q: QuestionRow, suffix?: string) {
  const ids = [q.id]; let p = q.parent_id;
  for (let i = 0; p && i < 10; i++) { ids.push(p); p = (await db.maybeOne(`select parent_id from questions where id = $1`, [p]))?.parent_id ?? null; }
  await db.query(`update notifications set read_at = coalesce(read_at, now()), resolved_at = now()${suffix ? `, body = coalesce(body, '') || $2` : ''} where ref_type = 'question' and ref_id = any($1::uuid[]) and resolved_at is null`, suffix ? [ids, ` · ${suffix}`] : [ids]);
}

/**
 * Antwort: idempotent (nur offene Fragen). Setzt Status, erledigt die Meldungen, schreibt die Rückmeldung ins Log (bei Antworten
 * aus dem Chat), schließt den Thread mit einer Systemnachricht (bei Antworten aus der Aufgabe oder auf anderem Weg), löscht das
 * Warten des Agenten, wenn es zu dieser Frage gehört, und startet seinen Lauf mit Anlass answer.
 */
export async function answerQuestion(db: Db, q: QuestionRow, a: AnswerInput): Promise<QuestionRow | null> {
  const r = await db.maybeOne<QuestionRow>(`update questions set status = 'answered', answered_by = $2, answered_at = now(), answer_source = $3, answer_text = $4, answer_option = $5, answer_message_id = $6, answer_comment_id = $7 where id = $1 and status = 'open' returning *`,
    [q.id, a.userId, a.source, cut(a.text, 4000), a.option ?? null, a.messageId ?? null, a.commentId ?? null]);
  if (!r) return null;
  const who = a.userId ? await db.maybeOne(`select id, name, kind from users where id = $1`, [a.userId]) : null;
  const asker = await db.one(`select id, name, kind from users where id = $1`, [q.asked_by]);
  await resolveNotifications(db, r, who ? `beantwortet von ${who.name}` : 'erledigt');
  const task = r.task_id ? await taskRow(db, r.task_id) : null;
  const optionLabel = a.option && r.options ? r.options.find((o) => o.key === a.option)?.label ?? a.option : null;
  const answer = optionLabel ? `${optionLabel}${a.text.trim() && a.text.trim() !== optionLabel ? ` – ${a.text.trim()}` : ''}` : a.text.trim();
  if (task && a.source !== 'task' && a.source !== 'meeting') {
    const c = await db.one(`insert into task_comments (task_id, user_id, body, source, question_id) values ($1,$2,$3,$4,$5) returning id`,
      [task.id, a.userId ?? asker.id, a.source === 'chat' ? `Rückmeldung per Chat an ${asker.name}: ${cut(answer, 1500)}` : `Erledigt (${a.source === 'mail' ? 'Antwort kam per Mail' : 'System'}): ${cut(answer, 1500)}`, a.source === 'chat' ? 'chat' : 'system', r.id]);
    await db.query(`update questions set answer_comment_id = coalesce(answer_comment_id, $2) where id = $1`, [r.id, c.id]);
  }
  // Thread schließen: bei Antwort außerhalb des Chats eine Systemnachricht, damit das Thema auch dort abgeschlossen ist
  if (r.channel_id && r.message_id && a.source !== 'chat') {
    const text = a.source === 'task' ? `Beantwortet in ${task ? code(task) : 'der Aufgabe'} von ${who?.name ?? '?'}: ${cut(answer, 300)}` : a.source === 'meeting' ? `Bestätigt von ${who?.name ?? '?'}: ${cut(answer, 300)}` : `Erledigt: ${a.source === 'mail' ? 'Antwort kam per Mail' : 'vom System'}${task ? ` (siehe Log ${code(task)})` : ''}`;
    await systemMessage(db, { channelId: r.channel_id, threadId: r.message_id, authorId: who?.kind === 'person' ? who.id : null, body: text, meta: { questionId: r.id, status: 'answered' } });
    // Meldungen des Threads beim Adressaten gelten als gelesen
    if (r.addressee_id) await db.query(`update notifications set read_at = coalesce(read_at, now()) where user_id = $1 and ref_type = 'chat_thread' and ref_id = $2`, [r.addressee_id, r.message_id]);
  }
  if (task) {
    const w = task.agent_wait ?? null;
    if (w && w.questionId === r.id) await db.query(`update tasks set agent_wait = null, agent_next_check_at = null where id = $1`, [task.id]);
    // Folgeschritt zum Thema der Frage (Mail-Rückfrage: im Projekt fragen, beim Absender nachfragen) ersetzt den Lauf „answer“
    const handled = await onQuestionAnswered(db, r, a);
    if (asker.kind === 'agent' && !handled) queueAgentRun(task.id, a.trigger ?? 'answer');
  }
  await audit(db, { orgId: r.org_id, projectId: r.project_id, userId: a.userId, action: 'question.answer', objectType: 'question', objectId: r.id, details: { source: a.source, option: a.option ?? null } });
  return r;
}

/** Abbruch (AP erledigt, archiviert, gelöscht, Zuständigkeit gewechselt, Besprechung gelöscht, withdraw, von Hand). */
export async function cancelQuestions(db: Db, where: { taskId?: string; meetingId?: string; questionId?: string; askedBy?: string }, reason: string, userId: string | null = null): Promise<number> {
  const conds: string[] = ['status = \'open\'']; const params: any[] = [reason];
  if (where.questionId) { params.push(where.questionId); conds.push(`id = $${params.length}`); }
  if (where.taskId) { params.push(where.taskId); conds.push(`task_id = $${params.length}`); }
  if (where.meetingId) { params.push(where.meetingId); conds.push(`meeting_id = $${params.length}`); }
  if (where.askedBy) { params.push(where.askedBy); conds.push(`asked_by = $${params.length}`); }
  if (params.length === 1) return 0;
  const rows = await db.query<QuestionRow>(`update questions set status = 'cancelled', cancel_reason = $1, answered_at = now() where ${conds.join(' and ')} returning *`, params);
  for (const q of rows.rows) {
    await resolveNotifications(db, q, 'hat sich erledigt');
    if (q.channel_id && q.message_id) await systemMessage(db, { channelId: q.channel_id, threadId: q.message_id, body: `Hat sich erledigt: ${reason}`, meta: { questionId: q.id, status: 'cancelled' } });
    if (q.task_id) await db.query(`update tasks set agent_wait = null, agent_next_check_at = null where id = $1 and agent_wait->>'questionId' = $2`, [q.task_id, q.id]);
    await audit(db, { orgId: q.org_id, projectId: q.project_id, userId, action: 'question.cancel', objectType: 'question', objectId: q.id, details: { reason } });
  }
  return rows.rows.length;
}

/** Weitergabe an die nächste Stufe der Kette: alte Frage escalated, neue Frage mit level+1 und parent_id; auf der letzten Stufe bleibt sie offen. */
export async function escalateQuestion(db: Db, q: QuestionRow, now = new Date()): Promise<QuestionRow | null> {
  if (!q.task_id) return null;
  const task = await taskRow(db, q.task_id);
  const asker = await db.one(`select id, name, org_id, kind from users where id = $1`, [q.asked_by]);
  if (!task) return null;
  const next = await pickAddressee(db, task, asker, { kind: q.kind, level: q.level + 1 });
  if ('error' in next || (next.userId === q.addressee_id && next.role === q.addressee_role)) {
    // Letzte Stufe: offen lassen, nur einmal vermerken
    await db.query(`update questions set escalate_at = null where id = $1`, [q.id]);
    if (q.channel_id && q.message_id) await systemMessage(db, { channelId: q.channel_id, threadId: q.message_id, authorId: asker.kind === 'agent' ? asker.id : null, body: 'Keine weitere Stufe: die Frage bleibt offen und steht auf dem Dashboard der PL.', meta: { questionId: q.id, status: 'open' } });
    return null;
  }
  const r = await askQuestion(db, { taskId: task.id, asker, kind: q.kind, body: q.body, to: next.userId ? undefined : 'projekt', level: q.level + 1, parentId: q.id, options: q.options, now });
  if ('error' in r) return null;
  await db.query(`update questions set status = 'escalated' where id = $1`, [q.id]);
  await resolveNotifications(db, q, `weitergegeben an ${next.name}`);
  if (q.channel_id && q.message_id) await systemMessage(db, { channelId: q.channel_id, threadId: q.message_id, authorId: asker.kind === 'agent' ? asker.id : null, body: `Weitergegeben an ${next.name} (keine Antwort bis zur Frist).`, meta: { questionId: q.id, status: 'escalated', nextQuestionId: r.question.id } });
  await db.query(`insert into task_comments (task_id, user_id, body, source, question_id) values ($1,$2,$3,'system',$4)`, [task.id, asker.id, `Frage ohne Antwort an ${next.name} weitergegeben: ${cut(q.body, 300)}`, r.question.id]);
  await audit(db, { orgId: q.org_id, projectId: q.project_id, userId: asker.id, action: 'question.escalate', objectType: 'question', objectId: q.id, details: { to: next.name, level: q.level + 1 } });
  return r.question;
}

/** Worker: Erinnerung in denselben Thread (einmal), danach Weitergabe zur Frist; ohne KI. */
export async function runQuestions(db: Db, now = new Date()): Promise<{ reminded: number; escalated: number }> {
  let reminded = 0; let escalated = 0;
  const due = await db.query<QuestionRow>(`select * from questions where status = 'open' and ((remind_at <= $1 and reminded_at is null) or escalate_at <= $1) order by created_at limit 50`, [now]);
  for (const q of due.rows) {
    if (q.escalate_at && new Date(q.escalate_at) <= now) { if (await escalateQuestion(db, q, now)) escalated++; continue; }
    if (q.remind_at && new Date(q.remind_at) <= now && !q.reminded_at) {
      await db.query(`update questions set reminded_at = $2 where id = $1`, [q.id, now]);
      const asker = await db.one(`select id, name, kind from users where id = $1`, [q.asked_by]);
      const task = q.task_id ? await taskRow(db, q.task_id) : null;
      if (q.channel_id && q.message_id) await systemMessage(db, { channelId: q.channel_id, threadId: q.message_id, authorId: asker.kind === 'agent' ? asker.id : null, body: `Erinnerung: ${cut(q.body, 300)}`, meta: { questionId: q.id, status: 'open' } });
      const link = `/chat/${q.channel_id}?thread=${q.message_id}&msg=${q.message_id}`;
      const recipients = q.addressee_id ? [q.addressee_id] : (await db.query(`select m.user_id from project_members m join users u on u.id = m.user_id where m.project_id = $1 and u.active and u.kind <> 'agent' and m.role <> 'reader'`, [q.project_id])).rows.map((r: any) => r.user_id);
      for (const u of recipients) await notify(db, { userId: u, projectId: q.project_id, taskId: q.task_id, type: `question.remind`, event: 'question', title: `Erinnerung: Frage von ${asker.name}${task ? ` zu ${code(task)}` : ''}`, body: cut(q.body, 300), link, ref: { type: 'question', id: q.id }, actorId: asker.id, dedupeKey: `q:${q.id}:remind`, chatted: true });
      if (q.task_id) await db.query(`update tasks set agent_wait = agent_wait || '{"reminded":true}'::jsonb where id = $1 and agent_wait->>'questionId' = $2`, [q.task_id, q.id]);
      reminded++;
    }
  }
  return { reminded, escalated };
}

/** Regel F Schritt 1 und 2: offene Frage zu einer Chat-Nachricht (Thread-Wurzel oder einzige offene Frage des Agenten an die Person in der DM). */
export const FREE_TEXT_KINDS: QuestionKind[] = ['question', 'decision', 'external_referral', 'synergy', 'order_request'];

/** Darf die Person diese Frage beantworten? Adressat immer; im Projektkanal (ohne Adressat) Mitglieder ab Rolle member mit Sicht auf das AP; sonst die PL. */
export async function canAnswer(db: Db, q: QuestionRow, userId: string): Promise<boolean> {
  if (q.addressee_id === userId) return true;
  const mem = await db.maybeOne(`select role from project_members where project_id = $1 and user_id = $2`, [q.project_id, userId]);
  if (!mem || mem.role === 'reader') return false;
  if (q.addressee_id && mem.role !== 'pl') return false;
  const t = q.task_id ? await db.maybeOne(`select subproject_id from tasks where id = $1`, [q.task_id]) : null;
  return !t || canSeeSubproject(db, userId, t.subproject_id);
}

export async function matchQuestion(db: Db, m: { channelId: string; threadId: string | null; userId: string; agentId: string | null }): Promise<QuestionRow | null> {
  if (m.threadId) {
    const q = await db.maybeOne<QuestionRow>(`select * from questions where message_id = $1 and status = 'open'`, [m.threadId]);
    if (!q || !FREE_TEXT_KINDS.includes(q.kind)) return null;
    // In einer DM antwortet nur der Adressat; im Projektkanal Mitglieder mit Sicht (nicht die PL stellvertretend für einen Adressaten: das geht über die Aufgabe)
    if (q.addressee_id) return q.addressee_id === m.userId ? q : null;
    return (await canAnswer(db, q, m.userId)) ? q : null;
  }
  if (!m.agentId) return null;
  const rows = await db.query<QuestionRow>(`select * from questions where channel_id = $1 and asked_by = $2 and addressee_id = $3 and status = 'open' and kind = any($4::text[]) order by created_at desc limit 2`, [m.channelId, m.agentId, m.userId, FREE_TEXT_KINDS]);
  return rows.rows.length === 1 ? rows.rows[0] : null;
}

export function mapQuestion(r: any) {
  return {
    id: r.id, projectId: r.project_id, taskId: r.task_id, meetingId: r.meeting_id ?? null, kind: r.kind, status: r.status, level: r.level, parentId: r.parent_id ?? null,
    askedBy: r.asked_by, askedByName: r.asked_by_name ?? null, addresseeId: r.addressee_id ?? null, addresseeName: r.addressee_name ?? null, addresseeRole: r.addressee_role ?? null,
    body: r.body, options: r.options ?? null, channelId: r.channel_id ?? null, messageId: r.message_id ?? null,
    remindAt: r.remind_at ?? null, escalateAt: r.escalate_at ?? null, remindedAt: r.reminded_at ?? null,
    answeredBy: r.answered_by ?? null, answeredByName: r.answered_by_name ?? null, answeredAt: r.answered_at ?? null, answerSource: r.answer_source ?? null, answerText: r.answer_text ?? null, answerOption: r.answer_option ?? null,
    cancelReason: r.cancel_reason ?? null, createdAt: r.created_at, taskCode: r.task_code ?? null, taskTitle: r.task_title ?? null, projectKey: r.project_key ?? null,
    context: r.context ?? null,
    proposals: r.proposals ?? null
  };
}
export const QUESTION_SELECT = `select q.*, ab.name as asked_by_name, ad.name as addressee_name, an.name as answered_by_name, p.key as project_key, case when t.id is null then null else p.key || '-' || t.number end as task_code, t.title as task_title,
    (select json_agg(json_build_object('id', x.id, 'status', x.status, 'class', x.action_class, 'label', x.payload->>'label', 'seq', x.seq) order by x.seq) from ai_proposals x where x.question_id = q.id) as proposals
  from questions q join projects p on p.id = q.project_id left join tasks t on t.id = q.task_id left join users ab on ab.id = q.asked_by left join users ad on ad.id = q.addressee_id left join users an on an.id = q.answered_by`;
