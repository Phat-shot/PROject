import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { requireProject } from '../rights.js';
import { notify, notifyMany } from '../notify.js';
import { extractMentions } from '../tasks/mentions.js';

/**
 * Chat: ein Kanal je Projekt (Nachrichten, Antworten als Thread, @Erwähnungen) und Direktnachrichten
 * zwischen Personen des Mandanten. Ungelesen-Zähler über last_read_at je Kanal und Benutzer.
 */
export interface ChatMessage { id: string; channelId: string; userId: string; userName: string; threadId: string | null; body: string; mentions: string[]; replyCount: number; lastReplyAt: string | null; createdAt: string; editedAt: string | null; deleted: boolean }

const PAGE = 50;

export async function chatRoutes(app: FastifyInstance) {
  const db = app.db;

  const mapMessage = (r: any): ChatMessage => ({
    id: r.id, channelId: r.channel_id, userId: r.user_id, userName: r.user_name ?? '–', threadId: r.thread_id, body: r.deleted_at ? '' : r.body,
    mentions: typeof r.mentions === 'string' ? JSON.parse(r.mentions) : r.mentions ?? [], replyCount: Number(r.reply_count ?? 0), lastReplyAt: r.last_reply_at ?? null,
    createdAt: r.created_at, editedAt: r.edited_at ?? null, deleted: Boolean(r.deleted_at)
  });
  const MSG_SELECT = `select m.*, u.name as user_name,
      (select count(*)::int from chat_messages r where r.thread_id = m.id and r.deleted_at is null) as reply_count,
      (select max(r.created_at) from chat_messages r where r.thread_id = m.id and r.deleted_at is null) as last_reply_at
    from chat_messages m join users u on u.id = m.user_id`;

  /** Projektkanal holen oder anlegen; Mitglied des Projekts nötig. */
  async function projectChannel(user: any, projectId: string) {
    const m = await requireProject(db, user, projectId, 'reader');
    let c = await db.maybeOne(`select * from chat_channels where project_id = $1`, [projectId]);
    if (!c) c = await db.one(`insert into chat_channels (org_id, kind, project_id) values ($1,'project',$2) on conflict (project_id) where project_id is not null do update set kind = 'project' returning *`, [user.orgId, projectId]);
    return { channel: c, membership: m };
  }

  /** Zugriff auf einen Kanal: Projektkanal über Projektmitgliedschaft, DM über Kanalmitgliedschaft. */
  async function channelAccess(user: any, channelId: string) {
    const c = await db.maybeOne(`select * from chat_channels where id = $1 and org_id = $2`, [channelId, user.orgId]);
    if (!c) throw notFound('Kanal nicht gefunden');
    if (c.kind === 'project') {
      const m = await requireProject(db, user, c.project_id, 'reader');
      return { channel: c, isPl: m.role === 'pl' };
    }
    const cm = await db.maybeOne(`select 1 from chat_channel_members where channel_id = $1 and user_id = $2`, [c.id, user.id]);
    if (!cm) throw forbidden('Kein Teilnehmer dieses Chats');
    return { channel: c, isPl: false };
  }

  async function unreadCount(channelId: string, userId: string): Promise<number> {
    const r = await db.one(
      `select count(*)::int as n from chat_messages m where m.channel_id = $1 and m.deleted_at is null and m.user_id <> $2
         and m.created_at > coalesce((select last_read_at from chat_channel_members where channel_id = $1 and user_id = $2), '1970-01-01'::timestamptz)`,
      [channelId, userId]
    );
    return r.n;
  }

  async function markRead(channelId: string, userId: string) {
    await db.query(`insert into chat_channel_members (channel_id, user_id, last_read_at) values ($1,$2,now()) on conflict (channel_id, user_id) do update set last_read_at = now()`, [channelId, userId]);
  }

  async function listMessages(channelId: string, opts: { threadId?: string | null; before?: string | null }) {
    const rows = opts.threadId
      ? await db.query(`${MSG_SELECT} where m.channel_id = $1 and m.thread_id = $2 order by m.created_at asc`, [channelId, opts.threadId])
      : await db.query(`${MSG_SELECT} where m.channel_id = $1 and m.thread_id is null ${opts.before ? 'and m.created_at < $2' : ''} order by m.created_at desc limit ${PAGE + 1}`, opts.before ? [channelId, opts.before] : [channelId]);
    const list = rows.rows.map(mapMessage);
    if (opts.threadId) return { messages: list, hasMore: false };
    const hasMore = list.length > PAGE;
    return { messages: list.slice(0, PAGE).reverse(), hasMore };
  }

  // Projektkanal: Nachrichten (neueste Seite), Thread-Antworten über ?thread=
  app.get<{ Params: { id: string }; Querystring: { before?: string; thread?: string } }>('/projects/:id/chat', async (req) => {
    const user = requireUser(req);
    const { channel } = await projectChannel(user, req.params.id);
    const page = await listMessages(channel.id, { threadId: req.query.thread ?? null, before: req.query.before ?? null });
    const unread = await unreadCount(channel.id, user.id);
    if (!req.query.before && !req.query.thread) await markRead(channel.id, user.id);
    return { channel: { id: channel.id, kind: 'project', projectId: channel.project_id }, ...page, unread };
  });

  app.get<{ Params: { cid: string }; Querystring: { before?: string; thread?: string } }>('/chat/channels/:cid/messages', async (req) => {
    const user = requireUser(req);
    const { channel } = await channelAccess(user, req.params.cid);
    const page = await listMessages(channel.id, { threadId: req.query.thread ?? null, before: req.query.before ?? null });
    if (!req.query.before && !req.query.thread) await markRead(channel.id, user.id);
    return { channel: { id: channel.id, kind: channel.kind, projectId: channel.project_id }, ...page };
  });

  // Nachricht senden (optional als Antwort in einem Thread)
  app.post<{ Params: { cid: string }; Body: { body: string; threadId?: string | null } }>('/chat/channels/:cid/messages', async (req) => {
    const user = requireUser(req);
    if (user.kind === 'agent') throw forbidden('KI-Agenten schreiben nicht im Chat');
    const { channel } = await channelAccess(user, req.params.cid);
    const body = String(req.body?.body ?? '').trim();
    if (!body) throw badRequest('Nachricht leer');
    if (body.length > 8000) throw badRequest('Nachricht zu lang (max. 8000 Zeichen)');
    let threadId: string | null = null;
    if (req.body?.threadId) {
      const parent = await db.maybeOne(`select id, thread_id from chat_messages where id = $1 and channel_id = $2 and deleted_at is null`, [req.body.threadId, channel.id]);
      if (!parent) throw badRequest('Thread nicht gefunden');
      threadId = parent.thread_id ?? parent.id;
    }
    let mentions: string[] = [];
    const recipients = new Set<string>();
    if (channel.kind === 'project') {
      const members = await db.query(`select m.user_id, u.name from project_members m join users u on u.id = m.user_id where m.project_id = $1 and u.kind = 'person'`, [channel.project_id]);
      mentions = extractMentions(body, members.rows.map((r: any) => ({ userId: r.user_id, name: r.name })));
    } else {
      const others = await db.query(`select user_id from chat_channel_members where channel_id = $1 and user_id <> $2`, [channel.id, user.id]);
      for (const o of others.rows) recipients.add(o.user_id);
    }
    const r = await db.one(`insert into chat_messages (channel_id, user_id, thread_id, body, mentions) values ($1,$2,$3,$4,$5) returning *`, [channel.id, user.id, threadId, body, JSON.stringify(mentions)]);
    await markRead(channel.id, user.id);
    const snippet = body.slice(0, 160);
    if (channel.kind === 'project') {
      const p = await db.one(`select key from projects where id = $1`, [channel.project_id]);
      const link = `/projekte/${channel.project_id}/chat${threadId ? `?thread=${threadId}` : ''}`;
      await notifyMany(db, mentions, { projectId: channel.project_id, type: 'chat.mention', title: `${user.name} hat dich im Chat ${p.key} erwähnt`, body: snippet, link }, user.id);
      if (threadId) {
        // Thread-Beteiligte (Ersteller und Antwortende) ohne Erwähnte
        const parts = await db.query(`select distinct user_id from chat_messages where (id = $1 or thread_id = $1) and user_id <> $2`, [threadId, user.id]);
        const targets = parts.rows.map((x: any) => x.user_id as string).filter((u: string) => !mentions.includes(u));
        await notifyMany(db, targets, { projectId: channel.project_id, type: 'chat.reply', title: `Antwort im Chat ${p.key}`, body: `${user.name}: ${snippet}`, link, dedupeKey: null }, user.id);
      }
    } else {
      for (const to of recipients) await notify(db, { userId: to, projectId: null, type: 'chat.dm', title: `Nachricht von ${user.name}`, body: snippet, link: `/chat/${channel.id}` });
    }
    return { message: mapMessage({ ...r, user_name: user.name, reply_count: 0 }) };
  });

  app.patch<{ Params: { mid: string }; Body: { body: string } }>('/chat/messages/:mid', async (req) => {
    const user = requireUser(req);
    const m = await db.maybeOne(`select * from chat_messages where id = $1 and deleted_at is null`, [req.params.mid]);
    if (!m) throw notFound('Nachricht nicht gefunden');
    await channelAccess(user, m.channel_id);
    if (m.user_id !== user.id) throw forbidden('Nur eigene Nachrichten lassen sich bearbeiten');
    const body = String(req.body?.body ?? '').trim();
    if (!body) throw badRequest('Nachricht leer');
    const u = await db.one(`update chat_messages set body = $2, edited_at = now() where id = $1 returning *`, [m.id, body]);
    return { message: mapMessage({ ...u, user_name: user.name }) };
  });

  app.delete<{ Params: { mid: string } }>('/chat/messages/:mid', async (req) => {
    const user = requireUser(req);
    const m = await db.maybeOne(`select * from chat_messages where id = $1 and deleted_at is null`, [req.params.mid]);
    if (!m) throw notFound('Nachricht nicht gefunden');
    const { isPl } = await channelAccess(user, m.channel_id);
    if (m.user_id !== user.id && !isPl) throw forbidden('Nur eigene Nachrichten oder als PL löschen');
    await db.query(`update chat_messages set deleted_at = now() where id = $1`, [m.id]);
    return { ok: true };
  });

  app.post<{ Params: { cid: string } }>('/chat/channels/:cid/read', async (req) => {
    const user = requireUser(req);
    const { channel } = await channelAccess(user, req.params.cid);
    await markRead(channel.id, user.id);
    return { ok: true };
  });

  // Direktnachrichten: Liste der Gespräche mit Partner, letzter Nachricht und Ungelesen
  app.get('/chat/dm', async (req) => {
    const user = requireUser(req);
    const rows = await db.query(
      `select c.id, u.id as partner_id, u.name as partner_name, u.email as partner_email, u.active as partner_active,
         (select body from chat_messages m where m.channel_id = c.id and m.deleted_at is null order by m.created_at desc limit 1) as last_body,
         (select max(m.created_at) from chat_messages m where m.channel_id = c.id and m.deleted_at is null) as last_at
       from chat_channels c
       join chat_channel_members me on me.channel_id = c.id and me.user_id = $1
       join chat_channel_members o on o.channel_id = c.id and o.user_id <> $1
       join users u on u.id = o.user_id
       where c.kind = 'dm' and c.org_id = $2 order by last_at desc nulls last`,
      [user.id, user.orgId]
    );
    const conversations = [];
    for (const r of rows.rows) conversations.push({ channelId: r.id, partner: { id: r.partner_id, name: r.partner_name, email: r.partner_email, active: r.partner_active }, lastBody: r.last_body ? String(r.last_body).slice(0, 120) : null, lastAt: r.last_at, unread: await unreadCount(r.id, user.id) });
    return { conversations };
  });

  // Direktnachricht beginnen (oder bestehendes Gespräch holen)
  app.post<{ Body: { userId: string } }>('/chat/dm', async (req) => {
    const user = requireUser(req);
    if (user.kind === 'agent') throw forbidden('KI-Agenten chatten nicht');
    const other = await db.maybeOne(`select id, name, kind from users where id = $1 and org_id = $2 and active`, [req.body?.userId, user.orgId]);
    if (!other || other.id === user.id) throw badRequest('Gesprächspartner wählen');
    if (other.kind === 'agent') throw badRequest('KI-Agenten erreichst du über ihre Arbeitspakete, nicht per Chat');
    const existing = await db.maybeOne(
      `select c.id from chat_channels c join chat_channel_members a on a.channel_id = c.id and a.user_id = $1 join chat_channel_members b on b.channel_id = c.id and b.user_id = $2 where c.kind = 'dm' and c.org_id = $3 limit 1`,
      [user.id, other.id, user.orgId]
    );
    if (existing) return { channelId: existing.id, partner: { id: other.id, name: other.name } };
    const c = await db.one(`insert into chat_channels (org_id, kind) values ($1,'dm') returning id`, [user.orgId]);
    await db.query(`insert into chat_channel_members (channel_id, user_id) values ($1,$2), ($1,$3)`, [c.id, user.id, other.id]);
    return { channelId: c.id, partner: { id: other.id, name: other.name } };
  });

  // Ungelesen gesamt: Direktnachrichten und je Projekt (für Seitenleiste und Reiter)
  app.get('/chat/unread', async (req) => {
    const user = requireUser(req);
    const rows = await db.query(
      `select c.id, c.kind, c.project_id, count(m.id)::int as n
       from chat_channels c
       left join chat_channel_members me on me.channel_id = c.id and me.user_id = $1
       join chat_messages m on m.channel_id = c.id and m.deleted_at is null and m.user_id <> $1 and m.created_at > coalesce(me.last_read_at, '1970-01-01'::timestamptz)
       where c.org_id = $2 and ((c.kind = 'dm' and me.user_id is not null) or (c.kind = 'project' and exists (select 1 from project_members pm where pm.project_id = c.project_id and pm.user_id = $1)))
       group by c.id, c.kind, c.project_id`,
      [user.id, user.orgId]
    );
    let dm = 0; const projects: Record<string, number> = {};
    for (const r of rows.rows) { if (r.kind === 'dm') dm += r.n; else projects[r.project_id] = (projects[r.project_id] ?? 0) + r.n; }
    return { dm, projects, total: dm + Object.values(projects).reduce((a, b) => a + b, 0) };
  });

  // Ist der Benutzer Mitglied? (für DM-Partnerwahl: alle aktiven Personen des Mandanten)
  app.get('/chat/people', async (req) => {
    const user = requireUser(req);
    const rows = await db.query(`select id, name, email from users where org_id = $1 and active and kind = 'person' and id <> $2 order by name`, [user.orgId, user.id]);
    return { people: rows.rows.map((r: any) => ({ id: r.id, name: r.name, email: r.email })) };
  });

}
