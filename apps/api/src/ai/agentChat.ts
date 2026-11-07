import type { Db } from '../db.js';
import { audit } from '../audit.js';
import { notify } from '../notify.js';
import { canSeeSubproject, visibleSubprojectSql } from '../rights.js';
import { aiConfigFor, completeJson } from './client.js';
import { aiAllowed } from './policy.js';
import { queueAgentRun } from './agentEvents.js';
import { styleText } from './agent.js';
import { AGENT_SHEET, ASSISTANT_RULES, CHAT_RULES, DATA_RULE } from './sheet.js';
import { EFFECTIVE_JOINS, EFFECTIVE_RESPONSIBLE_SQL, calendarText } from './plan.js';
import { isInternal } from '../outbound.js';
import { answerQuestion, isSmallTalk, type QuestionRow } from '../questions.js';
import { fileHitsText, mailHitsText, search as knowledgeSearch, searchSources, searchText, tokens, type SearchHit } from './knowledge.js';
import { SQL } from '../projectPolicy.js';
import { COMMAND_TYPES, allowedCommands, commandsText, postResults, runCommands, senderRole, type ChatCommand, type CommandCtx } from './chatCommands.js';
import { effectiveAgentPolicy, folderAccessMap, policyText } from './agentPolicy.js';
import { projectAccount } from '../mail/accounts.js';
import { webAvailable } from './web.js';
import { recordFeedback } from './feedback.js';
import { systemMessage } from '../notify.js';
import type { ChatChoice, ChatIntent, StatusStyle } from '@projekttool/shared';
import { defaultStatusStyle } from '@projekttool/shared';
import { statusItems } from './takeTasks.js';

/**
 * KI-Agent im Chat: antwortet auf Direktnachrichten, auf @Erwähnungen im Projektkanal und in Threads, in denen er
 * schon geantwortet hat. Jede Antwort hat genau ein Thema, das das System bestimmt (resolveChatScope), nicht das Modell:
 * im Projektkanal das Projekt des Kanals (im Thread dazu das Arbeitspaket der Thread-Wurzel), in Direktnachrichten die
 * genannten Kennungen bzw. Projekte, sonst das zuletzt im Verlauf genannte, ausdrücklich „über alle Projekte“ alle
 * gemeinsamen. Dazu die Absicht (intent): allgemein (kein Projektbezug: Wissensfrage, Formulierungshilfe, Frage zum Tool),
 * ein Projekt oder persönlicher Assistent (persönliches Projekt des Absenders), regelbasiert mit Sicherheit sure/guess/unsure.
 * Ist sie unsicher, fragt er ohne LLM-Aufruf nach: Agentennachricht plus Systemkarte „choices“ mit Knöpfen (Projekte,
 * persönlich, allgemein); die Antwort (Knopf oder Markerwort) markiert die Karte als chosen und beantwortet die
 * Ursprungsnachricht mit festem Thema. Bei einer Annahme (guess) nennt er sie einmal je Thread im Halbsatz. Der Prompt enthält
 * nur Arbeitspakete des Themas, dazu Kennzahlen, die das System per SQL berechnet. Auskunft gibt er nur über seine eigenen
 * Arbeitspakete und nur aus Projekten, die die fragende Person sehen darf. Enthält die Nachricht etwas für eines seiner
 * Arbeitspakete, hält er es dort im Log fest (danach prüft er das Arbeitspaket wie bei einem Kommentar neu). Behauptet die
 * Antwort in der ersten Person, etwas sei angelegt, gesendet oder erledigt, ohne dass eine Notiz dahintersteht, ersetzt das
 * System den Satz (claimCheck). Jeder LLM-Lauf zählt gegen das Tagesbudget.
 * agent.chat gilt für Absender („KI nutzen“) und Agent (Recht); in Direktnachrichten ohne Projekt, danach antwortet der Agent
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
      items: { type: 'object', additionalProperties: false, required: ['type', 'ref', 'to', 'text', 'title', 'parent', 'project', 'subproject', 'dueDate', 'deliverables', 'every', 'level', 'mode', 'depth', 'reason', 'mail', 'items', 'refs', 'filter'], properties: {
        type: { type: 'string', enum: ['order', 'note', 'run', 'pause', 'resume', 'stop', 'priority', 'approve', 'reject', 'policy', 'report', 'refer', 'move', 'take'] },
        ref: { type: 'string', description: 'note/pause/resume/stop/priority/approve/reject/policy/report: Kennung des Arbeitspakets (z. B. WEB-12); move: Kennung der Aufgabe oder des Arbeitspakets, das verschoben wird; für das in derselben Antwort per order angelegte: neu; sonst leer' },
        to: { type: 'string', description: 'move: Kennung des Ziel-Arbeitspakets (Aufgabe darunter hängen); leer, wenn ein Arbeitspaket per subproject einem Teilprojekt zugeordnet wird; sonst leer' },
        text: { type: 'string', description: 'order: der Auftrag im Wortlaut (Beschreibung); note: Information fürs Log; refer: Vorschlag für die PL; sonst leer' },
        title: { type: 'string', description: 'order: kurzer Titel des Arbeitspakets bzw. der Aufgabe; sonst leer' },
        parent: { type: 'string', description: 'order: Kennung eines bestehenden Über-AP aus dem Kontext, wenn eine Aufgabe darunter entstehen soll; nie erfinden; sonst leer (neues Arbeitspaket)' },
        project: { type: 'string', description: 'order: Kürzel des Projekts, in das der Auftrag gehört (aus Thema, Treffern oder Übersicht der gemeinsamen Projekte); leer = Thema bzw. persönliches Projekt' },
        subproject: { type: 'string', description: 'order: Name des Teilprojekts oder leer; move: Ziel-Teilprojekt eines Arbeitspakets (leer mit to = Aufgabe umhängen; „keins“ = aus dem Teilprojekt heraus)' },
        dueDate: { type: 'string', description: 'order: Termin YYYY-MM-DD (deutsche Angaben wie 8.11. gehen auch) oder leer' },
        deliverables: { type: 'array', items: { type: 'string' }, description: 'order: Lieferergebnisse als Tasks; sonst leer' },
        every: { type: 'string', description: 'order/report: Zwischenstände each, milestones, daily oder done; sonst leer' },
        level: { type: 'string', description: 'priority: niedrig, normal, hoch oder kritisch; sonst leer' },
        mode: { type: 'string', description: 'policy: auto, confirm_critical oder confirm_all; sonst leer' },
        depth: { type: 'string', description: 'policy: Denktiefe quick (schnell), standard oder deep (gründlich); sonst leer' },
        reason: { type: 'string', description: 'stop/reject: Grund; sonst leer' },
        mail: { type: 'boolean', description: 'order/report: Zwischenstände und Lieferung auch per Mail an den Auftraggeber' },
        items: { type: 'array', items: { type: 'integer' }, description: 'take: Nummern in der Reihenfolge deiner letzten Statusantwort im Gespräch („übernimm 2 und 4“); sonst leer' },
        refs: { type: 'array', items: { type: 'string' }, description: 'take: Kennungen der Aufgaben („übernimm WEB-12“); sonst leer' },
        filter: { type: 'string', description: 'take: overdue, today, week oder all aus deiner letzten Statusantwort („übernimm alle überfälligen“); sonst leer' }
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

/**
 * personal = persönliches Projekt des Absenders (ohne Kontext), general = kein Projektbezug (allgemeine Anfrage, Gruß ohne
 * persönliches Projekt), matched = über Inhalte genau einem Projekt zugeordnet, open = Treffer in mehreren Projekten
 * (Rückfrage), ask = kein Anhaltspunkt bei mehreren Kandidaten (Rückfrage), chosen = per Rückfrage (Knopf oder Markerwort) gewählt
 */
export type ChatScopeHow = 'channel' | 'mentioned' | 'history' | 'all' | 'status' | 'ask' | 'personal' | 'general' | 'matched' | 'open' | 'chosen';
export type ChatConfidence = 'sure' | 'guess' | 'unsure';
export interface ScopeProject { id: string; key: string; name: string }
/** Absicht, die eine Antwort auf die Rückfrage (Knopf oder Markerwort) festlegt. */
export type ForcedIntent = { intent: 'general' } | { intent: 'personal' } | { intent: 'project'; projectId: string };
/** Thema einer Chat-Nachricht: Projekte und Arbeitspakete, aus denen der Kontext kommt, und wie es bestimmt wurde. */
export interface ChatScope {
  how: ChatScopeHow;
  /** Absicht: allgemein (kein Projektkontext), Projekt oder persönlicher Assistent */
  intent: ChatIntent;
  /** sure: Kanal, Nennung, Marker; guess: Heuristik oder einziger Kandidat (Antwort mit Hinweis auf die Annahme); unsure: Rückfrage mit Knöpfen */
  confidence: ChatConfidence;
  /** persönliches Projekt des Absenders (Direktnachricht), wenn der Agent dort Mitglied ist */
  personalId?: string | null;
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
  /** Direktnachricht: alle gemeinsamen Projekte (Übersicht zur Zuordnung, Ziele für order.project) */
  common?: ScopeProject[];
  /** Treffer der Inhaltssuche je Projekt (Doku und Arbeitspakete, die beide sehen) */
  hits?: Map<string, { pages: SearchHit[]; tasks: SearchHit[] }>;
  /** Assistent im persönlichen Projekt: Statusfrage („was steht an?“) oder reiner Gruß; der Prompt bekommt den Abschnitt „Statusfrage“ */
  status?: boolean;
}

/** „über alle Projekte“, „insgesamt“: Thema sind alle gemeinsamen Projekte. */
const ALL_RE = /über alle projekte|alle[n]? (meine[n]? |unsere[n]? |gemeinsamen )?projekte[n]?|insgesamt|projektübergreifend/i;
/** Kurze Statusfrage ohne Projektnennung („gibt's was zu tun?“, „wie ist der Stand?“): Überblick über alle gemeinsamen Projekte statt Rückfrage. */
const STATUS_RE = /(?<!\p{L})(?:(?:gibt'?s|gibt es)(?!\p{L}).*(?<!\p{L})(?:was|etwas|neues)|zu tun|was (?:steht|liegt|ist)(?: \p{L}+){0,4} (?:an|offen)|status|stand|überblick|update|was (?:machst|tust) du|woran arbeitest|was hast du(?!\p{L}).*(?<!\p{L})(?:offen|vor)|was läuft)(?!\p{L})/iu;
/** Gruß am Anfang („Hi“, „Hallo Morton,“, „Guten Morgen“): zählt nicht als Inhalt. */
const GREETING_RE = /^(?:hi|hallo|hey|hej|hallöchen|huhu|moin(?: moin)?|servus|grüezi|grüß gott|grüß dich|guten (?:morgen|tag|abend)|mahlzeit|morgen)(?!\p{L})/iu;
/** Gruß und Anrede (Agentenname) am Anfang entfernen: „Hi Morton, was steht an?“ → „was steht an?“. */
export function stripGreeting(body: string, names: string[] = []): string {
  let b = String(body ?? '').trim();
  const nameRe = names.flatMap((n) => String(n ?? '').split(/\s+/)).filter(Boolean).map(escRe);
  const lead = new RegExp(`^(?:${nameRe.length ? `(?:${nameRe.join('|')})` : '(?!)'}|@\\S+)(?![\\p{L}\\p{N}])`, 'iu');
  for (let i = 0; i < 6; i++) {
    const next = b.replace(GREETING_RE, '').replace(lead, '').replace(/^[\s,.!;:–-]+/u, '');
    if (next === b) break;
    b = next;
  }
  return b;
}
/** Kurze Statusfrage, auch mit Gruß und Agentennamen davor (bis zu 8 Wörter ohne Gruß und Anrede). */
export const isStatusQuestion = (body: string, names: string[] = []) => { const b = stripGreeting(body, names); return b.split(/\s+/).filter(Boolean).length <= 8 && STATUS_RE.test(b); };
/** Reiner Gruß ohne Frage oder Bitte („Hi“, „Hallo Morton“, „Guten Morgen!“); kein Dank, kein Abschied. */
export const isGreeting = (body: string, names: string[] = []) => GREETING_RE.test(String(body ?? '').trim()) && isSmallTalk(body, names) && !/[?]/.test(stripGreeting(body, names));
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Nachricht für Marker: klein, ohne Satzzeichen am Rand, Leerraum vereinheitlicht. */
const norm = (s: string) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').replace(/^[\s„"“'»«(]+|[\s.!?,;:“"'»«)]+$/g, '').trim();
/** Marker am Anfang („allgemein: …“, „persönlich, …“) oder als ganze Nachricht; „für mich“ und „mein projekt“ nur ganz oder mit Doppelpunkt (sonst normale Satzanfänge). */
const marked = (body: string, words: string[], loose: boolean) => {
  const n = norm(body);
  return words.some((w) => n === w || n.startsWith(`${w}:`) || n.startsWith(`${w} –`) || n.startsWith(`${w} -`) || (loose && (n.startsWith(`${w},`) || n.startsWith(`${w} `))));
};
export const GENERAL_MARKERS = ['allgemein', 'ohne projekt', 'kein projekt'];
export const PERSONAL_MARKERS = ['persönlich', 'privat', 'für mich', 'mein projekt'];
/** Ausdrückliche Marker (Knopfwerte der Rückfrage und Wörter dafür): Absicht sicher. */
export function intentMarker(body: string, projects: ScopeProject[]): { intent: 'general' } | { intent: 'personal' } | { intent: 'project'; project: ScopeProject } | null {
  if (marked(body, ['allgemein', 'ohne projekt', 'kein projekt'], true)) return { intent: 'general' };
  if (marked(body, ['persönlich', 'privat'], true) || marked(body, ['für mich', 'mein projekt'], false)) return { intent: 'personal' };
  const n = norm(body);
  const m = n.match(/^projekt\s+([a-z0-9-]{2,12})(?:[:,]|\s[–-]|$)/) ?? n.match(/^([a-z0-9-]{2,12})$/);
  const p = m ? projects.find((x) => x.key.toLowerCase() === m[1]) ?? null : null;
  return p ? { intent: 'project', project: p } : null;
}
/** Frage zum Tool: wie man etwas anlegt oder findet, was etwas bedeutet, was der Agent kann. */
const TOOL_RE = /(?<!\p{L})(?:wie (?:lege|leg|erstelle|erstell|richte|richt|finde|find|öffne|ändere|änder|lösche|lösch|kann|kannst) (?:ich|man)|wo (?:finde|find|stelle|stell|sehe|seh) (?:ich|man)|was (?:bedeutet|heißt|heisst|ist (?:ein|eine|der|die|das) \p{L}+ im tool|kannst du)|wie funktioniert|wozu (?:dient|ist)|gibt es (?:im tool |hier )?(?:eine|einen|ein) (?:funktion|möglichkeit|einstellung))(?!\p{L})/iu;
/** Formulierungs- oder Wissensanfrage ohne Projektbezug. */
const KNOW_RE = /(?<!\p{L})(?:formulier\w*|übersetz\w*|erklär\w*|erkläre|was ist (?:ein|eine|der|die|das)|was heißt|wie schreibt man|wie heißt .* auf|korrigier\w*|fasse .* zusammen|witz|rechtschreib\w*|synonym\w*|definition)(?!\p{L})/iu;
/** Arbeitsworte (Vorgänge, Personen, Aktionen): damit ist eine Tool-Frage keine allgemeine Anfrage mehr, sondern betrifft Arbeit. */
const ACTION_RE = /(?<!\p{L})(?:status|stand|mail\w*|schick\w*|send\w*|frag\w*|recherch\w*|erinner\w*|notier\w*|angebot\w*|kunde\w*|lieferant\w*|rechnung\w*|vertrag\w*)(?!\p{L})|\b[A-Za-z][A-Za-z0-9]{1,9}-\d{1,6}\b/iu;
/** Projekt- bzw. Strukturworte dazu: damit ist eine Wissens- oder Formulierungsanfrage keine allgemeine Anfrage mehr. */
const WORK_RE = new RegExp(`${ACTION_RE.source}|(?<!\\p{L})(?:arbeitspaket\\w*|aufgabe\\w*|projekt\\w*|auftrag\\w*|termin\\w*|frist\\w*|fällig\\w*|log|doku\\w*|teilprojekt\\w*|meilenstein\\w*|anleg\\w*)(?!\\p{L})`, 'iu');
/** Ich-/mein-Form mit Aufgabenbezug: persönlicher Assistent. */
const ME_RE = /(?<!\p{L})(?:ich|mir|mich|mein|meine|meinen|meinem|meiner)(?!\p{L})/iu;
const PERSONAL_TASK_RE = /(?<!\p{L})(?:erinner\w*|notier\w*|notiz\w*|merk\w*|aufgabe\w*|auftrag\w*|to-?dos?|liste|termin\w*|heute|morgen|übermorgen|diese woche|nächste woche|einkauf\w*|urlaub\w*)(?!\p{L})/iu;
/** Absicht aus der Nachricht ohne Projektnennung: general (Tool- oder Wissensfrage ohne Arbeitsworte), personal (Ich-Form mit Aufgabenbezug) oder null. */
export function intentHeuristic(body: string): 'general' | 'personal' | null {
  const b = String(body ?? '');
  // Tool-Frage: Strukturworte (Arbeitspaket, Termin) gehören zur Frage, nur Vorgänge oder Aktionen machen sie zur Arbeit; Wissensfrage: beides
  if (TOOL_RE.test(b) && !ACTION_RE.test(b.replace(TOOL_RE, ' '))) return 'general';
  if (KNOW_RE.test(b) && !WORK_RE.test(b)) return 'general';
  if (ME_RE.test(b) && PERSONAL_TASK_RE.test(b)) return 'personal';
  return null;
}

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
 * Recht agent.chat frei. Kennungen aus anderen Projekten oder aus Teilprojekten, die einer von beiden nicht sieht,
 * landen in hidden; der Agent sagt dazu nichts, auch keinen Titel.
 */
export async function resolveChatScope(db: Db, q: { channel: any; message: { id: string; body: string; thread_id?: string | null }; history: { id: string; body: string; created_at?: string | Date; uid?: string | null }[]; senderId: string; agent: { id: string; org_id: string; name?: string; /** assistant: persönlicher Assistent (E): „persönlich“ ist der sichere Standard, Rückfrage nur bei ausdrücklichem Projektbezug */ agent_role?: string | null }; /** Antwort auf die Rückfrage: Absicht steht fest */ forced?: ForcedIntent | null }, now = new Date()): Promise<ChatScope> {
  const all: ScopeProject[] = (await db.query(`select id, key, name from projects where org_id = $1 order by key`, [q.agent.org_id])).rows;
  const channelProject = q.channel.kind === 'project' ? all.find((p) => p.id === q.channel.project_id) ?? null : null;
  const sure = { intent: 'project' as ChatIntent, confidence: 'sure' as ChatConfidence };
  /** Arbeitspaket zu einer Kennung; null, wenn es fehlt oder einer von beiden es nicht sieht (eingeschränktes Teilprojekt). */
  const taskOf = async (r: { project: ScopeProject; number: number }): Promise<{ id: string; project_id: string } | null | undefined> => {
    const t = await db.maybeOne(`select t.id, t.project_id, t.subproject_id from tasks t where t.project_id = $1 and t.number = $2 and t.deleted_at is null`, [r.project.id, r.number]);
    if (!t) return undefined;
    if (channelProject) return t.subproject_id && (await db.maybeOne(`select 1 from subprojects where id = $1 and restricted`, [t.subproject_id])) ? null : t;
    return (await canSeeSubproject(db, q.senderId, t.subproject_id)) && (await canSeeSubproject(db, q.agent.id, t.subproject_id)) ? t : null;
  };
  const ref = (r: { project: ScopeProject; number: number }) => `${r.project.key}-${r.number}`;

  if (channelProject) {
    const scope: ChatScope = { how: 'channel', ...sure, projectIds: [channelProject.id], taskIds: [], refs: [], hidden: [], projects: [channelProject] };
    const texts = [q.message.body];
    // Thread: die Kennung der Thread-Wurzel (höchstens 14 Tage alt) bestimmt das Arbeitspaket mit
    if (q.message.thread_id) {
      const root = await db.maybeOne(`select body from chat_messages where id = $1 and deleted_at is null and created_at > $2::timestamptz - interval '14 days'`, [q.message.thread_id, now]);
      if (root) texts.push(String(root.body));
    }
    for (const text of texts) {
      const m = findMentions(text, all);
      // Andere Projekte (Kürzel oder Name ohne Kennung): hier nichts dazu, aber gesagt wird es (sonst ginge der Teil still unter)
      for (const p of m.projects) if (p.id !== channelProject.id && !m.refs.some((r) => r.project.id === p.id) && !scope.hidden.includes(p.key)) scope.hidden.push(p.key);
      for (const r of m.refs) {
        if (r.project.id !== channelProject.id) { if (!scope.hidden.includes(ref(r))) scope.hidden.push(ref(r)); continue; }
        const t = await taskOf(r);
        if (t === null) { if (!scope.hidden.includes(ref(r))) scope.hidden.push(ref(r)); continue; }
        if (t && !scope.taskIds.includes(t.id)) { scope.taskIds.push(t.id); scope.refs.push(ref(r)); }
      }
    }
    return scope;
  }

  // Direktnachricht: gemeinsame, beidseitig freie Projekte (Absender PL oder „KI nutzen“, Agent mit Recht)
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
  // Persönliches Projekt des Absenders (er ist dort PL, der Agent Mitglied)
  const personal = common.length ? (await db.query(`select p.id from projects p join project_members m on m.project_id = p.id and m.user_id = $1 and m.role = 'pl' where ${SQL.isPersonal('p')} and p.id = any($2::uuid[])`, [q.senderId, common.map((p) => p.id)])).rows.map((r: any) => r.id as string) : [];
  const personalId = personal[0] ?? null;
  const none = { taskIds: [] as string[], refs: [] as string[], hidden: [] as string[], common, personalId };
  /** Absicht eines Projektthemas: das persönliche Projekt allein heißt persönlicher Assistent, sonst Projekt. */
  const intentOf = (ids: string[]): ChatIntent => (ids.length === 1 && ids[0] === personalId ? 'personal' : 'project');
  const personalScope = (confidence: ChatConfidence): ChatScope => ({ how: 'personal', intent: 'personal', confidence, projectIds: personal, ...none, projects: common.filter((p) => personal.includes(p.id)) });
  const generalScope = (confidence: ChatConfidence): ChatScope => ({ how: 'general', intent: 'general', confidence, projectIds: [], ...none, projects: common });
  const projectScope = (how: ChatScopeHow, ids: string[], confidence: ChatConfidence, extra: Partial<ChatScope> = {}): ChatScope => ({ how, intent: intentOf(ids), confidence, projectIds: ids, ...none, projects: common.filter((p) => ids.includes(p.id)), ...extra });
  const body = q.message.body;

  // Antwort auf die Rückfrage (Knopf oder Markerwort): das Thema steht fest, die Ursprungsnachricht wird damit beantwortet
  if (q.forced) {
    if (q.forced.intent === 'general') return generalScope('sure');
    if (q.forced.intent === 'personal') return personal.length ? personalScope('sure') : generalScope('sure');
    const id = q.forced.projectId;
    // Gewähltes Projekt ohne gemeinsame Freigabe: wie eine genannte Kennung ohne Freigabe (feste Absage)
    return isCommon(id) ? projectScope('chosen', [id], 'sure', { common: undefined }) : { how: 'mentioned', ...sure, projectIds: [], taskIds: [], refs: [], hidden: [all.find((p) => p.id === id)?.key ?? '?'], projects: [], personalId };
  }
  // Ausdrückliche Marker am Anfang oder als ganze Nachricht: „allgemein“, „persönlich“, „Projekt WEB“ bzw. nur ein Kürzel
  const marker = intentMarker(body, common);
  if (marker?.intent === 'general') return generalScope('sure');
  if (marker?.intent === 'personal') return personal.length ? { ...personalScope('sure'), ...(q.agent.agent_role === 'assistant' && isStatusQuestion(body.replace(/^\s*(?:persönlich|privat)\s*[:,–-]?\s*/iu, ''), q.agent.name ? [q.agent.name] : []) ? { status: true } : {}) } : generalScope('sure');
  if (marker?.intent === 'project') return projectScope('mentioned', [marker.project.id], 'sure');
  const mine = await resolve(body);
  if (mine.projectIds.length || mine.hidden.length) return { how: 'mentioned', intent: intentOf(mine.projectIds), confidence: 'sure', ...mine, projects: common.filter((p) => mine.projectIds.includes(p.id)), personalId };
  // Persönlicher Assistent (E): ohne Marker und Nennung ist „persönlich“ sicher (kein Raten, keine Rückfrage); nur eine Tool- oder
  // Wissensfrage ohne Arbeitsworte bleibt allgemein (Annahme). Genannte fremde Projekte landen oben in hidden (nicht Mitglied).
  if (q.agent.agent_role === 'assistant') {
    if (intentHeuristic(body) === 'general' && !isSmallTalk(body, q.agent.name ? [q.agent.name] : [])) return generalScope('guess');
    if (!personal.length) return generalScope('sure');
    // Statusfrage („Hi Morton, was steht an?“) oder reiner Gruß: der Assistent nennt, was ansteht (Abschnitt „Statusfrage“)
    const names = q.agent.name ? [q.agent.name] : [];
    return { ...personalScope('sure'), ...(isStatusQuestion(body, names) || isGreeting(body, names) ? { status: true } : {}) };
  }
  if (ALL_RE.test(body)) return projectScope('all', common.map((p) => p.id), 'sure');
  if (isStatusQuestion(body, q.agent.name ? [q.agent.name] : [])) return projectScope('status', common.map((p) => p.id), 'sure');
  // Gruß oder Kurzmeldung ohne Inhalt: kein Projektbezug
  if (isSmallTalk(body, q.agent.name ? [q.agent.name] : [])) return personal.length ? personalScope('sure') : generalScope('sure');
  // Heuristik: Frage zum Tool, Formulierungs- oder Wissensanfrage ohne Arbeitsworte ist allgemein (Annahme)
  const guess = intentHeuristic(body);
  if (guess === 'general') return generalScope('guess');
  // Dialog im Thread: das zuletzt im Thread genannte Arbeitspaket bzw. Projekt (der Verlauf enthält nur den Thread und noch
  // unbeantwortete Nachrichten; ein Gedächtnis über Gespräche hinweg gibt es nicht)
  for (const h of q.history) {
    if (h.id === q.message.id) continue;
    const r = await resolve(String(h.body ?? ''));
    if (r.projectIds.length) return projectScope('history', r.projectIds, 'sure', { taskIds: r.taskIds, refs: r.refs });
  }
  // Heuristik: Ich-/mein-Form mit Aufgabenbezug („erinnere mich“, „meine Aufgaben“, „notier mir … morgen“) ist der persönliche Assistent (Annahme)
  if (guess === 'personal' && personal.length) return personalScope('guess');
  // Zuordnung über Inhalte: Treffer in Doku und Arbeitspaketen der gemeinsamen Projekte, nur was Agent und Absender sehen
  // Ein Projekt zählt erst, wenn ein Treffer mindestens zwei Suchbegriffe enthält (bei nur einem Begriff diesen): ein einzelnes
  // häufiges Wort oder ein Vorname ordnet nichts zu
  const hits = new Map<string, { pages: SearchHit[]; tasks: SearchHit[] }>();
  const need = Math.min(2, tokens(body).slice(0, 8).length);
  if (need) for (const p of common.slice(0, 12)) {
    const r = await knowledgeSearch(db, { projectId: p.id, agentId: q.agent.id, query: body, viewerId: q.senderId, maxTitles: 5, maxExcerpts: 2 });
    if ([...r.pages, ...r.tasks].some((h) => (h.score ?? 0) >= need)) hits.set(p.id, r);
  }
  const hitProjects = common.filter((p) => hits.has(p.id));
  if (hitProjects.length === 1) return projectScope('matched', [hitProjects[0].id], 'guess', { hits });
  if (hitProjects.length > 1) return { how: 'open', intent: 'project', confidence: 'unsure', projectIds: [], ...none, projects: common, hits };
  // Ohne Anhaltspunkt: genau ein gemeinsames Projekt (Annahme), nur das persönliche (Annahme), sonst Rückfrage
  const shared = common.filter((p) => !personal.includes(p.id));
  if (shared.length === 1 && !personal.length) return projectScope('all', [shared[0].id], 'guess');
  if (personal.length && !shared.length) return personalScope('guess');
  if (common.length > 1) return { how: 'ask', intent: 'project', confidence: 'unsure', projectIds: [], ...none, projects: common };
  return projectScope('all', common.map((p) => p.id), common.length ? 'guess' : 'sure');
}

/** Heutiges Datum in Europe/Berlin (YYYY-MM-DD) und der Sonntag dieser Woche, für „fällig diese Woche“. */
export function berlinWeek(now: Date): { today: string; sunday: string } {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', weekday: 'short' }).format(now));
  const [y, m, d] = today.split('-').map(Number);
  return { today, sunday: new Date(Date.UTC(y, m - 1, d + ((7 - dow) % 7))).toISOString().slice(0, 10) };
}

/** Statusdaten für den Assistenten: was im persönlichen Projekt ansteht, vom System per SQL ermittelt (nicht vom Modell). */
export interface StatusBrief {
  overdue: StatusTask[]; today: StatusTask[]; week: StatusTask[]; noDate: StatusTask[]; later: number;
  /** die nächsten fälligen Aufgaben mit Termin (höchstens 5, auch überfällige), für den Stil management */
  dated: StatusTask[];
  /** Anzahlen je Gruppe (nicht gekürzt), für die Stile compact und management */
  counts: StatusCounts;
  openItems: number;
  meetings: { title: string; day: 'heute' | 'morgen'; from: string; to: string; location: string | null; tentative: boolean }[];
  questions: { kind: string; body: string; ref: string | null }[];
  proposals: number;
  drafts: { subject: string; to: string }[];
  /** nichts offen: keine Arbeitspakete, Termine, Fragen, Freigaben oder Entwürfe */
  empty: boolean;
}
export interface StatusCounts { overdue: number; today: number; week: number; noDate: number; later: number; meetingsToday: number; questions: number }
export interface StatusTask { id: string; projectId: string; ref: string; title: string; due: string | null; parent: string | null; mine: boolean; status: string }
const STATUS_MAX = 8;
/** Höchstens so viele terminierte Aufgaben im Stil management. */
export const MANAGEMENT_MAX = 5;
export async function statusBrief(db: Db, q: { projectId: string; personId: string; agentId: string; now: Date }): Promise<StatusBrief> {
  const { today, sunday } = berlinWeek(q.now);
  // Offene Arbeitspakete und Aufgaben der Person bzw. des Assistenten (zuständig direkt oder geerbt; ohne Zuständigkeit gilt die Person)
  const rows = (await db.query(
    `select t.id, t.project_id, p.key, t.number, t.title, c.name as column_name, to_char(t.due_date, 'YYYY-MM-DD') as due, pt.title as parent_title, (${EFFECTIVE_RESPONSIBLE_SQL}) as resp,
       case when t.due_date is null then 'none' when t.due_date < $2::date then 'overdue' when t.due_date = $2::date then 'today' when t.due_date <= $3::date then 'week' else 'later' end as bucket
     from tasks t join board_columns c on c.id = t.column_id join projects p on p.id = t.project_id ${EFFECTIVE_JOINS}
     where t.project_id = $1 and t.deleted_at is null and t.archived_at is null and not c.is_done
       and ((${EFFECTIVE_RESPONSIBLE_SQL}) is null or (${EFFECTIVE_RESPONSIBLE_SQL}) = any(array[$4, $5]::uuid[]))
     order by t.due_date nulls last, t.number limit 200`, [q.projectId, today, sunday, q.personId, q.agentId])).rows as any[];
  const task = (r: any): StatusTask => ({ id: r.id, projectId: r.project_id, ref: `${r.key}-${r.number}`, title: r.title, due: r.due ?? null, parent: r.parent_title ?? null, mine: r.resp === q.agentId, status: r.column_name });
  const pick = (b: string) => rows.filter((r) => r.bucket === b).slice(0, STATUS_MAX).map(task);
  const openItems = (await db.one(`select count(*)::int as c from checklist_items i join tasks t on t.id = i.task_id join board_columns c on c.id = t.column_id where t.project_id = $1 and not i.done and t.deleted_at is null and t.archived_at is null and not c.is_done`, [q.projectId])).c as number;
  // Termine heute und morgen (Europe/Berlin)
  const meetings = (await db.query(
    `select title, location, tentative, to_char(starts_at at time zone 'Europe/Berlin', 'HH24:MI') as f, to_char(ends_at at time zone 'Europe/Berlin', 'HH24:MI') as t,
       (starts_at at time zone 'Europe/Berlin')::date = $2::date as is_today
     from meetings where project_id = $1 and starts_at >= ($2::date)::timestamp at time zone 'Europe/Berlin' and starts_at < ($2::date + 2)::timestamp at time zone 'Europe/Berlin'
     order by starts_at limit ${STATUS_MAX}`, [q.projectId, today])).rows.map((m: any) => ({ title: m.title, day: (m.is_today ? 'heute' : 'morgen') as 'heute' | 'morgen', from: m.f, to: m.t, location: m.location ?? null, tentative: Boolean(m.tentative) }));
  const meetingsToday = (await db.one(`select count(*)::int as c from meetings where project_id = $1 and starts_at >= ($2::date)::timestamp at time zone 'Europe/Berlin' and starts_at < ($2::date + 1)::timestamp at time zone 'Europe/Berlin'`, [q.projectId, today])).c as number;
  // Offene Fragen und Bestätigungen an die Person (oder an den Kanal des persönlichen Projekts), angehaltene Aktionen zur Freigabe
  const QW = `from questions q join projects p on p.id = q.project_id left join tasks t on t.id = q.task_id where q.project_id = $1 and q.status = 'open' and (q.addressee_id = $2 or q.addressee_id is null)`;
  const questions = (await db.query(`select q.kind, q.body, p.key, t.number ${QW} order by q.created_at limit ${STATUS_MAX}`, [q.projectId, q.personId])).rows.map((r: any) => ({ kind: r.kind, body: String(r.body ?? '').replace(/\s+/g, ' '), ref: r.number ? `${r.key}-${r.number}` : null }));
  const questionCount = (await db.one(`select count(*)::int as c ${QW}`, [q.projectId, q.personId])).c as number;
  const proposals = (await db.one(`select count(*)::int as c from ai_proposals where project_id = $1 and status = 'pending'`, [q.projectId])).c as number;
  // Mail-Entwürfe zur Freigabe: aus dem persönlichen Projekt oder aus eigenen Postfächern der Person
  const drafts = (await db.query(
    `select d.subject, d.to_addrs from mail_drafts d where d.status = 'pending_approval'
       and (d.project_id = $1 or d.account_id in (select a.id from mail_accounts a where (a.type = 'personal' and a.owner_user_id = $2) or a.managed_user_id = $2))
     order by d.created_at limit ${STATUS_MAX}`, [q.projectId, q.personId])).rows.map((d: any) => ({ subject: String(d.subject || '(ohne Betreff)'), to: (Array.isArray(d.to_addrs) ? d.to_addrs : []).map((x: any) => (typeof x === 'string' ? x : x?.address ?? x?.email ?? '')).filter(Boolean).join(', ') }));
  const n = (b: string) => rows.filter((r) => r.bucket === b).length;
  const counts: StatusCounts = { overdue: n('overdue'), today: n('today'), week: n('week'), noDate: n('none'), later: n('later'), meetingsToday, questions: questionCount };
  const b: StatusBrief = { overdue: pick('overdue'), today: pick('today'), week: pick('week'), noDate: pick('none'), later: counts.later, dated: rows.filter((r) => r.due).slice(0, MANAGEMENT_MAX).map(task), counts, openItems, meetings, questions, proposals, drafts, empty: false };
  b.empty = !rows.length && !meetings.length && !questions.length && !proposals && !drafts.length;
  return b;
}
const dm = (iso: string | null) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.` : '');
const STYLE_LABEL: Record<StatusStyle, string> = { technical: 'technisch', compact: 'kompakt', text: 'Fließtext', management: 'Management' };
/** Anzahlen je Gruppe in einer Zeile (compact, management). */
export const countsLine = (c: StatusCounts) => `überfällig ${c.overdue} · heute fällig ${c.today} · diese Woche fällig ${c.week} · ohne Termin ${c.noDate} · Termine heute ${c.meetingsToday} · offene Fragen ${c.questions}`;
/** Antwortanweisung je Stil (ohne Gruß, nicht leer). */
const STYLE_HOW: Record<StatusStyle, string> = {
  technical: 'Antworte knapp aus diesen Daten: Überfälliges und heute Fälliges zuerst (Kennung, Titel, Termin), dann Termine heute und morgen, dann diese Woche, offene Fragen, Freigaben und Entwürfe; Leeres weglassen.',
  text: 'Antworte in einem kurzen, zusammenhängenden Text nach bestem Wissen (keine Liste): Überfälliges und heute Fälliges zuerst, dann Termine, diese Woche, offene Fragen, Freigaben und Entwürfe. Jede Aufgabe beschreibst du in eigenen Worten und nennst ihre Kennung in Klammern (z. B. „… (WEB-12)“), damit sie im Chat verlinkt wird; Leeres weglassen.',
  compact: 'Antworte in ein bis zwei Zeilen nur mit diesen Anzahlen (Gruppen mit 0 weglassen): keine Titel, keine Kennungen, keine einzelnen Aufgaben.',
  management: `Gib ein Lagebild in zwei bis vier Sätzen: zuerst die Gesamtlage aus den Anzahlen, dann höchstens die ${MANAGEMENT_MAX} genannten Aufgaben mit Kennung und Termin. Keine Details zu Eskalationen oder Blockaden, keine Aufgaben ohne Termin, nichts darüber hinaus.`
};
/**
 * Abschnitt „Statusfrage“ für den Prompt des Assistenten, je Antwortstil: technical und text bekommen die Listen (Daten gleich,
 * Anweisung verschieden), compact nur die Anzahlen, management die Anzahlen und die nächsten fälligen Aufgaben mit Termin.
 */
export function statusBriefText(b: StatusBrief, greeting: boolean, style: StatusStyle = 'technical'): string {
  const task = (t: StatusTask) => `- ${t.ref} „${cut(t.title, 80)}“${t.due ? ` · fällig ${dm(t.due)}` : ''}${t.parent ? ` (Aufgabe in „${cut(t.parent, 60)}“)` : ''}${t.mine ? ' · bei dir' : ''}`;
  const list = (label: string, xs: StatusTask[]) => (xs.length ? `${label}:\n${xs.map(task).join('\n')}\n` : '');
  const full = [
    list('Überfällig', b.overdue), list('Heute fällig', b.today), list('Diese Woche fällig', b.week), list('Ohne Termin', b.noDate),
    b.later ? `Später fällig: ${b.later}\n` : '',
    b.openItems ? `Offene Checklistenpunkte: ${b.openItems}\n` : '',
    b.meetings.length ? `Termine heute und morgen:\n${b.meetings.map((m) => `- ${m.day} ${m.from}–${m.to} „${cut(m.title, 80)}“${m.location ? ` (${cut(m.location, 60)})` : ''}${m.tentative ? ' · vorläufig' : ''}`).join('\n')}\n` : '',
    b.questions.length ? `Offene Fragen und Bestätigungen an die Person:\n${b.questions.map((x) => `- ${x.kind === 'approval' || x.kind === 'confirm' ? 'Bestätigung' : x.kind === 'decision' ? 'Entscheidung' : 'Frage'}${x.ref ? ` zu ${x.ref}` : ''}: ${cut(x.body, 160)}`).join('\n')}\n` : '',
    b.proposals ? `Angehaltene Aktionen zur Freigabe: ${b.proposals}\n` : '',
    b.drafts.length ? `Mail-Entwürfe zur Freigabe:\n${b.drafts.map((d) => `- „${cut(d.subject, 80)}“${d.to ? ` an ${cut(d.to, 80)}` : ''}`).join('\n')}\n` : ''
  ].join('');
  const lines = b.empty ? '' : style === 'compact'
    ? `Anzahlen: ${countsLine(b.counts)}\n`
    : style === 'management'
      ? `Anzahlen: ${countsLine(b.counts)}\n${list(`Die nächsten fälligen Aufgaben (höchstens ${MANAGEMENT_MAX}, nur mit Termin)`, b.dated)}`
      : full;
  const urgent = b.counts.overdue + b.counts.today > 0;
  const greet: Record<StatusStyle, string> = {
    technical: urgent ? ' und nenne in einem Satz, was überfällig oder heute fällig ist (Kennung, Titel)' : ', ohne Liste',
    text: urgent ? ' und nenne in einem Satz, was überfällig oder heute fällig ist (in eigenen Worten, jede Aufgabe mit ihrer Kennung)' : ', ohne Liste',
    compact: urgent ? ' und nenne in einem Halbsatz nur die Anzahl überfälliger und heute fälliger Aufgaben' : ', ohne Zahlen',
    management: urgent ? ' und gib in einem Satz das Lagebild aus den Anzahlen' : ', ohne Liste'
  };
  const how = greeting
    ? `Die letzte Nachricht ist ein reiner Gruß: grüß kurz zurück${greet[style]}.`
    : b.empty
      ? 'Im persönlichen Projekt ist gerade nichts offen: sag kurz „Gerade steht nichts an“ und mach einen konkreten Vorschlag (z. B. etwas notieren, einen Termin eintragen, eine Erinnerung anlegen).'
      : STYLE_HOW[style];
  return `# Statusfrage\nAntwortstil: ${STYLE_LABEL[style]}\nVom System ermittelt aus dem persönlichen Projekt (Stand jetzt; vollständig, nichts dazuerfinden):\n${lines || '– nichts offen –\n'}${how} Antworte nie, du sähest keine Frage oder Bitte.\n`;
}
/** Aufgaben, die der Abschnitt „Statusfrage“ des Assistenten nennt (Reihenfolge wie dort), für meta.statusItems an der Antwort (Befehl take); compact: keine. */
export function statusBriefTasks(b: StatusBrief, greeting: boolean, style: StatusStyle): StatusTask[] {
  if (style === 'compact' || b.empty) return [];
  if (style === 'management') return greeting ? [] : b.dated;
  return greeting ? [...b.overdue, ...b.today] : [...b.overdue, ...b.today, ...b.week, ...b.noDate];
}

/**
 * Abschnitt „Statusfrage“ für Projektagenten (Thema status): technical bleibt wie bisher (Anweisung am Ende des Prompts, Liste
 * „Deine offenen Arbeitspakete“); text bekommt dazu die Anweisung, compact nur Anzahlen, management Anzahlen und die nächsten
 * fälligen Arbeitspakete mit Termin (ohne Blockaden und Wartezustände). Ergebnis: Text und die genannten Arbeitspakete.
 */
export function projectStatusText(rows: { id: string; project_id: string; key: string; number: number; title: string; due_date: any; column_name: string }[], counts: StatusCounts, style: StatusStyle): { text: string; tasks: StatusTask[] } {
  const task = (r: any): StatusTask => ({ id: r.id, projectId: r.project_id, ref: `${r.key}-${r.number}`, title: r.title, due: d10(r.due_date) || null, parent: null, mine: true, status: r.column_name });
  const all = rows.map(task);
  if (style === 'technical') return { text: '', tasks: all };
  const head = `# Statusfrage\nAntwortstil: ${STYLE_LABEL[style]}\nVom System ermittelt aus deinen offenen Arbeitspaketen im Thema (Stand jetzt; vollständig, nichts dazuerfinden):\n`;
  if (style === 'text') return { text: `${head}Daten: Liste „Deine offenen Arbeitspakete zum Thema“ und Kennzahlen unten.\n${STYLE_HOW.text}\n`, tasks: all };
  if (style === 'compact') return { text: `${head}Anzahlen: ${countsLine(counts)}\n${STYLE_HOW.compact}\n`, tasks: [] };
  const dated = all.filter((t) => t.due).slice(0, MANAGEMENT_MAX);
  return { text: `${head}Anzahlen: ${countsLine(counts)}\n${dated.length ? `Die nächsten fälligen Arbeitspakete (höchstens ${MANAGEMENT_MAX}, nur mit Termin):\n${dated.map((t) => `- ${t.ref} „${cut(t.title, 80)}“ · fällig ${dm(t.due)}`).join('\n')}\n` : ''}${STYLE_HOW.management}\n`, tasks: dated };
}

export interface KeyFigures { open: number; active: number; dueWeek: number; overdue: number; blocked: number; waiting: number }
/**
 * Kennzahlen des Themas, vom System per SQL berechnet (das Modell zählt nie selbst): offen = nicht erledigt; in Arbeit =
 * aktive Spalte oder „In Prüfung“ (Art review, wie bei der Eskalation; nicht Geplant, Zurückgestellt oder erledigt); fällig diese Woche = Termin von heute bis Sonntag (Europe/Berlin);
 * überfällig = Termin vor heute; blockiert; wartet = Wartezustand des Agenten gesetzt. Ohne taskIds zählen die Arbeitspakete
 * der Projekte (keine Aufgaben), mit taskIds diese Arbeitspakete und ihre Aufgaben. Sichtbarkeit wie der Kontext: im Projektkanal
 * ohne eingeschränkte Teilprojekte, in Direktnachrichten nur, was der Absender sieht.
 */
export async function keyFigures(db: Db, q: { projectIds: string[]; taskIds?: string[] | null; viewerId: string | null; now?: Date }): Promise<KeyFigures> {
  const { today, sunday } = berlinWeek(q.now ?? new Date());
  const ids = q.taskIds?.length ? q.taskIds : null;
  const r = await db.one(
    `select count(*) filter (where not c.is_done)::int as open,
            count(*) filter (where c.kind in ('active', 'review'))::int as active,
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
const CLAIM_ACT = 'angelegt|erstellt|gesendet|geschickt|verschickt|versendet|verschoben|umgehängt|zugeordnet|umgewandelt|zugewiesen|erledigt|abgeschlossen|freigegeben|gesetzt';
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
  // Vollzug ohne Person („ist bereits angelegt“, „wurde schon gesendet“) ohne Kennung: Behauptung aus früheren Antworten statt aus dem Kontext
  const passive = acted ? null : new RegExp(`\\b(ist|sind|wurde|wurden)\\b${inner}\\b(bereits|schon)\\b${inner}\\b(angelegt|erstellt|gesendet|geschickt|verschickt|versendet|eingetragen|gebucht)\\b`, 'i');
  const claims = (s: string) => patterns.some((p) => { const m = s.match(p); return Boolean(m) && !/\b(nicht|nichts|nie|kein\w*)\b/i.test(m![0]); })
    || Boolean(passive && passive.test(s) && !/\b[A-Z][A-Z0-9]{1,9}-\d+\b/.test(s) && !/\b(nicht|nichts|nie|kein\w*)\b/i.test(s));
  const replaced: string[] = [];
  // Punkte in Zahlen und Daten („6.–8.11.“, „24.10.“) beenden keinen Satz
  const DOT = '\u0000';
  const text = reply.replace(/(\d)\./g, `$1${DOT}`).replace(/[^.!?\n]+[.!?]*/g, (s) => {
    const core = s.trim();
    if (!core || !claims(core)) return s;
    replaced.push(core);
    return `${s.match(/^\s*/)![0]}Das konnte ich nicht ausführen: „${core.replace(/[.!?]+$/, '')}“.`;
  }).split(DOT).join('.');
  return { text, replaced: replaced.map((r) => r.split(DOT).join('.')) };
}

export interface AgentChatResult { status: 'ok' | 'error' | 'skipped'; reply?: string; notes?: { taskId: string; text: string }[]; scope?: ChatScope; error?: string; results?: { type: string; status: string; text: string }[] }

/** Datum dd.mm. in Europe/Berlin. */
const dmy = (d: string | Date) => new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Berlin' });
/** Fristen des Wartezustands für den Chat-Kontext. */
const waitDates = (w: { remindAt?: string | null; escalateAt?: string | null; reminded?: boolean; escalated?: boolean }) => {
  const parts = [w.remindAt ? `Nachfassen ${dmy(w.remindAt)}${w.reminded ? ' (erledigt)' : ''}` : '', w.escalateAt ? `Eskalation ${dmy(w.escalateAt)}${w.escalated ? ' (erledigt)' : ''}` : ''].filter(Boolean);
  return parts.length ? ` (${parts.join(', ')})` : '';
};
const READY_RE = /(?<!\p{L})(?:ich bin (?:bereit|da|startklar)|was (?:soll|kann) ich (?:für dich |heute )?(?:tun|erledigen|machen)|wie kann ich (?:dir )?helfen)(?!\p{L})/iu;
/** Antwort, die nur Bereitschaft meldet („Ich bin bereit. Was soll ich erledigen?“) statt die Nachricht zu beantworten. */
export const bareReady = (reply: string) => reply.trim().length <= 160 && READY_RE.test(reply);

/** Ganze Nachricht ist ein Markerwort bzw. Knopfwert („allgemein“, „persönlich“, „Projekt WEB“, „WEB“). */
const bareMarker = (body: string) => { const n = norm(body); return GENERAL_MARKERS.includes(n) || PERSONAL_MARKERS.includes(n) || /^(?:projekt )?[a-z0-9-]{2,12}$/.test(n); };
/**
 * Antwort auf eine Rückfrage des Agenten (Direktnachricht): Die Nachricht ist nur ein Knopfwert oder Markerwort, und im selben
 * Thread bzw. DM-Verlauf steht eine offene choices-Karte (ohne chosen, höchstens 1 Tag alt, keine Antwort des Agenten danach),
 * oder die letzte Antwort des Agenten trug eine Annahme (meta.assumed). Ergebnis: feste Absicht und die Ursprungsnachricht.
 */
export async function choiceAnswer(db: Db, q: { channelId: string; threadId: string | null; agentId: string; orgId: string; body: string; at: string | Date }): Promise<{ forced: ForcedIntent; forMessageId: string; cardId: string | null; value: string } | null> {
  if (!bareMarker(q.body)) return null;
  const projects: ScopeProject[] = (await db.query(`select id, key, name from projects where org_id = $1`, [q.orgId])).rows;
  const marker = intentMarker(q.body, projects);
  if (!marker) return null;
  const forced: ForcedIntent = marker.intent === 'project' ? { intent: 'project', projectId: marker.project.id } : { intent: marker.intent };
  const value = marker.intent === 'project' ? `Projekt ${marker.project.key}` : marker.intent === 'personal' ? 'persönlich' : 'allgemein';
  const noReplyAfter = `not exists (select 1 from chat_messages a where a.channel_id = m.channel_id and a.thread_id is not distinct from m.thread_id and a.user_id = $4 and a.kind = 'user' and a.deleted_at is null and a.created_at > m.created_at)`;
  const card = await db.maybeOne(
    `select m.id, m.meta from chat_messages m where m.channel_id = $1 and m.thread_id is not distinct from $2 and m.kind = 'system' and m.meta->>'card' = 'choices' and m.meta->>'chosen' is null
       and m.deleted_at is null and m.created_at < $3::timestamptz and m.created_at > $3::timestamptz - interval '1 day' and ${noReplyAfter} order by m.created_at desc limit 1`, [q.channelId, q.threadId, q.at, q.agentId]);
  if (card) {
    const meta = (typeof card.meta === 'string' ? JSON.parse(card.meta) : card.meta) ?? {};
    const choices: ChatChoice[] = Array.isArray(meta.choices) ? meta.choices : [];
    // Projekt auch ohne Knopf (bei vielen Projekten „Kürzel nennen“); persönlich/allgemein nur, wenn die Karte den Knopf hat
    if (marker.intent === 'project' || choices.some((c) => c.value === value)) return { forced, forMessageId: String(meta.forMessageId ?? ''), cardId: card.id, value };
  }
  const assumed = await db.maybeOne(
    `select m.meta from chat_messages m where m.channel_id = $1 and m.thread_id is not distinct from $2 and m.user_id = $4 and m.kind = 'user' and m.meta->>'assumed' is not null and m.meta->>'forMessageId' is not null
       and m.deleted_at is null and m.created_at < $3::timestamptz and m.created_at > $3::timestamptz - interval '1 day' and ${noReplyAfter} order by m.created_at desc limit 1`, [q.channelId, q.threadId, q.at, q.agentId]);
  if (!assumed) return null;
  const meta = (typeof assumed.meta === 'string' ? JSON.parse(assumed.meta) : assumed.meta) ?? {};
  return { forced, forMessageId: String(meta.forMessageId), cardId: null, value };
}

/** Halbsatz zur Annahme der Absicht (guess), einmal je Thread. */
export function assumptionHint(scope: ChatScope): string {
  const alt = scope.personalId ? ' oder „persönlich“' : '';
  if (scope.intent === 'general') return `(Ich antworte allgemein, ohne Projektbezug – nenn ein Projekt${alt}, wenn es um etwas Konkretes geht.)`;
  if (scope.intent === 'personal') return `(Ich nehme dein persönliches Projekt – sag „allgemein“ oder nenn ein Projekt, wenn ich falsch liege.)`;
  return `(Ich nehme Projekt ${scope.projects.map((p) => p.key).join(', ')} – sag „allgemein“${alt} oder nenn ein anderes Projekt, wenn ich falsch liege.)`;
}

export async function runAgentChat(db: Db, fetchFn: typeof fetch, agentId: string, channelId: string, messageId: string, now = new Date()): Promise<AgentChatResult> {
  const agent = await db.maybeOne(`select id, name, org_id, persona, agent_role, agent_project_id, status_style from users where id = $1 and kind = 'agent' and active`, [agentId]);
  if (!agent) return { status: 'skipped', error: 'Agent nicht aktiv' };
  const channel = await db.maybeOne(`select * from chat_channels where id = $1 and org_id = $2`, [channelId, agent.org_id]);
  // Assistent (D): antwortet nur auf Direktnachrichten, Erwähnungen im Projektkanal ignoriert er
  if (channel && channel.kind === 'project' && agent.agent_role === 'assistant') return { status: 'skipped', error: 'Assistent antwortet nur auf Direktnachrichten' };
  const isAssistant = agent.agent_role === 'assistant';
  /** Antwortstil auf Statusfragen (Standard nach Rolle) */
  const style: StatusStyle = agent.status_style ?? defaultStatusStyle(agent.agent_role);
  let msg = await db.maybeOne(`select m.*, u.name as user_name from chat_messages m join users u on u.id = m.user_id where m.id = $1 and m.channel_id = $2 and m.kind = 'user' and m.deleted_at is null`, [messageId, channelId]);
  if (!channel || !msg || msg.user_id === agent.id) return { status: 'skipped' };
  /** Die eingegangene Nachricht; msg ist bei einer Antwort auf die Rückfrage die Ursprungsnachricht, die damit beantwortet wird. */
  const trigger = msg;
  let forced: ForcedIntent | null = null;
  if (channel.kind !== 'project') {
    const picked = await choiceAnswer(db, { channelId: channel.id, threadId: msg.thread_id ?? null, agentId: agent.id, orgId: agent.org_id, body: msg.body, at: msg.created_at });
    if (picked) {
      const orig = await db.maybeOne(`select m.*, u.name as user_name from chat_messages m join users u on u.id = m.user_id where m.id = $1 and m.channel_id = $2 and m.user_id = $3 and m.kind = 'user' and m.deleted_at is null`, [picked.forMessageId, channel.id, msg.user_id]);
      if (orig) {
        msg = orig; forced = picked.forced;
        if (picked.cardId) await db.query(`update chat_messages set meta = coalesce(meta, '{}'::jsonb) || $2::jsonb where id = $1`, [picked.cardId, JSON.stringify({ chosen: picked.value })]);
      }
    }
  }
  let project: any = null;
  if (channel.kind === 'project') {
    project = await db.maybeOne(`select p.id, p.key, p.name from projects p join project_members m on m.project_id = p.id and m.user_id = $2 where p.id = $1`, [channel.project_id, agent.id]);
    if (!project) return { status: 'skipped', error: 'Agent ist kein Mitglied des Projekts' };
  } else if (!(await db.maybeOne(`select 1 from chat_channel_members where channel_id = $1 and user_id = $2`, [channel.id, agent.id]))) return { status: 'skipped' };
  // Im Projektkanal antwortet der Agent im Thread der Nachricht; in Direktnachrichten direkt, im Thread, wenn die Person dort schreibt
  const threadId: string | null = msg.thread_id ?? (channel.kind === 'project' ? msg.id : null);

  /** Antwort im Chat; die Meldung an den Absender trägt note statt des Texts (volle Begründung, die der Kanal nicht zeigt). */
  // meta.projectId: Thema der Antwort (eindeutiges Projekt), damit Bewertungen in Direktnachrichten einem Projekt zugeordnet sind
  // meta.assumed/forMessageId: Antwort mit Annahme der Absicht (ein Markerwort danach beantwortet forMessageId mit fester Absicht)
  const post = async (body: string, note = body, meta: Record<string, unknown> | null = null) => {
    await db.query(`insert into chat_messages (channel_id, user_id, thread_id, body, meta) values ($1,$2,$3,$4,$5)`, [channel.id, agent.id, threadId, body.slice(0, 8000), meta ? JSON.stringify(meta) : null]);
    await db.query(`insert into chat_channel_members (channel_id, user_id, last_read_at) values ($1,$2,now()) on conflict (channel_id, user_id) do update set last_read_at = now()`, [channel.id, agent.id]);
    const link = threadId ? `/chat/${channel.id}?thread=${threadId}` : `/chat/${channel.id}`;
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

  // Kein Gedächtnis über Gespräche hinweg: Dialog nur im Thread (Ursprung und Antworten; ist der Ursprung eine Antwort des
  // Agenten, auch die Nachricht der Person davor). Außerhalb eines Threads nur die Nachrichten seit seiner letzten Antwort.
  const COLS = `m.id, m.body, m.created_at, m.kind, u.name, u.id as uid`;
  const history = threadId
    ? await db.query(`select ${COLS} from chat_messages m left join users u on u.id = m.user_id where (m.id = $1 or m.thread_id = $1) and m.deleted_at is null order by m.created_at desc limit 20`, [threadId])
    : await db.query(`select ${COLS} from chat_messages m left join users u on u.id = m.user_id where m.channel_id = $1 and m.thread_id is null and m.deleted_at is null and m.kind = 'user'
        and m.created_at > coalesce((select max(x.created_at) from chat_messages x where x.channel_id = $1 and x.thread_id is null and x.user_id = $2 and x.created_at <= $3::timestamptz), '-infinity'::timestamptz)
        and m.created_at <= $3::timestamptz order by m.created_at desc limit 8`, [channel.id, agent.id, trigger.created_at]);
  if (threadId && history.rows.length) {
    const root = history.rows[history.rows.length - 1];
    if (root.uid === agent.id) {
      const before = await db.maybeOne(`select ${COLS} from chat_messages m left join users u on u.id = m.user_id where m.channel_id = $1 and m.thread_id is null and m.deleted_at is null and m.kind = 'user' and m.user_id <> $2 and m.created_at < $3 order by m.created_at desc limit 1`, [channel.id, agent.id, root.created_at]);
      if (before) history.rows.push(before);
    }
  }
  // Antwort auf die Rückfrage: die Ursprungsfrage liegt vor der Rückfrage des Agenten, sie gehört in den Verlauf
  if (msg.id !== trigger.id && !history.rows.some((h: any) => h.id === msg.id)) history.rows.push({ id: msg.id, body: msg.body, created_at: msg.created_at, kind: 'user', name: msg.user_name, uid: msg.user_id });
  // Thema der Nachricht (Abschnitt 6 des Agenten-Konzepts): bestimmt das System, nicht das Modell
  const scope = await resolveChatScope(db, { channel, message: msg, history: history.rows, senderId: msg.user_id, agent, forced }, now);
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
  // Genanntes Projekt, in dem die Person Mitglied ist, der Agent aber nicht: sagen, wie er dazukommt (statt nur „nichts sagen“)
  const notIn = scope.hidden.length ? (await db.query(`select p.key, p.name from projects p join project_members m on m.project_id = p.id and m.user_id = $1 where p.org_id = $2 and p.key = any($3::text[]) and not exists (select 1 from project_members a where a.project_id = p.id and a.user_id = $4)`, [msg.user_id, agent.org_id, scope.hidden.map((h) => h.split('-')[0]), agent.id])).rows : [];
  const notInText = notIn.length ? `In ${notIn.map((p: any) => `${p.key} „${p.name}“`).join(', ')} bin ich nicht Mitglied, dort kann ich nichts nachsehen oder anlegen; ${isAssistant ? 'als dein Assistent arbeite ich nur in deinem persönlichen Projekt' : 'die PL lädt mich unter Projekt › Einstellungen › KI ein'}.` : '';
  const hiddenRest = scope.hidden.filter((h) => !notIn.some((p: any) => p.key === h.split('-')[0]));
  if (scope.how === 'mentioned' && !scope.projectIds.length) return direct(notInText ? `${notInText}${hiddenRest.length ? ' Zu weiterem kann ich dir hier nichts sagen.' : ''}` : 'Dazu kann ich dir hier nichts sagen.', `Thema ohne gemeinsame Freigabe: ${scope.hidden.join(', ')}`);
  // Assistent ohne nutzbares persönliches Projekt (Freigabe der Person entzogen, Notaus): Grund statt Hilfe zum Projektbeitritt
  if (!project && isAssistant && !scope.personalId && agent.agent_project_id) {
    const why = await aiAllowed(db, { userId: msg.user_id, projectId: agent.agent_project_id, feature: 'agent.chat' });
    return direct(`Ich kann gerade nicht für dich arbeiten: ${why.allowed ? 'mein Einsatz in deinem persönlichen Projekt ist gesperrt' : why.reason}.`, `Assistent gesperrt: ${why.allowed ? 'Agent im persönlichen Projekt gesperrt' : why.reason}`);
  }
  // Kein gemeinsames, beidseitig freies Projekt: Hilfe und Hinweis statt Schweigen (ohne LLM-Aufruf)
  if (!project && (scope.how === 'all' || scope.how === 'status' || scope.how === 'general') && !scope.projects.length) {
    return direct(`Hallo ${msg.user_name.split(' ')[0]}, wir haben noch kein gemeinsames Projekt, in dem ich für dich arbeiten darf. Ich kann Arbeitspakete vorantreiben, Rückfragen klären, Termine vorschlagen, Mails zu Aufgaben beantworten und Doku pflegen. Dafür nimmt mich die Projektleitung als Mitglied oder Projektagent ins Projekt auf und gibt dir dort „KI nutzen“; danach frag mich einfach hier oder im Projektkanal mit @${agent.name}.`, 'kein gemeinsames Projekt: Hilfe und Hinweis');
  }
  // Absicht unsicher (mehrere Kandidaten ohne Anhaltspunkt oder Treffer in mehreren Projekten): Rückfrage mit Knöpfen
  // (Systemkarte choices), keine Inhalte, kein LLM-Aufruf. Höchstens 6 Projektknöpfe; bei mehr die 5 mit den meisten Treffern.
  if (scope.confidence === 'unsure') {
    const personalId = scope.personalId ?? null;
    const count = (p: ScopeProject) => { const h = scope.hits?.get(p.id); return h ? h.pages.length + h.tasks.length : 0; };
    const shared = (scope.common ?? scope.projects).filter((p) => p.id !== personalId).sort((a, b) => count(b) - count(a) || a.key.localeCompare(b.key));
    const more = shared.length > 6;
    const shown = more ? shared.slice(0, 5) : shared;
    const choices: ChatChoice[] = [
      ...shown.map((p) => ({ label: `Projekt ${p.key} – ${p.name}`, value: `Projekt ${p.key}`, ...(count(p) ? { hint: `${count(p)} Treffer zur Nachricht` } : {}) })),
      ...(personalId ? [{ label: 'Persönlich (mein Projekt)', value: 'persönlich', hint: 'eigene Aufgaben, Erinnerungen, Notizen' }] : []),
      { label: 'Allgemein (kein Projekt)', value: 'allgemein', hint: 'Wissensfrage, Formulierungshilfe, Frage zum Tool' }
    ];
    const names = shown.map((p) => `${p.name} (${p.key})`);
    const reply = `Zu welchem Projekt? ${names.join(', ')}${more ? ' oder ein anderes (Kürzel nennen)' : ''}${personalId ? ', persönlich (dein Projekt)' : ''} oder allgemein (kein Projekt)? Klick unten oder antworte mit Kürzel${personalId ? ', „persönlich“' : ''} oder „allgemein“.`;
    const r = await direct(reply, 'Rückfrage: Thema nicht eindeutig');
    await systemMessage(db, { channelId: channel.id, threadId, body: 'Thema wählen:', meta: { card: 'choices', choices, forMessageId: msg.id } });
    return r;
  }

  // Eigene offene Arbeitspakete zum Thema: im Projektkanal ohne eingeschränkte Teilprojekte (alle Mitglieder lesen mit), in
  // Direktnachrichten nur Teilprojekte, die die fragende Person sieht; genannte Arbeitspakete begrenzen die Liste auf sich und ihre Aufgaben
  const taskIds = scope.taskIds.length ? scope.taskIds : null;
  const tasks = scope.projectIds.length ? await db.query(
    `select t.id, t.project_id, t.subproject_id, t.number, t.title, t.due_date, t.agent_wait, t.agent_paused, t.agent_next_check_at, t.blocked, t.blocked_reason, c.name as column_name, p.key, pt.title as parent_title,
       (select string_agg(i.title, ' | ' order by i.position) from checklist_items i where i.task_id = t.id and not i.done) as open_items,
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
  // Statusfrage im Stil compact oder management: nur der Abschnitt „Statusfrage“ nennt Aufgaben (keine Listen, Kennzahlen, Treffer daneben)
  const isStatus = Boolean(scope.status) || scope.how === 'status';
  const lean = isStatus && (style === 'compact' || style === 'management');
  // Kennzahlen je Thema (bei „alle“ je Projekt eine Zeile), vom System berechnet
  const viewerId = project ? null : msg.user_id;
  const figures: string[] = [];
  if (lean) { /* Anzahlen stehen im Abschnitt „Statusfrage“ */ }
  else if (scope.taskIds.length) figures.push(keyFiguresLine(scope.refs.join(', '), await keyFigures(db, { projectIds: scope.projectIds, taskIds: scope.taskIds, viewerId, now })));
  else if (scope.how !== 'general') for (const p of scope.projects) figures.push(keyFiguresLine(p.key, await keyFigures(db, { projectIds: [p.id], viewerId, now })));
  const HOW: Record<ChatScopeHow, string> = { matched: 'über Inhalte zugeordnet: Treffer nur in diesem Projekt', open: 'über Inhalte: Treffer in mehreren Projekten, ordne zu oder frag nach', channel: 'Projekt dieses Kanals', mentioned: 'in der Nachricht genannt', history: 'zuletzt im Thread genannt', all: scope.projects.length > 1 ? 'alle gemeinsamen Projekte, ausdrücklich gefragt' : 'einziges gemeinsames Projekt', status: 'Statusfrage: alle gemeinsamen Projekte', ask: '', personal: 'persönliches Projekt des Absenders, weil die Nachricht kein anderes Projekt nennt', general: '', chosen: 'auf deine Rückfrage gewählt' };
  const theme = scope.how === 'general'
    ? `allgemeine Anfrage ohne Projektbezug (kein Projektkontext): antworte nur allgemein, ohne Inhalte, Stände oder Kennzahlen aus Projekten und ohne Befehle oder Notizen. Braucht die Person etwas aus einem Projekt oder von dir als Assistent, verweise darauf (Projekt nennen bzw. „persönlich“ schreiben). Fragen zum Tool beantwortest du kurz und verweist auf die Hilfe (Kurzanleitung und Handbuch) mit dem Link /hilfe`
    : scope.projects.length
      ? `${scope.refs.length ? `Arbeitspaket ${scope.refs.join(', ')} in ` : ''}Projekt ${scope.projects.map((p) => `${p.key} „${p.name}“`).join(', ')} (${HOW[scope.how]})`
      : `kein gemeinsames Projekt mit ${msg.user_name}; du kannst nur allgemein antworten`;
  // Persönliches Projekt ohne weiteren Kontext: passende Doku-Seiten (Suche nach der Nachricht, sonst die neuesten) als Wissensquelle
  let personalDocs = '';
  if (scope.intent === 'personal' && scope.projectIds.length === 1 && !lean) {
    const found = await knowledgeSearch(db, { projectId: scope.projectIds[0], agentId: agent.id, query: msg.body, viewerId: msg.user_id, maxTitles: 8, maxExcerpts: 3 });
    // Neueste Seiten nur aus Ordnern, die der Agent sehen darf (Agent-Zugriff und Schalter „für KI-Agenten“)
    const access = found.pages.length ? null : await folderAccessMap(db, scope.projectIds[0]);
    const pages = found.pages.length ? found.pages : (await db.query(`select p.id, p.title, p.status, p.folder_id, f.name as folder from doc_pages p left join doc_folders f on f.id = p.folder_id where p.project_id = $1 and p.deleted_at is null order by p.updated_at desc limit 30`, [scope.projectIds[0]])).rows.filter((p: any) => !p.folder_id || access!.get(p.folder_id) !== 'none').slice(0, 8).map((p: any) => ({ id: p.id, title: p.title, status: p.status, folder: p.folder ?? null, excerpt: null as string | null }));
    personalDocs = pages.length ? `Doku im persönlichen Projekt (${found.pages.length ? 'passend zur Nachricht' : 'neueste Seiten'}; Auskunft nur daraus und aus den Arbeitspaketen unten):\n${pages.map((p) => `- „${p.title}“ (${p.folder ?? 'ohne Ordner'}, ${p.status})${p.excerpt ? `\n  ${cut(p.excerpt, 600)}` : ''}`).join('\n')}\n` : '';
  }
  // Wissen zur Zuordnung (Direktnachricht): Treffer der Inhaltssuche je Projekt und eine Übersicht aller gemeinsamen Projekte
  let knowledge = '';
  if (scope.hits?.size) knowledge += `Treffer zur Nachricht in Doku und Arbeitspaketen (nur, was du und ${msg.user_name} sehen dürft):\n${scope.projects.filter((p) => scope.hits!.has(p.id)).map((p) => `## ${p.key} „${p.name}“\n${searchText(scope.hits!.get(p.id)!)}`).join('\n')}\n`;
  // Mails und Dateien zur Nachricht: EINE Suche über alle Projekte des Themas (Vereinigung der Ansichten bzw. Dateiquellen, jede
  // Mail und Datei einmal); in Direktnachrichten nur, was auch die fragende Person lesen darf, im Projektkanal nur Ansichten, die
  // alle Mitglieder lesen dürfen. Im Chat gibt es keine Leserunden: nur Ausschnitte, ganze Mails/Dateien liest der Lauf am Arbeitspaket
  if (scope.how !== 'general' && scope.projectIds.length && tokens(msg.body).length && !small && !lean) {
    const src = await searchSources(db, { projectIds: scope.projectIds, agentId: agent.id, viewerId: project ? null : msg.user_id, allMembers: Boolean(project), query: msg.body, source: ['mails', 'files'], max: 6 });
    if (src.mails?.length || src.files?.length) knowledge += `Treffer zur Nachricht in Mails und Dateien (nur, was du und ${project ? 'alle Mitglieder des Kanals' : msg.user_name} lesen dürft; nur Ausschnitte, Quelle nennen):\n${[src.mails?.length ? mailHitsText(src.mails) : '', src.files?.length ? fileHitsText(src.files) : ''].filter(Boolean).join('\n')}\n`;
  }
  if (!project && (scope.common?.length ?? 0) > 1 && scope.how !== 'general') {
    const ov = await db.query(`select p.id, p.key, p.name, p.description, ${SQL.isPersonal('p')} as own, (select string_agg(x.name, ', ' order by x.position) from (select s2.id as subproject_id, s2.name, s2.position from subprojects s2 where s2.project_id = p.id) x where ${visibleSubprojectSql(2, 'x')} and ${visibleSubprojectSql(3, 'x')}) as sps from projects p where p.id = any($1::uuid[]) order by p.key`, [scope.common!.map((p) => p.id), msg.user_id, agent.id]);
    if (ov.rows.length) knowledge += `Gemeinsame Projekte (nur zur Zuordnung; Inhalte nur aus dem Thema und den Treffern):\n${ov.rows.map((p: any) => `- ${p.key} „${p.name}“${p.own ? ' (persönliches Projekt des Absenders)' : ''}${p.description ? `: ${cut(String(p.description).replace(/\s+/g, ' '), 160)}` : ''}${p.sps ? ` · Teilprojekte: ${cut(p.sps, 160)}` : ''}`).join('\n')}\n`;
  }
  // Assistent: fester Block zum Selbstbild (ASSISTANT_RULES), dahinter Name, Inhaber und Stil
  const owner = isAssistant && agent.agent_project_id ? await db.maybeOne(`select u.name from projects p join users u on u.id = p.created_by where p.id = $1`, [agent.agent_project_id]) : null;
  const system = isAssistant
    ? `${AGENT_SHEET}\n\n${CHAT_RULES}\n\n${DATA_RULE}\n\n${ASSISTANT_RULES}\n\n# Du\nDu bist „${agent.name}“, persönlicher Assistent von ${owner?.name ?? msg.user_name} (Inhaber) im Projekttool. ${styleText(agent.persona)}`
    : `${AGENT_SHEET}\n\n${CHAT_RULES}\n\n${DATA_RULE}\n\n# Du\nDu bist „${agent.name}“, KI-Agent im Projekttool. ${styleText(agent.persona)}`;
  // Statusfrage oder Gruß an den Assistenten: was im persönlichen Projekt ansteht, vom System ermittelt
  const greeting = small && Boolean(scope.status);
  // Aufgaben, die der Abschnitt nennt: Karte „tasks“ unter der Antwort (außer im Stil compact)
  let statusText = '';
  let statusTasks: StatusTask[] = [];
  if (scope.status && scope.projectIds.length === 1) {
    const brief = await statusBrief(db, { projectId: scope.projectIds[0], personId: msg.user_id, agentId: agent.id, now });
    statusText = statusBriefText(brief, greeting, style);
    statusTasks = statusBriefTasks(brief, greeting, style);
  } else if (scope.how === 'status' && scope.projectIds.length) {
    const { today, sunday } = berlinWeek(now);
    const due = (t: any) => d10(t.due_date);
    const rows = tasks.rows as any[];
    const meetingsToday = (await db.one(`select count(*)::int as c from meetings where project_id = any($1::uuid[]) and starts_at >= ($2::date)::timestamp at time zone 'Europe/Berlin' and starts_at < ($2::date + 1)::timestamp at time zone 'Europe/Berlin'`, [scope.projectIds, today])).c as number;
    const questionsOpen = (await db.one(`select count(*)::int as c from questions where project_id = any($1::uuid[]) and status = 'open' and (asked_by = $2 or addressee_id = $3)`, [scope.projectIds, agent.id, msg.user_id])).c as number;
    const counts: StatusCounts = { overdue: rows.filter((t) => due(t) && due(t) < today).length, today: rows.filter((t) => due(t) === today).length, week: rows.filter((t) => due(t) > today && due(t) <= sunday).length, noDate: rows.filter((t) => !due(t)).length, later: rows.filter((t) => due(t) > sunday).length, meetingsToday, questions: questionsOpen };
    const ps = projectStatusText(rows, counts, style);
    statusText = ps.text;
    statusTasks = ps.tasks;
  }
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
  const personalOf = async () => (scope.common?.length ? await db.maybeOne<ScopeProject>(`select p.id, p.key, p.name from projects p join project_members m on m.project_id = p.id and m.user_id = $1 and m.role = 'pl' where ${SQL.isPersonal('p')} and p.id = any($2::uuid[]) limit 1`, [msg.user_id, scope.common.map((p) => p.id)]) : null);
  const cmdProject = project ?? (scope.how !== 'general' && scope.projects.length === 1 ? scope.projects[0] : scope.how === 'open' ? await personalOf() : null);
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
  const ctxCmd: CommandCtx = { db, agent, sender: { id: msg.user_id, name: msg.user_name, orgId: agent.org_id }, project: cmdProject, projects: scope.common?.length ? scope.common : scope.projects, channelId: channel.id, threadId, messageId: msg.id, now, policy };
  const prompt = `Jetzt: ${hhmm(now)} · Heute: ${calendarText(now, 10)}
Gespräch: ${project ? `Projektkanal ${project.key} „${project.name}“${threadId ? ' (Thread)' : ''}` : `Direktnachricht mit ${msg.user_name}`}
Thema: ${theme}
${scope.intent === 'personal' ? `Rolle: Du bist hier persönlicher Assistent von ${msg.user_name}.\n` : ''}Absender: ${msg.user_name} – ${scope.how === 'general' ? 'allgemeine Anfrage: keine Befehle, keine Notizen' : commandsText(role, allowed, policy)}${scope.how === 'open' ? ` · Projekt für Aufträge: order.project (Kürzel) setzen${cmdProject ? `, sonst ${cmdProject.key}` : ''}` : cmdProject || scope.how === 'general' ? '' : scope.projects.length > 1 ? ' · Projekt für Aufträge nicht eindeutig: order.project (Kürzel) setzen oder nachfragen' : ''}
${policy ? `Agenten-Policy${scopeTask ? ` für ${scope.refs[0]}` : ` im Projekt ${cmdProject!.key}`}: ${policyText(policy)} Aufträge im Chat: ${policy.chatOrders} (${policy.origin.chatOrders}).\n` : ''}${approvals.rows.length ? `Offene Bestätigungen von dir (approve/reject zeigt die Karte; die Person entscheidet per Klick):
${approvals.rows.map((q: any) => `- ${q.key}${q.number ? `-${q.number}` : ''} „${q.title ?? ''}“: ${cut(q.body.replace(/\n/g, ' '), 200)}`).join('\n')}
` : ''}Fähigkeiten: Mails senden ${canMail ? 'direkt (Außenprüfung, erster Kontakt als Entwurf)' : 'nur als Entwurf zur Freigabe'}; Postfächer und Mail-Eingang siehst du im Chat nicht (zu Mails nur, was in Arbeitspaketen und unter „Treffer zur Nachricht in Mails und Dateien“ steht; ganze Mails und Dateien liest du erst im Lauf am Arbeitspaket); Online-Recherche ${web?.ok ? `freigegeben (heute noch ${web.left} Suchen)` : `nicht freigegeben${web && !web.ok ? ` (${web.reason})` : ''}`}.
${statusText}${personalDocs}${knowledge}${openQs.rows.length ? `Deine offenen Fragen hier (questionId für answers; nur zur Zuordnung, nicht ungefragt erwähnen):\n${openQs.rows.map((q: any) => `- ${q.key}${q.number ? `-${q.number}` : ''} seit ${hhmm(q.created_at)}: ${cut(q.body, 240)} (questionId ${q.id})`).join('\n')}\n` : ''}${figures.length ? `${figures.join('\n')}\n` : ''}Deine offenen Arbeitspakete zum Thema:
${lean ? '– siehe Abschnitt „Statusfrage“ –' : tasks.rows.map((t: any) => `- ${t.key}-${t.number} „${t.title}“${t.parent_title ? ` (Aufgabe in „${t.parent_title}“)` : ''} · ${t.column_name}${t.due_date ? ` · fällig ${d10(t.due_date)}` : ''}${t.blocked ? ` · blockiert: ${t.blocked_reason ?? ''}` : ''}${t.agent_wait ? ` · du wartest auf: ${t.agent_wait.reason}${waitDates(t.agent_wait)}` : ''}${t.agent_next_check_at ? ` · Wiedervorlage ${dmy(t.agent_next_check_at)}` : ''}${t.agent_paused ? ' · Agent pausiert (eine fällige Frist hebt die Pause auf; run startet sofort)' : ''} (taskId ${t.id})${t.open_items ? `\n  Offene Tasks: ${cut(t.open_items, 500)}` : ''}${t.recent ? `\n  Log: ${cut(t.recent, 500)}` : ''}`).join('\n') || '– keine –'}
${otherAps.rows.length && !lean ? `Weitere offene Arbeitspakete im Thema (Kennung · Titel · Teilprojekt · zuständig; für order parent/ref und gegen Dubletten):
${otherAps.rows.map((t: any) => `- ${t.key}-${t.number} · ${cut(t.title, 60)}${t.sp ? ` · ${t.sp}` : ''}${t.resp ? ` · ${t.resp}` : ''}`).join('\n')}
` : ''}${named.rows.length ? `Genannte Arbeitspakete, für die du nicht zuständig bist (nur Stand, kein Log):\n${named.rows.map((t: any) => `- ${t.key}-${t.number} „${t.title}“ · ${t.column_name}${t.is_done ? ' (erledigt)' : ''}${t.due_date ? ` · fällig ${d10(t.due_date)}` : ''}${t.resp ? ` · zuständig ${t.resp}` : ''}${t.blocked ? ` · blockiert: ${t.blocked_reason ?? ''}` : ''}`).join('\n')}\n` : ''}Verlauf (älteste zuerst):
${[...history.rows].reverse().map((h: any) => `${hhmm(h.created_at)} ${h.kind === 'system' ? 'System' : h.uid === agent.id ? 'Du' : h.name}: ${cut(h.body, 600)}`).join('\n')}
${greeting ? `\nDie letzte Nachricht ist nur ein Gruß: Sie beantwortet keine deiner Fragen (keine answers, keine notes). Grüß kurz zurück wie im Abschnitt „Statusfrage“ beschrieben (onTopic false).` : small ? `\nDie letzte Nachricht ist nur ein Gruß oder eine Kurzmeldung ohne inhaltliche Rückmeldung: Sie beantwortet keine deiner Fragen (keine answers, keine notes)${openQs.rows.length ? ', deine offene Frage bleibt offen' : ''}. Antworte wie eine Kollegin, kurz und freundlich, ohne Projektinhalte und ohne Erinnerung an offene Fragen (onTopic false).` : scope.how === 'history' ? `\nDas Thema stammt aus dem Verlauf (${scope.refs[0] ?? scope.projects[0]?.key}); betrifft deine Antwort es nicht, setze onTopic false.` : ''}${scope.status && !small ? `\nDie letzte Nachricht ist eine Statusfrage an dich als Assistent: antworte aus dem Abschnitt „Statusfrage“ oben im dort genannten Antwortstil, keine Rückfrage, keine Bereitschaftsfloskel.` : ''}${scope.how === 'status' && style !== 'technical' ? `\nDie letzte Nachricht ist eine Statusfrage: antworte aus dem Abschnitt „Statusfrage“ oben im dort genannten Antwortstil. Keine Rückfrage und keine bloße Bereitschaftsfloskel; ist nichts offen, sag das konkret.` : ''}${scope.how === 'status' && style === 'technical' ? `\nDie letzte Nachricht ist eine Statusfrage: Gib einen knappen Stand aus den Daten oben (deine offenen Arbeitspakete mit Fälligkeit, worauf du wartest, Blockaden; offene Bestätigungen; Kennzahlen je Projekt). Keine Rückfrage und keine bloße Bereitschaftsfloskel; ist nichts offen, sag das konkret.` : ''}${scope.hidden.length ? `\nZu ${scope.hidden.join(', ')} schreibt das System selbst vor deine Antwort, dass du dazu hier nichts sagen kannst; geh darauf nicht ein.` : ''}${loggedRefs.length ? `\nDie letzte Nachricht steht bereits als Rückmeldung im Log von ${loggedRefs.join(', ')}; der Lauf an diesem Arbeitspaket setzt sie gleich um. Bestätige kurz, ohne anzukündigen, was du anlegst oder zuweist; keine Notiz, kein order.` : ''}
${msg.id !== trigger.id ? `Die letzte Nachricht „${cut(trigger.body, 80)}“ beantwortet nur deine Rückfrage nach dem Thema (es steht jetzt fest, siehe Thema). Beantworte damit die Nachricht davor von ${msg.user_name} inhaltlich: „${cut(msg.body, 400)}“.` : small ? `Antworte auf die letzte Nachricht von ${msg.user_name}.` : `Beantworte die letzte Nachricht von ${msg.user_name} inhaltlich; ein Gruß davor ist nur Anrede.`}`;
  try {
    type ChatJson = { reply?: string; notes?: { taskId: string; text: string }[]; answers?: { questionId: string; text: string }[]; commands?: ChatCommand[] };
    const ask = (p: string) => completeJson<ChatJson>(cfg, fetchFn, { meta: { feature: 'agent.chat', projectId: scope.projects.length === 1 ? scope.projects[0].id : null }, system, prompt: p, maxTokens: 1200, schema: SCHEMA });
    let r = await ask(prompt);
    // Nur Bereitschaft gemeldet, obwohl die Nachricht mehr als ein Gruß ist: ein zweiter Versuch mit Hinweis
    if (!small && bareReady(String(r.json.reply ?? ''))) {
      const again = await ask(`${prompt}\nDeine erste Antwort „${cut(String(r.json.reply), 160)}“ war nur eine Bereitschaftsmeldung. Beantworte jetzt die Frage bzw. Bitte selbst.`);
      r = { ...again, inputTokens: r.inputTokens + again.inputTokens, outputTokens: r.outputTokens + again.outputTokens };
    }
    const j = r.json;
    // Befehle: prüfen und ausführen, bevor gepostet wird; die Karte zeigt das tatsächliche Ergebnis
    // Antwort auf eine Frage des Agenten (steht schon im Log eines AP): keinen neuen Auftrag anlegen, den Lauf dort setzt sie um
    const cmds = (Array.isArray(j.commands) ? j.commands : []).filter((c) => c && COMMAND_TYPES.includes(c.type) && !(loggedRefs.length && c.type === 'order')).slice(0, 5);
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
    // Feedback sichern: ersetzte Behauptungen und nicht ausgeführte Befehle samt Nachricht der Person
    const fbBase = { orgId: agent.org_id, projectId: scope.projectIds[0] ?? channel.project_id ?? null, agentId: agent.id, userId: msg.user_id, sourceType: 'chat_message', sourceId: msg.id };
    if (checked.replaced.length) await recordFeedback(db, { ...fbBase, kind: 'claim_replaced', context: { input: msg.body, output: j.reply, replaced: checked.replaced, results } });
    for (const [i, x] of results.entries()) if (x.status === 'denied') await recordFeedback(db, { ...fbBase, sourceId: `${msg.id}#${i}`, kind: 'command_failed', context: { input: msg.body, output: j.reply, command: cmds.find((c) => c.type === x.type), reason: x.text } });
    // Bezugszeile setzt das System: nur bei einem Thema aus dem Verlauf und nur, wenn die Antwort es betrifft (onTopic; fehlt das Feld, gilt ja)
    const onTopic = (j as any).onTopic !== false && !small;
    const refLine = scope.how === 'history' && onTopic && scope.refs[0] && !/^Zu\s/.test(checked.text) ? `Zu ${scope.refs[0]}: ` : '';
    // Annahme (guess): im Halbsatz nennen, einmal je Thread (ohne Thread: einmal je 12 Stunden); die Antwort merkt sich die
    // Annahme (meta.assumed, forMessageId), damit ein Markerwort danach („allgemein“, „persönlich“, Kürzel) die Frage neu beantwortet
    let hint = '';
    if (scope.confidence === 'guess' && !small) {
      const prior = await db.maybeOne(`select 1 from chat_messages where channel_id = $1 and thread_id is not distinct from $2 and user_id = $3 and kind = 'user' and deleted_at is null and meta->>'assumed' is not null and created_at < $4::timestamptz ${threadId ? '' : `and created_at > $4::timestamptz - interval '12 hours'`} limit 1`, [channel.id, threadId, agent.id, now]);
      if (!prior) hint = ` ${assumptionHint(scope)}`;
    }
    const reply = `${notInText ? `${notInText} ` : ''}${hiddenRest.length ? `Zu ${hiddenRest.join(', ')} kann ich dir hier nichts sagen. ` : ''}${refLine}${checked.text}${hint}`;
    const meta: Record<string, unknown> = { ...(scope.projectIds.length === 1 ? { projectId: scope.projectIds[0] } : {}), ...(scope.confidence === 'guess' ? { assumed: scope.intent, forMessageId: msg.id } : {}) };
    // Statusantwort: die Aufgaben aus dem Abschnitt „Statusfrage“ in Reihenfolge, unsichtbar an der Antwort (meta.statusItems);
    // „übernimm 2“ bzw. eine Gruppe löst der Befehl take daraus auf
    if (statusTasks.length) meta.statusItems = statusItems(statusTasks.map((x) => ({ taskId: x.id, projectId: x.projectId, ref: x.ref, title: x.title, due: x.due, status: x.status })));
    await post(reply, reply, Object.keys(meta).length ? meta : null);
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
    await recordFeedback(db, { orgId: agent.org_id, projectId: channel.project_id ?? null, agentId: agent.id, userId: msg.user_id, kind: 'run_error', sourceType: 'chat_message', sourceId: msg.id, context: { input: msg.body, reason: err } });
    await post('Ich konnte gerade nicht antworten (Fehler beim KI-Dienst). Bitte später noch einmal versuchen.');
    return { status: 'error', error: err };
  }
}
