import type { Db } from '../db.js';
import { audit } from '../audit.js';
import { notify } from '../notify.js';
import { canSeeSubproject, visibleSubprojectSql } from '../rights.js';
import { aiConfigFor, complete, parseJson } from './client.js';
import { aiAllowed } from './policy.js';
import { queueAgentRun } from './agentEvents.js';
import { styleText } from './agent.js';
import { AGENT_SHEET, CHAT_RULES } from './sheet.js';
import { EFFECTIVE_JOINS, EFFECTIVE_RESPONSIBLE_SQL } from './plan.js';
import { isInternal } from '../outbound.js';
import { answerQuestion, isSmallTalk, type QuestionRow } from '../questions.js';
import { search as knowledgeSearch } from './knowledge.js';
import { SQL } from '../projectPolicy.js';
import { COMMAND_TYPES, allowedCommands, commandsText, postResults, runCommands, senderRole, type ChatCommand, type CommandCtx } from './chatCommands.js';
import { effectiveAgentPolicy, policyText } from './agentPolicy.js';
import { projectAccount } from '../mail/accounts.js';
import { webAvailable } from './web.js';

/**
 * KI-Agent im Chat: antwortet auf Direktnachrichten, auf @Erwähnungen im Projektkanal und in Threads, in denen er
 * schon geantwortet hat. Jede Antwort hat genau ein Thema, das das System bestimmt (resolveChatScope), nicht das Modell:
 * im Projektkanal das Projekt des Kanals (im Thread dazu das Arbeitspaket der Thread-Wurzel), in Direktnachrichten die
 * genannten Kennungen bzw. Projekte, sonst das zuletzt im Verlauf genannte, ausdrücklich „über alle Projekte“ alle
 * gemeinsamen; ohne Anhaltspunkt fragt er bei mehreren gemeinsamen Projekten nach (ohne LLM-Aufruf). Der Prompt enthält
 * nur Arbeitspakete des Themas, dazu Kennzahlen, die das System per SQL berechnet. Auskunft gibt er nur über seine eigenen
 * Arbeitspakete und nur aus Projekten, die die fragende Person sehen darf. Enthält die Nachricht etwas für eines seiner
 * Arbeitspakete, hält er es dort im Log fest (danach prüft er das Arbeitspaket wie bei einem Kommentar neu). Behauptet die
 * Antwort in der ersten Person, etwas sei angelegt, gesendet oder erledigt, ohne dass eine Notiz dahintersteht, ersetzt das
 * System den Satz (claimCheck). Jeder LLM-Lauf zählt gegen das Tagesbudget.
 * KI-Freigaben (agent.chat) gelten für Absender und Agent; in Direktnachrichten ohne Projekt, danach antwortet der Agent
 * nur aus Projekten, in denen der Absender „KI nutzen“ hat oder PL ist und beide freigegeben sind. Gesperrt antwortet er
 * nur auf Direktnachrichten und Erwähnungen (nicht auf jede Folgenachricht im Thread); im Projektkanal ohne Namen und Notiz
 * persönlicher Regeln, die volle Begründung bekommt der Absender als Meldung.
 */
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['reply', 'onTopic', 'notes', 'answers', 'commands'],
  properties: {
    reply: { type: 'string', description: 'Antwort im Chat: kurz, im vorgegebenen Schreibstil, ohne Unterschrift' },
    onTopic: { type: 'boolean', description: 'true, wenn die Antwort das Thema (Projekt oder Arbeitspaket) betrifft; false bei Gruß, Smalltalk, allgemeinen Fragen oder Bitten ohne Projektbezug' },
    commands: {
      type: 'array', description: 'Befehle, die das System prüft und ausführt (höchstens 5, davon höchstens 1 order): nur wenn die Nachricht sie verlangt und der Absender laut Kontext darf; sonst leer',
      items: { type: 'object', additionalProperties: false, required: ['type', 'ref', 'text', 'title', 'parent', 'subproject', 'dueDate', 'deliverables', 'every', 'level', 'mode', 'depth', 'reason', 'mail'], properties: {
        type: { type: 'string', enum: ['order', 'note', 'pause', 'resume', 'stop', 'priority', 'approve', 'reject', 'policy', 'report', 'refer'] },
        ref: { type: 'string', description: 'note/pause/resume/stop/priority/approve/reject/policy/report: Kennung des Arbeitspakets (z. B. WEB-12); sonst leer' },
        text: { type: 'string', description: 'order: der Auftrag im Wortlaut (Beschreibung); note: Information fürs Log; refer: Vorschlag für die PL; sonst leer' },
        title: { type: 'string', description: 'order: kurzer Titel des Arbeitspakets bzw. der Aufgabe; sonst leer' },
        parent: { type: 'string', description: 'order: Kennung des Über-AP, wenn eine Aufgabe darunter entstehen soll; sonst leer' },
        subproject: { type: 'string', description: 'order: Name des Teilprojekts oder leer' },
        dueDate: { type: 'string', description: 'order: Termin YYYY-MM-DD oder leer' },
        deliverables: { type: 'array', items: { type: 'string' }, description: 'order: Lieferergebnisse als Tasks; sonst leer' },
        every: { type: 'string', description: 'order/report: Zwischenstände each, milestones, daily oder done; sonst leer' },
        level: { type: 'string', description: 'priority: niedrig, normal, hoch oder kritisch; sonst leer' },
        mode: { type: 'string', description: 'policy: auto, confirm_critical oder confirm_all; sonst leer' },
        depth: { type: 'string', description: 'policy: Denktiefe quick (schnell), standard oder deep (gründlich); sonst leer' },
        reason: { type: 'string', description: 'stop/reject: Grund; sonst leer' },
        mail: { type: 'boolean', description: 'order/report: Zwischenstände und Lieferung auch per Mail an den Auftraggeber' }
      } }
    },
    notes: {
      type: 'array', description: 'Log-Einträge an deinen Arbeitspaketen (taskId aus der Liste), wenn die Nachricht eine Information dazu enthält; sonst leer',
      items: { type: 'object', additionalProperties: false, required: ['taskId', 'text'], properties: { taskId: { type: 'string' }, text: { type: 'string' } } }
    },
    answers: {
      type: 'array', description: 'Beantwortet die Nachricht eine deiner offenen Fragen aus dem Kontext: questionId und Kurzfassung der Antwort; sonst leer',
      items: { type: 'object', additionalProperties: false, required: ['questionId', 'text'], properties: { questionId: { type: 'string' }, text: { type: 'string' } } }
    }
  }
};

const cut = (s: string | null | undefined, n: number) => { const t = (s ?? '').trim(); return t.length > n ? t.slice(0, n) + ' …' : t; };
const hhmm = (d: string | Date) => new Date(d).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
const d10 = (v: any) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : '');

/** personal = persönliches Projekt des Absenders (ohne Kontext), general = kein Projektbezug (Gruß ohne persönliches Projekt) */
export type ChatScopeHow = 'channel' | 'mentioned' | 'history' | 'all' | 'ask' | 'personal' | 'general';
export interface ScopeProject { id: string; key: string; name: string }
/** Thema einer Chat-Nachricht: Projekte und Arbeitspakete, aus denen der Kontext kommt, und wie es bestimmt wurde. */
export interface ChatScope {
  how: ChatScopeHow;
  /** Projekte des Themas; bei ask leer (Auswahl steht in projects) */
  projectIds: string[];
  /** Arbeitspakete des Themas (Kennungen aus Nachricht, Thread-Wurzel oder Verlauf); leer = das ganze Projekt */
  taskIds: string[];
  /** Kennungen der Arbeitspakete des Themas, z. B. WEB-12 */
  refs: string[];
  /** Kennungen bzw. Kürzel aus der Nachricht, zu denen hier nichts gesagt wird (Projekt nicht sichtbar oder einer gesperrt) */
  hidden: string[];
  /** Gemeinsame, beidseitig freie Projekte (Direktnachricht) bzw. das Kanalprojekt */
  projects: ScopeProject[];
}

/** „über alle Projekte“, „insgesamt“: Thema sind alle gemeinsamen Projekte. */
const ALL_RE = /über alle projekte|alle[n]? (meine[n]? |unsere[n]? |gemeinsamen )?projekte[n]?|insgesamt|projektübergreifend/i;
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Kennungen (KEY-12, auch klein geschrieben) und Projekte (Kürzel als Wort in Großschreibung oder Projektname) in einem
 * Text, geprüft gegen die bekannten Projekte des Mandanten. Ein Kürzel direkt vor „-Nummer“ zählt nur als Kennung.
 */
function findMentions(text: string, projects: ScopeProject[]): { refs: { project: ScopeProject; number: number }[]; projects: ScopeProject[] } {
  const refs: { project: ScopeProject; number: number }[] = [];
  const found = new Map<string, ScopeProject>();
  if (!projects.length) return { refs, projects: [] };
  const keys = [...projects].sort((a, b) => b.key.length - a.key.length).map((p) => escRe(p.key));
  for (const m of text.matchAll(new RegExp(`(?<![A-Za-z0-9-])(${keys.join('|')})-(\\d{1,6})(?![0-9])`, 'gi'))) {
    const p = projects.find((x) => x.key === m[1].toUpperCase());
    if (p) { refs.push({ project: p, number: Number(m[2]) }); found.set(p.id, p); }
  }
  for (const p of projects) {
    // Kürzel nur mit Buchstaben als Wort werten (ein rein numerisches Kürzel wäre jede Jahreszahl)
    if ((/[A-Z]/.test(p.key) && new RegExp(`(?<![A-Za-z0-9-])${escRe(p.key)}(?![A-Za-z0-9-])`).test(text)) || new RegExp(`(?<![\\p{L}\\p{N}])${escRe(p.name)}(?![\\p{L}\\p{N}])`, 'iu').test(text)) found.set(p.id, p);
  }
  return { refs, projects: [...found.values()] };
}

/**
 * Thema der Nachricht nach Agenten-Konzept Abschnitt 6 (ohne offene Fragen, die kommen mit P5). Projektkanal: das Projekt
 * des Kanals, im Thread zusätzlich das Arbeitspaket aus der Kennung der Thread-Wurzel (höchstens 14 Tage alt). Direktnachricht,
 * in dieser Reihenfolge: Kennungen oder Projektname/-kürzel in der Nachricht (mentioned), ausdrücklich „über alle Projekte“
 * (all), zuletzt genanntes Arbeitspaket/Projekt des Verlaufs ohne Zeitfenster (history), sonst bei genau einem gemeinsamen
 * Projekt dieses (all), bei mehreren Rückfrage (ask). Gemeinsam heißt: beide Mitglied, Absender PL oder „KI nutzen“, beide per
 * KI-Freigabe (agent.chat) frei. Kennungen aus anderen Projekten oder aus Teilprojekten, die einer von beiden nicht sieht,
 * landen in hidden; der Agent sagt dazu nichts, auch keinen Titel.
 */
export async function resolveChatScope(db: Db, q: { channel: any; message: { id: string; body: string; thread_id?: string | null }; history: { id: string; body: string }[]; senderId: string; agent: { id: string; org_id: string; name?: string } }, now = new Date()): Promise<ChatScope> {
  const all: ScopeProject[] = (await db.query(`select id, key, name from projects where org_id = $1 order by key`, [q.agent.org_id])).rows;
  const channelProject = q.channel.kind === 'project' ? all.find((p) => p.id === q.channel.project_id) ?? null : null;
  /** Arbeitspaket zu einer Kennung; null, wenn es fehlt oder einer von beiden es nicht sieht (eingeschränktes Teilprojekt). */
  const taskOf = async (r: { project: ScopeProject; number: number }): Promise<{ id: string; project_id: string } | null | undefined> => {
    const t = await db.maybeOne(`select t.id, t.project_id, t.subproject_id from tasks t where t.project_id = $1 and t.number = $2 and t.deleted_at is null`, [r.project.id, r.number]);
    if (!t) return undefined;
    if (channelProject) return t.subproject_id && (await db.maybeOne(`select 1 from subprojects where id = $1 and restricted`, [t.subproject_id])) ? null : t;
    return (await canSeeSubproject(db, q.senderId, t.subproject_id)) && (await canSeeSubproject(db, q.agent.id, t.subproject_id)) ? t : null;
  };
  const ref = (r: { project: ScopeProject; number: number }) => `${r.project.key}-${r.number}`;

  if (channelProject) {
    const scope: ChatScope = { how: 'channel', projectIds: [channelProject.id], taskIds: [], refs: [], hidden: [], projects: [channelProject] };
    const texts = [q.message.body];
    // Thread: die Kennung der Thread-Wurzel (höchstens 14 Tage alt) bestimmt das Arbeitspaket mit
    if (q.message.thread_id) {
      const root = await db.maybeOne(`select body from chat_messages where id = $1 and deleted_at is null and created_at > $2::timestamptz - interval '14 days'`, [q.message.thread_id, now]);
      if (root) texts.push(String(root.body));
    }
    for (const text of texts) {
      for (const r of findMentions(text, all).refs) {
        if (r.project.id !== channelProject.id) { if (!scope.hidden.includes(ref(r))) scope.hidden.push(ref(r)); continue; }
        const t = await taskOf(r);
        if (t === null) { if (!scope.hidden.includes(ref(r))) scope.hidden.push(ref(r)); continue; }
        if (t && !scope.taskIds.includes(t.id)) { scope.taskIds.push(t.id); scope.refs.push(ref(r)); }
      }
    }
    return scope;
  }

  // Direktnachricht: gemeinsame, beidseitig freie Projekte (Absender PL oder „KI nutzen“, KI-Freigaben für beide)
  const common: ScopeProject[] = [];
  const candidates = await db.query(
    `select p.id, p.key, p.name from projects p
       join project_members a on a.project_id = p.id and a.user_id = $1
       join project_members s on s.project_id = p.id and s.user_id = $2 and (s.role = 'pl' or s.can_use_ai)
     where p.org_id = $3 and p.status = 'active' order by p.key`, [q.agent.id, q.senderId, q.agent.org_id]);
  for (const p of candidates.rows as ScopeProject[]) {
    if ((await aiAllowed(db, { userId: q.senderId, projectId: p.id, feature: 'agent.chat' })).allowed && (await aiAllowed(db, { userId: q.agent.id, projectId: p.id, feature: 'agent.chat', budget: false })).allowed) common.push(p);
  }
  const isCommon = (id: string) => common.some((p) => p.id === id);
  /** Erwähnungen eines Texts auflösen: erlaubte Projekte und Arbeitspakete, verborgene Kennungen bzw. Kürzel. */
  const resolve = async (text: string) => {
    const m = findMentions(text, all);
    const out = { projectIds: [] as string[], taskIds: [] as string[], refs: [] as string[], hidden: [] as string[] };
    const add = (list: string[], v: string) => { if (!list.includes(v)) list.push(v); };
    for (const r of m.refs) {
      if (!isCommon(r.project.id)) { add(out.hidden, ref(r)); continue; }
      const t = await taskOf(r);
      if (t === null) { add(out.hidden, ref(r)); continue; }
      add(out.projectIds, r.project.id);
      if (t) { add(out.taskIds, t.id); add(out.refs, ref(r)); }
    }
    for (const p of m.projects) { if (isCommon(p.id)) add(out.projectIds, p.id); else if (!m.refs.some((r) => r.project.id === p.id)) add(out.hidden, p.key); }
    return out;
  };
  const mine = await resolve(q.message.body);
  if (mine.projectIds.length || mine.hidden.length) return { how: 'mentioned', ...mine, projects: common.filter((p) => mine.projectIds.includes(p.id)) };
  if (ALL_RE.test(q.message.body)) return { how: 'all', projectIds: common.map((p) => p.id), taskIds: [], refs: [], hidden: [], projects: common };
  // Ohne Kontext nur das persönliche Projekt des Absenders (er ist dort PL, der Agent Mitglied): Infos und Doku von dort, nichts aus anderen Projekten
  const personal = common.length ? (await db.query(`select p.id from projects p join project_members m on m.project_id = p.id and m.user_id = $1 and m.role = 'pl' where ${SQL.isPersonal('p')} and p.id = any($2::uuid[])`, [q.senderId, common.map((p) => p.id)])).rows.map((r: any) => r.id as string) : [];
  const personalScope = (): ChatScope => ({ how: 'personal', projectIds: personal, taskIds: [], refs: [], hidden: [], projects: common.filter((p) => personal.includes(p.id)) });
  // Gruß oder Kurzmeldung ohne Inhalt: kein Projektbezug, auch nicht aus dem Verlauf
  if (isSmallTalk(q.message.body, q.agent.name ? [q.agent.name] : [])) return personal.length ? personalScope() : { how: 'general', projectIds: [], taskIds: [], refs: [], hidden: [], projects: common };
  // Mit persönlichem Projekt gilt ohne Nennung immer dieses; ein anderes Projekt nennt man mit Kennung, Kürzel oder Name
  if (personal.length) return personalScope();
  // Verlauf (neueste zuerst): das zuletzt genannte Arbeitspaket bzw. Projekt, ohne Zeitfenster
  for (const h of q.history) {
    if (h.id === q.message.id) continue;
    const r = await resolve(String(h.body ?? ''));
    if (r.projectIds.length) return { how: 'history', projectIds: r.projectIds, taskIds: r.taskIds, refs: r.refs, hidden: [], projects: common.filter((p) => r.projectIds.includes(p.id)) };
  }
  if (common.length > 1) return { how: 'ask', projectIds: [], taskIds: [], refs: [], hidden: [], projects: common };
  return { how: 'all', projectIds: common.map((p) => p.id), taskIds: [], refs: [], hidden: [], projects: common };
}

/** Heutiges Datum in Europe/Berlin (YYYY-MM-DD) und der Sonntag dieser Woche, für „fällig diese Woche“. */
export function berlinWeek(now: Date): { today: string; sunday: string } {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', weekday: 'short' }).format(now));
  const [y, m, d] = today.split('-').map(Number);
  return { today, sunday: new Date(Date.UTC(y, m - 1, d + ((7 - dow) % 7))).toISOString().slice(0, 10) };
}

export interface KeyFigures { open: number; active: number; dueWeek: number; overdue: number; blocked: number; waiting: number }
/**
 * Kennzahlen des Themas, vom System per SQL berechnet (das Modell zählt nie selbst): offen = nicht erledigt; in Arbeit =
 * aktive Spalte (nicht Geplant, Zurückgestellt oder erledigt); fällig diese Woche = Termin von heute bis Sonntag (Europe/Berlin);
 * überfällig = Termin vor heute; blockiert; wartet = Wartezustand des Agenten gesetzt. Ohne taskIds zählen die Arbeitspakete
 * der Projekte (keine Aufgaben), mit taskIds diese Arbeitspakete und ihre Aufgaben. Sichtbarkeit wie der Kontext: im Projektkanal
 * ohne eingeschränkte Teilprojekte, in Direktnachrichten nur, was der Absender sieht.
 */
export async function keyFigures(db: Db, q: { projectIds: string[]; taskIds?: string[] | null; viewerId: string | null; now?: Date }): Promise<KeyFigures> {
  const { today, sunday } = berlinWeek(q.now ?? new Date());
  const ids = q.taskIds?.length ? q.taskIds : null;
  const r = await db.one(
    `select count(*) filter (where not c.is_done)::int as open,
            count(*) filter (where c.kind = 'active')::int as active,
            count(*) filter (where not c.is_done and t.due_date >= $3::date and t.due_date <= $4::date)::int as due_week,
            count(*) filter (where not c.is_done and t.due_date < $3::date)::int as overdue,
            count(*) filter (where not c.is_done and t.blocked)::int as blocked,
            count(*) filter (where not c.is_done and t.agent_wait is not null)::int as waiting
     from tasks t join board_columns c on c.id = t.column_id
     where t.project_id = any($1::uuid[]) and t.deleted_at is null and t.archived_at is null
       and (case when $2::uuid[] is null then t.parent_id is null else t.id = any($2::uuid[]) or t.parent_id = any($2::uuid[]) end)
       and ${q.viewerId ? visibleSubprojectSql(5) : `(t.subproject_id is null or not exists (select 1 from subprojects s where s.id = t.subproject_id and s.restricted))`}`,
    q.viewerId ? [q.projectIds, ids, today, sunday, q.viewerId] : [q.projectIds, ids, today, sunday]
  );
  return { open: r.open, active: r.active, dueWeek: r.due_week, overdue: r.overdue, blocked: r.blocked, waiting: r.waiting };
}
export const keyFiguresLine = (label: string, k: KeyFigures) => `Kennzahlen zu ${label}: offen ${k.open} · in Arbeit ${k.active} · fällig diese Woche ${k.dueWeek} · überfällig ${k.overdue} · blockiert ${k.blocked} · wartet ${k.waiting}`;

/** Verben, mit denen eine Notiz (Log-Eintrag) beschrieben wird: zulässig, wenn eine Notiz ausgeführt wurde. */
const CLAIM_LOG = 'vermerkt|eingetragen|notiert|festgehalten|hinterlegt|protokolliert|dokumentiert';
/** Verben für Aktionen, die es im Chat nicht gibt: nie zulässig. */
const CLAIM_ACT = 'angelegt|erstellt|gesendet|geschickt|verschickt|versendet|verschoben|zugewiesen|erledigt|abgeschlossen|freigegeben|gesetzt';
/**
 * claimCheck (Agenten-Konzept 5 und 10): Sätze in der ersten Person, die behaupten, etwas sei angelegt, eingetragen, vermerkt,
 * gesendet, erledigt oder freigegeben („Ich habe … gesendet“, „habe ich … angelegt“, „wurde von mir … erstellt“), ersetzt das
 * System durch „Das konnte ich nicht ausführen: …“. Deterministisch, ohne Kommas/Nebensätze dazwischen (kein „ich habe gesehen,
 * dass …“) und ohne Verneinung („ich habe nichts gesendet“). Mit ausgeführter Notiz bleiben Sätze über Vermerken bzw. Eintragen stehen.
 */
export function claimCheck(reply: string, noted: boolean, acted = false): { text: string; replaced: string[] } {
  const verbs = [acted ? '' : CLAIM_ACT, noted ? '' : CLAIM_LOG].filter(Boolean).join('|');
  if (!verbs) return { text: reply, replaced: [] };
  const inner = '[^.!?\\n,;:]*?';
  const patterns = [
    new RegExp(`\\b(ich|wir)\\b${inner}\\b(habe|hab|haben)\\b${inner}\\b(${verbs})\\b`, 'i'),
    new RegExp(`\\b(habe|hab|haben)\\s+(ich|wir)\\b${inner}\\b(${verbs})\\b`, 'i'),
    new RegExp(`\\b(ist|wurde|sind|wurden)\\b${inner}\\bvon (mir|uns)\\b${inner}\\b(${verbs})\\b`, 'i')
  ];
  const claims = (s: string) => patterns.some((p) => { const m = s.match(p); return Boolean(m) && !/\b(nicht|nichts|nie|kein\w*)\b/i.test(m![0]); });
  const replaced: string[] = [];
  const text = reply.replace(/[^.!?\n]+[.!?]*/g, (s) => {
    const core = s.trim();
    if (!core || !claims(core)) return s;
    replaced.push(core);
    return `${s.match(/^\s*/)![0]}Das konnte ich nicht ausführen: „${core.replace(/[.!?]+$/, '')}“.`;
  });
  return { text, replaced };
}

export interface AgentChatResult { status: 'ok' | 'error' | 'skipped'; reply?: string; notes?: { taskId: string; text: string }[]; scope?: ChatScope; error?: string; results?: { type: string; status: string; text: string }[] }

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
    ? await db.query(`select m.id, m.body, m.created_at, m.kind, u.name, u.id as uid from chat_messages m left join users u on u.id = m.user_id where (m.id = $1 or m.thread_id = $1) and m.deleted_at is null order by m.created_at desc limit 20`, [threadId])
    : await db.query(`select m.id, m.body, m.created_at, m.kind, u.name, u.id as uid from chat_messages m left join users u on u.id = m.user_id where m.channel_id = $1 and m.thread_id is null and m.deleted_at is null order by m.created_at desc limit 16`, [channel.id]);
  // Thema der Nachricht (Abschnitt 6 des Agenten-Konzepts): bestimmt das System, nicht das Modell
  const scope = await resolveChatScope(db, { channel, message: msg, history: history.rows, senderId: msg.user_id, agent }, now);
  // Gruß oder Kurzmeldung ohne Inhalt: keine Rückmeldung auf offene Fragen, keine Notizen, keine Bezugszeile
  const small = isSmallTalk(msg.body, [agent.name]);
  const scopeText = `${scope.refs.length ? scope.refs.join(', ') : scope.projects.map((p) => p.key).join(', ') || '–'} (${scope.how})`;
  /** Antwort ohne LLM-Aufruf (zählt nicht gegen das Budget): als übersprungener Lauf mit Begründung protokolliert. */
  const direct = async (reply: string, logged: string): Promise<AgentChatResult> => {
    await post(reply);
    await db.query(`insert into agent_runs (org_id, agent_user_id, project_id, task_id, trigger, status, reasoning, actions, error, channel_id) values ($1,$2,$3,null,'chat','skipped',$4,$5,$6,$7)`,
      [agent.org_id, agent.id, channel.project_id ?? null, `Chat mit ${msg.user_name} · Thema: ${scopeText}`, JSON.stringify([{ type: 'chat_reply', text: cut(reply, 300) }]), logged.slice(0, 500), channel.id]);
    return { status: 'skipped', reply, scope, error: logged };
  };
  // Kennungen oder Projekte, die der Absender nicht sieht oder in denen einer gesperrt ist: nichts dazu, auch kein Titel
  if (scope.how === 'mentioned' && !scope.projectIds.length) return direct('Dazu kann ich dir hier nichts sagen.', `Thema ohne gemeinsame Freigabe: ${scope.hidden.join(', ')}`);
  // Kein gemeinsames, beidseitig freies Projekt: Hilfe und Hinweis statt Schweigen (ohne LLM-Aufruf)
  if (!project && (scope.how === 'all' || scope.how === 'general') && !scope.projects.length) {
    return direct(`Hallo ${msg.user_name.split(' ')[0]}, wir haben noch kein gemeinsames Projekt, in dem ich für dich arbeiten darf. Ich kann Arbeitspakete vorantreiben, Rückfragen klären, Termine vorschlagen, Mails zu Aufgaben beantworten und Doku pflegen. Dafür nimmt mich die Projektleitung als Mitglied oder Projektagent ins Projekt auf und gibt dir dort „KI nutzen“; danach frag mich einfach hier oder im Projektkanal mit @${agent.name}.`, 'kein gemeinsames Projekt: Hilfe und Hinweis');
  }
  // Mehrere gemeinsame Projekte ohne Anhaltspunkt: Rückfrage mit den Projektnamen, keine Inhalte
  if (scope.how === 'ask') {
    const names = scope.projects.map((p) => `${p.name} (${p.key})`);
    return direct(`Zu welchem Projekt? ${names.slice(0, -1).join(', ')} oder ${names.at(-1)}?`, 'Rückfrage: Projekt nicht eindeutig');
  }

  // Eigene offene Arbeitspakete zum Thema: im Projektkanal ohne eingeschränkte Teilprojekte (alle Mitglieder lesen mit), in
  // Direktnachrichten nur Teilprojekte, die die fragende Person sieht; genannte Arbeitspakete begrenzen die Liste auf sich und ihre Aufgaben
  const taskIds = scope.taskIds.length ? scope.taskIds : null;
  const tasks = scope.projectIds.length ? await db.query(
    `select t.id, t.project_id, t.subproject_id, t.number, t.title, t.due_date, t.agent_wait, t.blocked, t.blocked_reason, c.name as column_name, p.key, pt.title as parent_title,
       (select string_agg(x.body, ' | ' order by x.created_at desc) from (select body, created_at from task_comments where task_id = t.id order by created_at desc limit 3) x) as recent
     from tasks t join board_columns c on c.id = t.column_id join projects p on p.id = t.project_id ${EFFECTIVE_JOINS}
     where (${EFFECTIVE_RESPONSIBLE_SQL}) = $1 and t.deleted_at is null and t.archived_at is null and not c.is_done and p.status = 'active'
       and t.project_id = any($2::uuid[]) and ($3::uuid[] is null or t.id = any($3::uuid[]) or t.parent_id = any($3::uuid[]))
       and ${project ? `(t.subproject_id is null or not exists (select 1 from subprojects s where s.id = t.subproject_id and s.restricted))` : visibleSubprojectSql(4)}
     order by t.due_date nulls last limit 40`,
    project ? [agent.id, scope.projectIds, taskIds] : [agent.id, scope.projectIds, taskIds, msg.user_id]
  ) : { rows: [] as any[] };
  // Direktnachricht: nur Arbeitspakete, für die der Absender intern ist (Regel E); die Freigaben beider Seiten prüft schon das Thema
  if (!project) {
    const inner: any[] = [];
    for (const t of tasks.rows as any[]) if (await isInternal(db, { projectId: t.project_id, subprojectId: t.subproject_id, userId: msg.user_id })) inner.push(t);
    tasks.rows = inner;
  }
  const known = new Map<string, any>(tasks.rows.map((t: any) => [t.id, t]));
  // Genannte Arbeitspakete, für die der Agent nicht zuständig ist: nur der Stand, kein Log (Sichtbarkeit hat das Thema geprüft)
  const others = scope.taskIds.filter((id) => !known.has(id));
  const named = others.length ? await db.query(`select t.id, t.number, t.title, t.due_date, t.blocked, t.blocked_reason, c.name as column_name, c.is_done, p.key, coalesce(u.name, t.responsible_email) as resp from tasks t join board_columns c on c.id = t.column_id join projects p on p.id = t.project_id left join users u on u.id = t.responsible_user_id where t.id = any($1::uuid[]) and t.deleted_at is null order by p.key, t.number`, [others]) : { rows: [] as any[] };
  // Kennzahlen je Thema (bei „alle“ je Projekt eine Zeile), vom System berechnet
  const viewerId = project ? null : msg.user_id;
  const figures: string[] = [];
  if (scope.taskIds.length) figures.push(keyFiguresLine(scope.refs.join(', '), await keyFigures(db, { projectIds: scope.projectIds, taskIds: scope.taskIds, viewerId, now })));
  else if (scope.how !== 'general') for (const p of scope.projects) figures.push(keyFiguresLine(p.key, await keyFigures(db, { projectIds: [p.id], viewerId, now })));
  const HOW: Record<ChatScopeHow, string> = { channel: 'Projekt dieses Kanals', mentioned: 'in der Nachricht genannt', history: 'zuletzt im Verlauf genannt', all: scope.projects.length > 1 ? 'alle gemeinsamen Projekte, ausdrücklich gefragt' : 'einziges gemeinsames Projekt', ask: '', personal: 'persönliches Projekt des Absenders, weil die Nachricht kein anderes Projekt nennt', general: '' };
  const theme = scope.how === 'general'
    ? `kein Projektbezug in der Nachricht: antworte allgemein, ohne Inhalte, Stände oder Kennzahlen aus Projekten; frag bei Bedarf, worum es geht`
    : scope.projects.length
      ? `${scope.refs.length ? `Arbeitspaket ${scope.refs.join(', ')} in ` : ''}Projekt ${scope.projects.map((p) => `${p.key} „${p.name}“`).join(', ')} (${HOW[scope.how]})`
      : `kein gemeinsames Projekt mit ${msg.user_name}; du kannst nur allgemein antworten`;
  // Persönliches Projekt ohne weiteren Kontext: passende Doku-Seiten (Suche nach der Nachricht, sonst die neuesten) als Wissensquelle
  let personalDocs = '';
  if (scope.how === 'personal' && scope.projectIds.length) {
    const found = await knowledgeSearch(db, { projectId: scope.projectIds[0], agentId: agent.id, query: msg.body, viewerId: msg.user_id, maxTitles: 8, maxExcerpts: 3 });
    const pages = found.pages.length ? found.pages : (await db.query(`select p.id, p.title, p.status, f.name as folder from doc_pages p left join doc_folders f on f.id = p.folder_id where p.project_id = $1 and p.deleted_at is null order by p.updated_at desc limit 8`, [scope.projectIds[0]])).rows.map((p: any) => ({ id: p.id, title: p.title, status: p.status, folder: p.folder ?? null, excerpt: null as string | null }));
    personalDocs = pages.length ? `Doku im persönlichen Projekt (${found.pages.length ? 'passend zur Nachricht' : 'neueste Seiten'}; Auskunft nur daraus und aus den Arbeitspaketen unten):\n${pages.map((p) => `- „${p.title}“ (${p.folder ?? 'ohne Ordner'}, ${p.status})${p.excerpt ? `\n  ${cut(p.excerpt, 600)}` : ''}`).join('\n')}\n` : '';
  }
  const system = `${AGENT_SHEET}\n\n${CHAT_RULES}\n\n# Du\nDu bist „${agent.name}“, KI-Agent im Projekttool. ${styleText(agent.persona)}`;
  // Steht die Nachricht schon als Rückmeldung im Log eines Arbeitspakets (Antwort auf eine Frage des Agenten), keine zweite Notiz dazu
  const logged = await db.query(
    `select c.task_id, p.key, t.number from task_comments c join tasks t on t.id = c.task_id join projects p on p.id = t.project_id
     where c.user_id = $1 and c.source = 'chat' and c.created_at >= $2::timestamptz - interval '2 minutes' and c.body like $3`,
    [msg.user_id, msg.created_at, `Rückmeldung per Chat an ${agent.name}: %`]
  );
  const loggedRefs: string[] = logged.rows.map((x: any) => `${x.key}-${x.number}`);
  for (const x of logged.rows) known.delete(x.task_id);
  // Offene Fragen des Agenten an den Absender (DM) bzw. im Thread (Regel F Schritt 2): das Modell ordnet Antworten zu
  const openQs = await db.query(
    `select q.id, q.body, q.created_at, p.key, t.number from questions q join projects p on p.id = q.project_id left join tasks t on t.id = q.task_id
     where q.asked_by = $1 and q.status = 'open' and (q.channel_id = $2) and (q.addressee_id = $3 or q.addressee_id is null) order by q.created_at desc limit 8`, [agent.id, channel.id, msg.user_id]);
  // Steuerung (Konzept 7): Projekt für Befehle, Rolle und Rechte des Absenders, Policy, offene Bestätigungen, weitere APs, Fähigkeiten
  const cmdProject = project ?? (scope.how !== 'general' && scope.projects.length === 1 ? scope.projects[0] : null);
  const scopeTask = scope.taskIds.length === 1 ? await db.maybeOne(`select * from tasks where id = $1`, [scope.taskIds[0]]) : null;
  const role = cmdProject ? await senderRole(db, msg.user_id, cmdProject.id, scopeTask) : 'none';
  const policy = cmdProject ? await effectiveAgentPolicy(db, { agentId: agent.id, projectId: cmdProject.id, taskId: scopeTask?.id ?? null }) : null;
  const allowed = allowedCommands(role, policy);
  const approvals = scope.projectIds.length ? await db.query(`select q.id, p.key, t.number, t.title, q.body from questions q join projects p on p.id = q.project_id left join tasks t on t.id = q.task_id where q.asked_by = $1 and q.kind = 'approval' and q.status = 'open' and q.project_id = any($2::uuid[]) order by q.created_at desc limit 8`, [agent.id, scope.projectIds]) : { rows: [] as any[] };
  const otherAps = scope.projectIds.length ? await db.query(
    `select t.number, t.title, p.key, s.name as sp, coalesce(u.name, t.responsible_email) as resp from tasks t join projects p on p.id = t.project_id join board_columns c on c.id = t.column_id left join subprojects s on s.id = t.subproject_id left join users u on u.id = t.responsible_user_id
     where t.project_id = any($1::uuid[]) and t.parent_id is null and t.deleted_at is null and t.archived_at is null and not c.is_done and not (t.id = any($2::uuid[]))
       and ${project ? `(t.subproject_id is null or not exists (select 1 from subprojects x where x.id = t.subproject_id and x.restricted))` : `${visibleSubprojectSql(3)} and ${visibleSubprojectSql(4)}`} order by p.key, t.position limit 40`,
    project ? [scope.projectIds, [...known.keys()]] : [scope.projectIds, [...known.keys()], msg.user_id, agent.id]) : { rows: [] as any[] };
  const agentMember = cmdProject ? await db.maybeOne(`select agent_can_mail from project_members where project_id = $1 and user_id = $2`, [cmdProject.id, agent.id]) : null;
  const canMail = Boolean(agentMember?.agent_can_mail) && Boolean(cmdProject && (await projectAccount(db, cmdProject.id)));
  const web = cmdProject ? await webAvailable(db, { agentId: agent.id, agentName: agent.name, projectId: cmdProject.id, cfg, now }) : null;
  const ctxCmd: CommandCtx = { db, agent, sender: { id: msg.user_id, name: msg.user_name, orgId: agent.org_id }, project: cmdProject, projects: scope.projects, channelId: channel.id, threadId, messageId: msg.id, now, policy };
  const prompt = `Jetzt: ${hhmm(now)}
Gespräch: ${project ? `Projektkanal ${project.key} „${project.name}“${threadId ? ' (Thread)' : ''}` : `Direktnachricht mit ${msg.user_name}`}
Thema: ${theme}
Absender: ${msg.user_name} – ${commandsText(role, allowed, policy)}${cmdProject ? '' : scope.projects.length > 1 ? ' · Projekt für Aufträge nicht eindeutig: bei order das Über-AP (parent) nennen oder nachfragen' : ''}
${policy ? `Agenten-Policy${scopeTask ? ` für ${scope.refs[0]}` : ` im Projekt ${cmdProject!.key}`}: ${policyText(policy)} Aufträge im Chat: ${policy.chatOrders} (${policy.origin.chatOrders}).\n` : ''}${approvals.rows.length ? `Offene Bestätigungen von dir (approve/reject zeigt die Karte; die Person entscheidet per Klick):
${approvals.rows.map((q: any) => `- ${q.key}${q.number ? `-${q.number}` : ''} „${q.title ?? ''}“: ${cut(q.body.replace(/\n/g, ' '), 200)}`).join('\n')}
` : ''}Fähigkeiten: Mails ${canMail ? 'direkt (Außenprüfung, erster Kontakt als Entwurf)' : 'nur als Entwurf zur Freigabe'}; Online-Recherche ${web?.ok ? `freigegeben (heute noch ${web.left} Suchen)` : `nicht freigegeben${web && !web.ok ? ` (${web.reason})` : ''}`}.
${personalDocs}${openQs.rows.length ? `Deine offenen Fragen hier (questionId für answers; nur zur Zuordnung, nicht ungefragt erwähnen):\n${openQs.rows.map((q: any) => `- ${q.key}${q.number ? `-${q.number}` : ''} seit ${hhmm(q.created_at)}: ${cut(q.body, 240)} (questionId ${q.id})`).join('\n')}\n` : ''}${figures.length ? `${figures.join('\n')}\n` : ''}Deine offenen Arbeitspakete zum Thema:
${tasks.rows.map((t: any) => `- ${t.key}-${t.number} „${t.title}“${t.parent_title ? ` (Aufgabe in „${t.parent_title}“)` : ''} · ${t.column_name}${t.due_date ? ` · fällig ${d10(t.due_date)}` : ''}${t.blocked ? ` · blockiert: ${t.blocked_reason ?? ''}` : ''}${t.agent_wait ? ` · du wartest auf: ${t.agent_wait.reason}` : ''} (taskId ${t.id})${t.recent ? `\n  Log: ${cut(t.recent, 500)}` : ''}`).join('\n') || '– keine –'}
${otherAps.rows.length ? `Weitere offene Arbeitspakete im Thema (Kennung · Titel · Teilprojekt · zuständig; für order parent/ref und gegen Dubletten):
${otherAps.rows.map((t: any) => `- ${t.key}-${t.number} · ${cut(t.title, 60)}${t.sp ? ` · ${t.sp}` : ''}${t.resp ? ` · ${t.resp}` : ''}`).join('\n')}
` : ''}${named.rows.length ? `Genannte Arbeitspakete, für die du nicht zuständig bist (nur Stand, kein Log):\n${named.rows.map((t: any) => `- ${t.key}-${t.number} „${t.title}“ · ${t.column_name}${t.is_done ? ' (erledigt)' : ''}${t.due_date ? ` · fällig ${d10(t.due_date)}` : ''}${t.resp ? ` · zuständig ${t.resp}` : ''}${t.blocked ? ` · blockiert: ${t.blocked_reason ?? ''}` : ''}`).join('\n')}\n` : ''}Verlauf (älteste zuerst):
${[...history.rows].reverse().map((h: any) => `${hhmm(h.created_at)} ${h.kind === 'system' ? 'System' : h.uid === agent.id ? 'Du' : h.name}: ${cut(h.body, 600)}`).join('\n')}
${small ? `\nDie letzte Nachricht ist nur ein Gruß oder eine Kurzmeldung ohne inhaltliche Rückmeldung: Sie beantwortet keine deiner Fragen (keine answers, keine notes)${openQs.rows.length ? ', deine offene Frage bleibt offen' : ''}. Antworte wie eine Kollegin, kurz und freundlich, ohne Projektinhalte und ohne Erinnerung an offene Fragen (onTopic false).` : scope.how === 'history' ? `\nDas Thema stammt aus dem Verlauf (${scope.refs[0] ?? scope.projects[0]?.key}); betrifft deine Antwort es nicht, setze onTopic false.` : ''}${loggedRefs.length ? `\nDie letzte Nachricht steht bereits als Rückmeldung im Log von ${loggedRefs.join(', ')}; du prüfst das Arbeitspaket gleich erneut. Bestätige kurz und beantworte, was darüber hinaus gefragt ist; keine weitere Notiz dazu.` : ''}
Antworte auf die letzte Nachricht von ${msg.user_name}.`;
  try {
    const r = await complete(cfg, fetchFn, { system, prompt, maxTokens: cfg.enableThinking === true ? 5200 : 1200, schema: SCHEMA });
    const j = parseJson<{ reply?: string; notes?: { taskId: string; text: string }[]; answers?: { questionId: string; text: string }[]; commands?: ChatCommand[] }>(r.text);
    // Befehle: prüfen und ausführen, bevor gepostet wird; die Karte zeigt das tatsächliche Ergebnis
    const cmds = (Array.isArray(j.commands) ? j.commands : []).filter((c) => c && COMMAND_TYPES.includes(c.type)).slice(0, 5);
    const results = cmds.length ? await runCommands(ctxCmd, cmds) : [];
    const acted = results.some((x) => x.status === 'ok' && x.type !== 'note');
    const notedCmd = results.some((x) => x.status === 'ok' && x.type === 'note');
    const notes = small ? [] : (Array.isArray(j.notes) ? j.notes : []).filter((n) => known.has(n.taskId) && String(n.text ?? '').trim()).slice(0, 3);
    // Antworten auf offene Fragen (nur eigene, hier gestellte): Frage schließen, Log, Lauf am Arbeitspaket (Anlass answer)
    const answers = small ? [] : (Array.isArray(j.answers) ? j.answers : []).filter((a) => openQs.rows.some((q: any) => q.id === a.questionId)).slice(0, 3);
    for (const a of answers) {
      const q = await db.maybeOne<QuestionRow>(`select * from questions where id = $1 and status = 'open'`, [a.questionId]);
      if (q) await answerQuestion(db, q, { source: 'chat', userId: msg.user_id, text: String(a.text ?? '').trim() || msg.body, messageId: msg.id, now });
    }
    // claimCheck: Behauptungen ohne ausgeführte Aktion ersetzt das System; Kennungen ohne Freigabe bekommen die feste Absage voran
    const checked = claimCheck(String(j.reply ?? '').trim() || 'Dazu kann ich gerade nichts sagen.', notes.length > 0 || notedCmd, acted);
    // Bezugszeile setzt das System: nur bei einem Thema aus dem Verlauf und nur, wenn die Antwort es betrifft (onTopic; fehlt das Feld, gilt ja)
    const onTopic = (j as any).onTopic !== false && !small;
    const refLine = scope.how === 'history' && onTopic && scope.refs[0] && !/^Zu\s/.test(checked.text) ? `Zu ${scope.refs[0]}: ` : '';
    const reply = `${scope.hidden.length ? `Zu ${scope.hidden.join(', ')} kann ich dir hier nichts sagen. ` : ''}${refLine}${checked.text}`;
    await post(reply);
    for (const n of notes) {
      await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [n.taskId, agent.id, `Aus dem Chat (${msg.user_name}): ${cut(n.text, 1000)}`]);
      queueAgentRun(n.taskId, 'comment');
    }
    const actions: Record<string, unknown>[] = [{ type: 'chat_reply', text: cut(reply, 300) }, ...notes.map((n) => ({ type: 'chat_note', taskId: n.taskId, text: cut(n.text, 300) })), ...answers.map((a) => ({ type: 'chat_answer', questionId: a.questionId, text: cut(a.text, 300) }))];
    if (checked.replaced.length) actions.push({ type: 'claim_check', replaced: checked.replaced.length, text: cut(checked.replaced.join(' | '), 300) });
    for (const x of results) actions.push({ type: `cmd_${x.type}`, status: x.status, text: cut(x.text, 300), taskId: x.taskId ?? null });
    const run = await db.one(`insert into agent_runs (org_id, agent_user_id, project_id, task_id, trigger, status, reasoning, actions, input_tokens, output_tokens, channel_id) values ($1,$2,$3,null,'chat','ok',$4,$5,$6,$7,$8) returning id`,
      [agent.org_id, agent.id, channel.project_id ?? null, `Chat mit ${msg.user_name} · Thema: ${scopeText}`, JSON.stringify(actions), r.inputTokens, r.outputTokens, channel.id]);
    if (results.length) await postResults(ctxCmd, results, run.id);
    await audit(db, { orgId: agent.org_id, projectId: channel.project_id ?? null, userId: agent.id, action: 'agent.chat', objectType: 'chat_channel', objectId: channel.id, details: { runId: run.id, scope: scope.how, notes: notes.length, commands: results.map((x) => `${x.type}:${x.status}`), claimsReplaced: checked.replaced.length, profile: cfg.name, model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens } });
    return { status: 'ok', reply, notes, scope, results };
  } catch (e: any) {
    const err = String(e?.message ?? e).slice(0, 300);
    await db.query(`insert into agent_runs (org_id, agent_user_id, project_id, task_id, trigger, status, error, channel_id) values ($1,$2,$3,null,'chat','error',$4,$5)`, [agent.org_id, agent.id, channel.project_id ?? null, err, channel.id]);
    await post('Ich konnte gerade nicht antworten (Fehler beim KI-Dienst). Bitte später noch einmal versuchen.');
    return { status: 'error', error: err };
  }
}
