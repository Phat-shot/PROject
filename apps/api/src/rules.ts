import type { EffectiveNotifyRule, NotificationRule, NotifyEvent, NotifyField, NotifyLevel, User } from '@projekttool/shared';
import { NOTIFY_DEFAULTS, NOTIFY_EVENTS, NOTIFY_FIELDS, NOTIFY_LEVEL_FIELDS, NOTIFY_LEVEL_LABEL, NOTIFY_ROLES, NOTIFY_TIMING } from '@projekttool/shared';
import type { Db } from './db.js';
import { audit } from './audit.js';
import { badRequest } from './errors.js';
import { mdToHtml, htmlToMd } from './docs/html.js';

/**
 * Benachrichtigungsregeln (Regel N): Ebenen Code (NOTIFY_DEFAULTS) → Org → Projekt → AP → Benutzer → Benutzer im Projekt →
 * Benutzer am AP. Je Feld getrennt: innerhalb einer Ebene geht die Zeile der Klasse der Zeile „*“ vor, jede gesetzte Angabe
 * überschreibt die vorige, eine leere erbt. Sperrt Org oder Projekt ein Feld, zählen tiefere Ebenen dafür nicht (die oberste
 * Sperre gewinnt). Benutzer setzen nur Chat und Mail, am AP dazu den Berichtswunsch (every für Zwischenstände).
 */
export type RuleLevel = Exclude<NotifyLevel, 'code'>;
export interface RuleScope { orgId: string; projectId?: string | null; taskId?: string | null; userId?: string | null }
const ORDER: RuleLevel[] = ['org', 'project', 'task', 'user', 'user_project', 'user_task'];
const CHANNELS: NotifyField[] = ['chat', 'mail', 'log', 'doc'];
export const DOC_PAGE_TITLE = 'Entscheidungen und Meldungen';

export const eventDef = (e: string) => NOTIFY_EVENTS.find((x) => x.key === e);

export function levelOf(r: { project_id: string | null; task_id: string | null; user_id: string | null }): RuleLevel {
  if (r.user_id) return r.task_id ? 'user_task' : r.project_id ? 'user_project' : 'user';
  return r.task_id ? 'task' : r.project_id ? 'project' : 'org';
}

const json = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);
function fieldOf(r: any, f: NotifyField): unknown {
  if (!r) return undefined;
  if (f === 'recipients') return json(r.recipients) ?? undefined;
  const src = CHANNELS.includes(f) ? json(r.channels) : json(r.timing);
  return src?.[f] ?? undefined;
}

/** Zeilen aller Ebenen, die für den Ort gelten (Benutzerzeilen nur für scope.userId). */
export async function loadRules(db: Db, s: RuleScope, event?: string): Promise<any[]> {
  const rows = await db.query(
    `select * from notification_rules where org_id = $1 and (project_id is null or project_id = $2::uuid) and (task_id is null or task_id = $3::uuid)
       and (user_id is null or user_id = $4::uuid) ${event ? 'and event in ($5, \'*\')' : ''}`,
    event ? [s.orgId, s.projectId ?? null, s.taskId ?? null, s.userId ?? null, event] : [s.orgId, s.projectId ?? null, s.taskId ?? null, s.userId ?? null]
  );
  return rows.rows;
}

/** Regel N für eine Klasse aus den Zeilen von loadRules: Wert, Herkunft und Sperre je Feld. */
export function resolveFrom(rows: any[], event: NotifyEvent): EffectiveNotifyRule {
  const def = eventDef(event)!;
  const value: any = { ...NOTIFY_DEFAULTS[event], recipients: [...NOTIFY_DEFAULTS[event].recipients] };
  const origin: EffectiveNotifyRule['origin'] = {};
  const locked: EffectiveNotifyRule['locked'] = {};
  for (const f of NOTIFY_FIELDS) {
    if (value[f] !== undefined) origin[f] = 'code';
    for (const lvl of ORDER) {
      if (!NOTIFY_LEVEL_FIELDS[lvl].includes(f) || (lvl === 'user_task' && f === 'every' && event !== 'progress')) continue;
      const ev = rows.find((r) => r.event === event && levelOf(r) === lvl);
      const star = rows.find((r) => r.event === '*' && levelOf(r) === lvl);
      const v = fieldOf(ev, f) ?? fieldOf(star, f);
      if (v !== undefined) { value[f] = v; origin[f] = lvl; }
      if ((lvl === 'org' || lvl === 'project') && (ev?.locked?.includes(f) || star?.locked?.includes(f))) { locked[f] = lvl; break; }
    }
  }
  // Fragearten: der Chat ist die Frage selbst; Chat-Meldungen haben keinen eigenen Chat-Kanal
  if (def.fixedChat) { value.chat = 'thread'; origin.chat = 'code'; }
  if (def.noChat) { value.chat = 'off'; origin.chat = 'code'; }
  return { event, value, origin, locked };
}

export async function resolveRule(db: Db, s: RuleScope & { event: NotifyEvent }): Promise<EffectiveNotifyRule> {
  return resolveFrom(await loadRules(db, s, s.event), s.event);
}

/** Alle Klassen für einen Ort (Oberfläche: geerbte Werte mit Herkunft, Sperren). */
export async function resolveAll(db: Db, s: RuleScope): Promise<EffectiveNotifyRule[]> {
  const rows = await loadRules(db, s);
  return NOTIFY_EVENTS.map((e) => resolveFrom(rows, e.key));
}

export function mapRule(r: any): NotificationRule {
  return {
    id: r.id, projectId: r.project_id, taskId: r.task_id, userId: r.user_id, event: r.event, recipients: json(r.recipients) ?? null,
    channels: json(r.channels) ?? {}, timing: json(r.timing) ?? {}, locked: r.locked ?? [], updatedBy: r.updated_by ?? null, updatedByName: r.updated_by_name ?? null, updatedAt: r.updated_at
  };
}

/** Regeln genau einer Ebene (ohne Vererbung), für die Matrix. */
export async function rulesAt(db: Db, s: RuleScope): Promise<NotificationRule[]> {
  const rows = await db.query(
    `select r.*, u.name as updated_by_name from notification_rules r left join users u on u.id = r.updated_by
     where r.org_id = $1 and r.project_id is not distinct from $2::uuid and r.task_id is not distinct from $3::uuid and r.user_id is not distinct from $4::uuid order by r.event`,
    [s.orgId, s.projectId ?? null, s.taskId ?? null, s.userId ?? null]
  );
  return rows.rows.map(mapRule);
}

export interface RuleInput { event: string; recipients?: string[] | null; channels?: Record<string, unknown>; timing?: Record<string, unknown>; locked?: string[] }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Empfängerrolle prüfen: bekannte Rolle, group:<id> bzw. user:<id> (Person) des Mandanten; „a|b“ = a, sonst b. */
async function checkRole(db: Db, orgId: string, entry: unknown): Promise<string> {
  const v = String(entry ?? '').trim();
  const parts = v.split('|');
  if (!v || parts.length > 3) throw badRequest(`Empfänger „${v}“ ungültig`);
  for (const p of parts) {
    if (NOTIFY_ROLES.some((r) => r.key === p)) continue;
    const m = p.match(/^(group|user):(.+)$/);
    if (!m || !UUID.test(m[2])) throw badRequest(`Empfänger „${p}“ unbekannt (Rollen: ${NOTIFY_ROLES.map((r) => r.key).join(', ')}, group:<id>, user:<id>)`);
    const ok = m[1] === 'group'
      ? await db.maybeOne(`select 1 from groups where id = $1 and org_id = $2`, [m[2], orgId])
      : await db.maybeOne(`select 1 from users where id = $1 and org_id = $2 and kind = 'person'`, [m[2], orgId]);
    if (!ok) throw badRequest(`Empfänger „${p}“: ${m[1] === 'group' ? 'Gruppe' : 'Person'} nicht gefunden`);
  }
  return v;
}

/** Seite „Entscheidungen und Meldungen“ des Projekts (Kanal Doku): vorhandene aus einer Projektregel, sonst neu im Ordner „Allgemein“. */
export async function ensureDocPage(db: Db, projectId: string, userId: string): Promise<string> {
  const known = await db.query(`select channels->>'doc' as doc from notification_rules where project_id = $1 and task_id is null and user_id is null and channels ? 'doc'`, [projectId]);
  for (const r of known.rows) {
    if (r.doc && r.doc !== 'false' && UUID.test(r.doc) && (await db.maybeOne(`select 1 from doc_pages where id = $1 and project_id = $2 and deleted_at is null`, [r.doc, projectId]))) return r.doc;
  }
  const folder = await db.maybeOne(`select id from doc_folders where project_id = $1 and parent_id is null order by (name = 'Allgemein') desc, position limit 1`, [projectId]);
  const md = `Einträge des Systems nach den Benachrichtigungsregeln (Kanal Doku), neueste unten.\n`;
  const p = await db.one(`insert into doc_pages (project_id, folder_id, title, content_md, content_html, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$6) returning id`, [projectId, folder?.id ?? null, DOC_PAGE_TITLE, md, mdToHtml(md), userId]);
  await db.query(`insert into doc_page_versions (page_id, version, title, content_md, content_html, status, saved_by) values ($1,1,$2,$3,$4,'draft',$5)`, [p.id, DOC_PAGE_TITLE, md, mdToHtml(md), userId]);
  return p.id;
}

/** Eintrag auf der Seite „Entscheidungen und Meldungen“ (nicht auf finalen oder gelöschten Seiten). */
export async function appendDocEntry(db: Db, pageId: string, line: string, userId: string | null): Promise<boolean> {
  const page = await db.maybeOne(`select * from doc_pages where id = $1 and deleted_at is null`, [pageId]);
  if (!page || page.status === 'final') return false;
  const html = `${(page.content_html ?? mdToHtml(page.content_md)).replace(/\s+$/, '')}\n${mdToHtml(line)}`;
  const u = await db.one(`update doc_pages set content_html = $2, content_md = $3, version = version + 1, updated_by = coalesce($4, updated_by), updated_at = now() where id = $1 returning *`, [page.id, html, htmlToMd(html), userId]);
  await db.query(`insert into doc_page_versions (page_id, version, title, content_md, content_html, status, saved_by) values ($1,$2,$3,$4,$5,$6,$7)`, [u.id, u.version, u.title, u.content_md, u.content_html, u.status, userId]);
  return true;
}

/**
 * Regeln einer Ebene setzen (je Klasse eine Zeile, ersetzt die bisherige; eine leere Zeile wird gelöscht). Prüft Felder je
 * Ebene, Werte, Empfänger und Sperren der Ebenen darüber; Doku „true“ wird zur Seite des Projekts (wird bei Bedarf angelegt).
 */
export async function setRules(db: Db, user: User, level: RuleLevel, s: RuleScope, items: RuleInput[]): Promise<void> {
  if (!Array.isArray(items) || !items.length) throw badRequest('Regeln als Liste');
  if (items.length > 40) throw badRequest('Höchstens 40 Regeln je Aufruf');
  const allowed = NOTIFY_LEVEL_FIELDS[level];
  const userLevel = level.startsWith('user');
  // Sperren der Ebenen darüber (Org für alles; Projekt für AP und Benutzer im Projekt/am AP)
  const above = (await loadRules(db, { orgId: s.orgId, projectId: level === 'user' ? null : s.projectId })).filter((r) => {
    const l = levelOf(r);
    return l === 'org' ? level !== 'org' : l === 'project' ? ['task', 'user_project', 'user_task'].includes(level) : false;
  });
  const writes: { event: string; recipients: string[] | null; channels: Record<string, unknown>; timing: Record<string, unknown>; locked: string[] }[] = [];
  let docPage: string | undefined; // eine Seite je Projekt, auch wenn ein Aufruf mehrere Klassen einschaltet
  for (const it of items) {
    const event = String(it?.event ?? '');
    const def = eventDef(event);
    if (event !== '*' && !def) throw badRequest(`Unbekannte Ereignisklasse „${event}“`);
    const label = event === '*' ? 'alle Klassen' : def!.label;
    const recipients = it.recipients === undefined || it.recipients === null ? null : it.recipients;
    const channels: Record<string, unknown> = {};
    const timing: Record<string, unknown> = {};
    const set: NotifyField[] = [];
    for (const [src, keys, out] of [[it.channels, CHANNELS, channels], [it.timing, NOTIFY_TIMING, timing]] as const) {
      for (const [k, v] of Object.entries(src ?? {})) {
        if (!keys.includes(k as NotifyField)) throw badRequest(`Unbekanntes Feld „${k}“`);
        if (v !== undefined && v !== null) { out[k] = v; set.push(k as NotifyField); }
      }
    }
    if (recipients) set.push('recipients');
    for (const f of set) {
      if (!allowed.includes(f)) throw badRequest(`${label}: „${f}“ ist auf der Ebene ${NOTIFY_LEVEL_LABEL[level]} nicht einstellbar`);
      if (level === 'user_task' && f === 'every' && event !== 'progress') throw badRequest('Berichtswunsch (every) nur für Zwischenstände');
      const lock = above.find((r) => (r.event === event || r.event === '*') && r.locked?.includes(f));
      if (lock) throw badRequest(`${label}: „${f}“ ist gesperrt (${NOTIFY_LEVEL_LABEL[levelOf(lock)]})`);
    }
    if (recipients) {
      if (!Array.isArray(recipients) || recipients.length > 12) throw badRequest('Empfänger als Liste (höchstens 12)');
      for (const [i, r] of recipients.entries()) recipients[i] = await checkRole(db, s.orgId, r);
    }
    if ('chat' in channels) {
      if (def?.fixedChat || def?.noChat) throw badRequest(`${label}: Chat ist fest (${def.fixedChat ? 'die Frage selbst' : 'Chat-Meldung'})`);
      if (!(userLevel ? ['off', 'thread'] : ['off', 'thread', 'project']).includes(String(channels.chat))) throw badRequest(userLevel ? 'Chat: off oder thread' : 'Chat: off, thread oder project');
    }
    if ('mail' in channels && !['off', 'now', 'digest'].includes(String(channels.mail))) throw badRequest('Mail: off, now oder digest');
    if ('log' in channels && typeof channels.log !== 'boolean') throw badRequest('Log: true oder false');
    if ('doc' in channels) {
      if (channels.doc === true) channels.doc = docPage ??= await ensureDocPage(db, s.projectId!, user.id);
      else if (channels.doc !== false) throw badRequest('Doku: true oder false');
    }
    for (const k of ['remindH', 'escalateH', 'expireH']) if (k in timing && !(Number.isInteger(timing[k]) && Number(timing[k]) >= 1 && Number(timing[k]) <= 2000)) throw badRequest(`${k}: ganze Stunden von 1 bis 2000`);
    if ('every' in timing && !['each', 'milestones', 'daily', 'done'].includes(String(timing.every))) throw badRequest('every: each, milestones, daily oder done');
    const locked = [...new Set((it.locked ?? []).map(String))];
    if (locked.length && level !== 'org' && level !== 'project') throw badRequest('Sperren nur auf Org- und Projektebene');
    for (const f of locked) if (!allowed.includes(f as NotifyField)) throw badRequest(`Sperre „${f}“ auf dieser Ebene nicht möglich`);
    writes.push({ event, recipients, channels, timing, locked });
  }
  for (const w of writes) {
    await db.query(`delete from notification_rules where org_id = $1 and project_id is not distinct from $2::uuid and task_id is not distinct from $3::uuid and user_id is not distinct from $4::uuid and event = $5`, [s.orgId, s.projectId ?? null, s.taskId ?? null, s.userId ?? null, w.event]);
    if (!w.recipients && !Object.keys(w.channels).length && !Object.keys(w.timing).length && !w.locked.length) continue;
    await db.query(
      `insert into notification_rules (org_id, project_id, task_id, user_id, event, recipients, channels, timing, locked, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [s.orgId, s.projectId ?? null, s.taskId ?? null, s.userId ?? null, w.event, w.recipients ? JSON.stringify(w.recipients) : null, JSON.stringify(w.channels), JSON.stringify(w.timing), w.locked, user.id]
    );
  }
  await audit(db, { orgId: s.orgId, projectId: s.projectId ?? null, userId: user.id, action: 'notify.rule.set', objectType: 'notification_rule', objectId: s.taskId ?? s.projectId ?? s.userId ?? s.orgId, details: { level, taskId: s.taskId ?? null, userId: s.userId ?? null, rules: writes } });
}
