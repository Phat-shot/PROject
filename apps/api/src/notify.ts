import type { NotifyEvent, NotifyRefType } from '@projekttool/shared';
import { eventOfType, NOTIFY_EVENTS } from '@projekttool/shared';
import type { Db } from './db.js';
import { canSeeSubproject, groupRecipients } from './rights.js';
import { appendDocEntry, resolveRule } from './rules.js';
import { loadTask, resolveProjectLead } from './tasks/service.js';
import { localParts } from './localTime.js';
import { projectPolicy } from './projectPolicy.js';

export interface NotifyInput {
  userId: string;
  projectId?: string | null;
  /** Arbeitspaket der Meldung (Regeln am AP, Benutzer am AP); ohne Angabe aus ref (task) */
  taskId?: string | null;
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
  /** Gleicher Schlüssel je Benutzer → nur einmal; enthält Zeitraum oder Stufe (z. B. due_soon:<id>:<Fälligkeit>, esc:<id>:<Stufe>). */
  dedupeKey?: string | null;
  /** Ereignisklasse; ohne Angabe aus dem Typ (EVENT_OF_TYPE) */
  event?: NotifyEvent;
  /** Bezug für Gelesen- und Erledigt-Status und Deep-Link (Frage, Chat-Kanal, Thread, AP, Seite, Buchung) */
  ref?: { type: NotifyRefType; id: string } | null;
  /** Auslöser: bekommt keine Meldung; ist es ein Agent, geht Chat „thread“ als Systembeitrag in seine Direktnachricht an die Person */
  actorId?: string | null;
  /** Thread der Meldung (Frage, Auftrag): dorthin geht Chat „thread“ (einmal je Ereignis, über dispatch) */
  thread?: { channelId: string; messageId: string } | null;
  /** Die Aufrufstelle hat selbst in den Chat geschrieben (z. B. Direktnachricht des Agenten an die PL) */
  chatted?: boolean;
  /** Lieferung: PDF der Seite (ref page) an die Mail hängen, nur an interne Empfänger mit Leserecht */
  attach?: boolean;
  /** Zwischenstand: Meilenstein (Status, In Prüfung, Entscheidung) bzw. Abschluss; filtert nach dem Berichtswunsch (every) */
  progress?: { milestone: boolean; done: boolean };
}

/** Meldungsarten, bei denen nur die neueste ungelesene je Arbeitspaket zählt. */
const SUPERSEDING_TYPES = new Set(['task.progress', 'escalation', 'draft.review', 'outbound.review', 'task.wait_expired']);

/**
 * Worker: überholte ungelesene Meldungen ausblenden. Eskalation und abgelaufene Frist eines erledigten, archivierten oder
 * gelöschten Arbeitspakets; Entwurf zur Freigabe, wenn zum Arbeitspaket kein Entwurf mehr wartet.
 */
export async function supersedeStaleNotifications(db: Db): Promise<number> {
  const r = await db.query(`update notifications n set read_at = now(), superseded_at = now() where n.read_at is null and n.ref_type = 'task' and (
      (n.type in ('escalation', 'task.wait_expired') and exists (select 1 from tasks t join board_columns c on c.id = t.column_id where t.id = n.ref_id and (c.is_done or t.archived_at is not null or t.deleted_at is not null)))
      or (n.type in ('draft.review', 'outbound.review') and not exists (select 1 from mail_drafts d where d.task_id = n.ref_id and d.status in ('pending_approval', 'failed'))))`);
  return r.rowCount ?? 0;
}

/**
 * Einziger Weg in die Meldungen. Löst je Person Regel N auf (Mail-Modus wird in die Meldung geschrieben, Chat „thread“) und
 * setzt Klasse und Bezug. KI-Agenten, deaktivierte Benutzer und der Auslöser bekommen keine Meldung. In-App gibt es immer.
 * Liefert die ID der neuen Meldung (null: übersprungen oder schon vorhanden).
 */
export async function notify(db: Db, n: NotifyInput): Promise<string | null> {
  if (n.actorId && n.userId === n.actorId) return null;
  const u = await db.maybeOne(`select id, org_id from users where id = $1 and active and kind <> 'agent'`, [n.userId]);
  if (!u) return null;
  const event = n.event ?? eventOfType(n.type);
  const taskId = n.taskId ?? (n.ref?.type === 'task' ? n.ref.id : null);
  const projectId = n.projectId ?? null;
  const rule = await resolveRule(db, { orgId: u.org_id, projectId, taskId: projectId ? taskId : null, userId: u.id, event });
  let dedupe = n.dedupeKey ?? null;
  if (event === 'progress' && n.progress) {
    const every = rule.value.every ?? 'milestones';
    if (every === 'done' && !n.progress.done) return null;
    if (every === 'milestones' && !n.progress.milestone && !n.progress.done) return null;
    if (every === 'daily') dedupe = `progress:${taskId}:${localParts(new Date()).date}`;
  }
  const row = await db.maybeOne(
    `insert into notifications (user_id, project_id, type, title, body, link, dedupe_key, event, ref_type, ref_id, mail, attach)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing returning id`,
    [u.id, projectId, n.type, n.title, n.body ?? null, n.link ?? null, dedupe, event, n.ref?.type ?? null, n.ref?.id ?? null, rule.value.mail, Boolean(n.attach)]
  );
  if (!row) return null;
  // Neuere Meldung derselben Art zum selben Arbeitspaket ersetzt ältere ungelesene (Zwischenstand, Eskalationsstufe, Entwurf zur Freigabe)
  if (n.ref?.type === 'task' && SUPERSEDING_TYPES.has(n.type)) {
    await db.query(`update notifications set read_at = now(), superseded_at = now() where user_id = $1 and type = $2 and ref_type = 'task' and ref_id = $3 and read_at is null and id <> $4`, [u.id, n.type, n.ref.id, row.id]);
  }
  // Chat „thread“ ohne eigenen Thread: Systembeitrag in der Direktnachricht des auslösenden Agenten an die Person
  if (rule.value.chat === 'thread' && !n.chatted && !n.thread && n.actorId) {
    const actor = await db.maybeOne(`select id, kind from users where id = $1 and kind = 'agent' and active`, [n.actorId]);
    if (actor) await systemMessage(db, { channelId: await dmChannel(db, u.org_id, actor.id, u.id), authorId: actor.id, body: postText(n), meta: { event, type: n.type, link: n.link ?? null } });
  }
  return row.id;
}

export async function notifyMany(db: Db, userIds: Iterable<string>, n: Omit<NotifyInput, 'userId'>, exclude?: string | null) {
  for (const u of new Set(userIds)) {
    if (u && u !== exclude) await notify(db, { ...n, userId: u });
  }
}

/** PL und Mitglieder mit einem Einzelrecht. */
export async function usersWithRight(db: Db, projectId: string, flag: 'can_approve' | 'can_finalize' | 'can_edit_plan'): Promise<string[]> {
  const rows = await db.query(`select m.user_id from project_members m join users u on u.id = m.user_id where m.project_id = $1 and (m.role = 'pl' or m.${flag}) and u.kind <> 'agent'`, [projectId]);
  return rows.rows.map((r: any) => r.user_id);
}

const postText = (n: { title: string; body?: string | null }) => `${n.title}${n.body ? `\n${n.body}` : ''}`.slice(0, 8000);

/** Direktnachricht zwischen zwei Benutzern (Kanal wird bei Bedarf angelegt). */
export async function dmChannel(db: Db, orgId: string, a: string, b: string): Promise<string> {
  const existing = await db.maybeOne(`select c.id from chat_channels c join chat_channel_members x on x.channel_id = c.id and x.user_id = $1 join chat_channel_members y on y.channel_id = c.id and y.user_id = $2 where c.kind = 'dm' and c.org_id = $3 limit 1`, [a, b, orgId]);
  if (existing) return existing.id;
  const c = await db.one(`insert into chat_channels (org_id, kind) values ($1,'dm') returning id`, [orgId]);
  await db.query(`insert into chat_channel_members (channel_id, user_id) values ($1,$2), ($1,$3)`, [c.id, a, b]);
  return c.id;
}

/** Projektkanal (wird bei Bedarf angelegt). */
export async function projectChannelId(db: Db, orgId: string, projectId: string): Promise<string> {
  return (await db.one(`insert into chat_channels (org_id, kind, project_id) values ($1,'project',$2) on conflict (project_id) where project_id is not null do update set kind = 'project' returning id`, [orgId, projectId])).id;
}

/**
 * Systemnachricht im Chat (kind 'system', meta = Systemkarte): nur aus Services, nie über die Chat-Route; löst keinen
 * Agentenlauf und keine Meldung aus. Ohne Auslöser ohne Autor.
 */
export async function systemMessage(db: Db, m: { channelId: string; threadId?: string | null; authorId?: string | null; body: string; meta?: Record<string, unknown> | null }): Promise<string> {
  const r = await db.one(`insert into chat_messages (channel_id, user_id, thread_id, body, kind, meta) values ($1,$2,$3,$4,'system',$5) returning id`, [m.channelId, m.authorId ?? null, m.threadId ?? null, m.body.slice(0, 8000), m.meta ? JSON.stringify(m.meta) : null]);
  return r.id;
}

export type CallerRole = 'mentioned' | 'participants' | 'requester' | 'escalation_contact';
export interface DispatchInput extends Omit<NotifyInput, 'userId' | 'event' | 'projectId'> {
  event: NotifyEvent;
  projectId: string;
  /** Empfänger, die die Aufrufstelle bestimmt (Eskalationsstufen, Kette, Freigabeberechtigte je Vorgang); die Regel ergänzt Rollen */
  users?: Iterable<string>;
  /** Werte für Rollen, die nur die Aufrufstelle kennt (Erwähnte, Beteiligte, Auftraggeber, Eskalationsperson der Stufe) */
  roles?: Partial<Record<CallerRole, string[]>>;
  /** Abweichender Typ, Titel oder Text je Rolle (z. B. Erwähnte: „hat dich erwähnt“); gilt vor anderen Rollen */
  variants?: Partial<Record<string, Partial<Pick<NotifyInput, 'type' | 'title' | 'body'>>>>;
  /** Die Aufrufstelle schreibt selbst ins Log */
  logged?: boolean;
}

/** Projekt und Arbeitspaket eines Ereignisses (Sichtbarkeit, eingeschränktes Teilprojekt, persönliches Projekt). */
export async function eventContext(db: Db, projectId: string, taskId?: string | null): Promise<{ project: any; task: any } | null> {
  const project = await db.maybeOne(`select id, org_id, key, personal, visibility, escalation from projects where id = $1`, [projectId]);
  if (!project) return null;
  const task = taskId ? await db.maybeOne(`select t.id, t.number, t.parent_id, t.subproject_id, t.created_by, coalesce(s.restricted, false) as restricted from tasks t left join subprojects s on s.id = t.subproject_id where t.id = $1 and t.project_id = $2`, [taskId, projectId]) : null;
  return { project, task };
}

/**
 * Meldung eines Ereignisses: löst die Regel der Klasse auf (Code → Org → Projekt → AP), bestimmt die Empfänger aus den
 * Rollen (Gruppen über groupRecipients) und den Empfängern der Aufrufstelle, entfernt Agenten, Inaktive, den Auslöser und
 * Personen ohne Sicht auf das AP (die Eskalationsperson der Stufe 3 bekommt die Meldung wie bisher auch ohne Projektzugriff)
 * und ruft je Person notify() auf. Danach die Kanäle des Ereignisses, je Ereignis einmal: Chat im Projektkanal (nie bei
 * eingeschränkten Teilprojekten und persönlichen Projekten) bzw. im Thread, Log (wenn die Aufrufstelle nicht selbst
 * schreibt) und die Seite „Entscheidungen und Meldungen“ (nicht bei eingeschränkten Teilprojekten). Liefert die Empfänger.
 */
export async function dispatch(db: Db, d: DispatchInput): Promise<string[]> {
  const ctx = await eventContext(db, d.projectId, d.taskId);
  if (!ctx) return [];
  const { project: p, task } = ctx;
  const rule = await resolveRule(db, { orgId: p.org_id, projectId: p.id, taskId: task?.id ?? null, event: d.event });
  // Schon verteilt (gleicher Schlüssel): Kanäle des Ereignisses nicht noch einmal
  const repeated = d.dedupeKey ? Boolean(await db.maybeOne(`select 1 from notifications where project_id = $1 and dedupe_key = $2 limit 1`, [p.id, d.dedupeKey])) : false;

  const { out, toProjectChannel } = await recipientsOf(db, { ...d, project: p, task, recipients: rule.value.recipients });
  const { users: _u, roles: _r, variants: _v, logged: _l, event, ...base } = d;
  for (const [uid, role] of out) await notify(db, { ...base, ...(d.variants?.[role] ?? {}), userId: uid, event, projectId: p.id, taskId: task?.id ?? null, thread: d.thread });

  if (!repeated) {
    const label = NOTIFY_EVENTS.find((e) => e.key === d.event)?.label ?? d.event;
    const meta = { event: d.event, type: d.type, link: d.link ?? null, ref: d.ref ?? null };
    const actor = d.actorId ? await db.maybeOne(`select id, kind from users where id = $1`, [d.actorId]) : null;
    if ((rule.value.chat === 'project' || toProjectChannel) && projectPolicy(p).channelPosts && !task?.restricted && !d.chatted) {
      await systemMessage(db, { channelId: await projectChannelId(db, p.org_id, p.id), authorId: actor?.id ?? null, body: postText(d), meta });
    } else if (d.thread && rule.value.chat !== 'off' && !d.chatted) {
      await systemMessage(db, { channelId: d.thread.channelId, threadId: d.thread.messageId, authorId: actor?.id ?? null, body: postText(d), meta });
    }
    if (rule.value.log && task && !d.logged) {
      const author = actor?.id ?? task.created_by ?? (await resolveProjectLead(db, p.id)).userId;
      if (author) await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'system')`, [task.id, author, `${label}: ${d.title}${d.body ? ` – ${d.body}` : ''}`.slice(0, 4000)]);
    }
    if (rule.value.doc && !task?.restricted) {
      const when = localParts(new Date());
      const code = task ? `${p.key}-${task.number} · ` : '';
      await appendDocEntry(db, rule.value.doc, `**${when.date.split('-').reverse().join('.')} ${when.time}** · ${label} · ${code}${d.title}${d.body ? `: ${d.body.replace(/\s+/g, ' ').slice(0, 500)}` : ''}`, actor?.kind === 'person' ? actor.id : null);
    }
  }
  return [...out.keys()];
}

/**
 * Empfänger eines Ereignisses (für dispatch und die Vorschau „Wer bekommt was?“): Empfänger der Aufrufstelle und Rollen der
 * Regel, ohne Agenten, Inaktive, den Auslöser und Personen ohne Sicht auf das AP; Ergebnis Person → Rolle.
 */
export async function recipientsOf(db: Db, d: Pick<DispatchInput, 'event' | 'users' | 'roles' | 'variants' | 'actorId'> & { project: any; task: any; recipients: string[] }): Promise<{ out: Map<string, string>; toProjectChannel: boolean }> {
  const p = d.project;
  const task = d.task;
  const seen = new Map<string, boolean>();
  const visible = async (uid: string, exempt: boolean): Promise<boolean> => {
    if (uid === d.actorId) return false;
    const key = `${uid}:${exempt}`;
    if (seen.has(key)) return seen.get(key)!;
    const u = await db.maybeOne(`select id from users where id = $1 and org_id = $2 and active and kind = 'person'`, [uid, p.org_id]);
    let ok = Boolean(u);
    if (ok && !exempt) {
      ok = p.visibility === 'org' || Boolean(await db.maybeOne(`select 1 from project_members where project_id = $1 and user_id = $2`, [p.id, uid]));
      if (ok && task) ok = await canSeeSubproject(db, uid, task.subproject_id);
    }
    seen.set(key, ok);
    return ok;
  };
  let toProjectChannel = false;
  const roleUsers = async (role: string): Promise<string[]> => {
    const caller = (d.roles as Record<string, string[] | undefined> | undefined)?.[role];
    if (caller) return caller;
    switch (role) {
      case 'responsible': return task ? [(await loadTask(db, task.id))?.responsible.userId ?? ''] : [];
      case 'parent_responsible': return task?.parent_id ? [(await loadTask(db, task.parent_id))?.responsible.userId ?? ''] : [];
      case 'subproject_lead': return task?.subproject_id ? [(await db.maybeOne(`select responsible_user_id from subprojects where id = $1`, [task.subproject_id]))?.responsible_user_id ?? ''] : [];
      case 'pl': return [(await resolveProjectLead(db, p.id)).userId ?? ''];
      case 'deputy_pl': return (await db.query(`select user_id from project_members where project_id = $1 and role = 'pl' and is_deputy`, [p.id])).rows.map((r: any) => r.user_id);
      case 'flag:can_approve': case 'flag:can_finalize': case 'flag:can_edit_plan': return usersWithRight(db, p.id, role.slice(5) as 'can_approve');
      case 'escalation_contact': return [p.escalation?.contactUserId ?? ''];
      case 'project_channel': toProjectChannel = true; return [];
      default: {
        const m = role.match(/^(group|user):(.+)$/);
        if (m?.[1] === 'group') return groupRecipients(db, { groupId: m[2], projectId: p.id, subprojectId: task?.subproject_id ?? null });
        if (m?.[1] === 'user') return [m[2]];
        return [];
      }
    }
  };

  const out = new Map<string, string>();
  const put = (uid: string, role: string) => { if (!out.has(uid) || (d.variants?.[role] && !d.variants?.[out.get(uid)!])) out.set(uid, role); };
  for (const uid of new Set(d.users ?? [])) if (uid && (await visible(uid, false))) put(uid, '');
  for (const entry of d.recipients) {
    // „a|b“: die erste Rolle, die jemanden erreicht
    for (const alt of entry.split('|')) {
      const ids: string[] = [];
      for (const uid of new Set(await roleUsers(alt))) if (uid && (await visible(uid, alt === 'escalation_contact'))) ids.push(uid);
      for (const uid of ids) put(uid, alt);
      if (ids.length) break;
    }
  }
  // Berichtswunsch am AP (Benutzer am AP, Zwischenstände): wer ihn gesetzt hat, bekommt die Zwischenstände
  if (d.event === 'progress' && task) {
    const subs = await db.query(`select user_id from notification_rules where task_id = $1 and user_id is not null and event = 'progress'`, [task.id]);
    for (const r of subs.rows) if (await visible(r.user_id, false)) put(r.user_id, 'subscriber');
  }
  return { out, toProjectChannel };
}
