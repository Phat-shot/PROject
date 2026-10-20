import type { AudienceClass, ExternalProfile, OutboundFinding } from '@projekttool/shared';
import type { Db } from './db.js';
import { audit } from './audit.js';
import { notify } from './notify.js';
import { canSeeSubproject, visibleSubprojectSql } from './rights.js';
import { contactChain } from './tasks/service.js';
import { mailBodyOk, projectHumans } from './mail/origin.js';
import { complete, orgAiSettings, parseJson, type AiConfig } from './ai/client.js';
import { agentChatMessage } from './ai/plan.js';
import { USE_LATERAL } from './mail/accounts.js';

/**
 * Informationsgrenze für Externe (Anforderung 8): alles, was an Nicht-Interne hinausgeht, läuft hierüber.
 * Regel E (audienceOf) ordnet Empfänger ein; externalContext() schneidet den Außenkontext einer Aufgabe; composeExternal()
 * formuliert Agenten-Mails mit nur diesem Kontext neu (Stufe strict); checkOutbound() prüft deterministisch vor dem Versand;
 * recordCheck() protokolliert jede Prüfung (outbound_checks, Audit ai.outbound). Systemvorlagen ohne KI (Erinnerungen,
 * Eskalationsmail, Einladungen) und Freigabelinks von Menschen laufen nicht hierüber.
 */

const RANK: Record<AudienceClass, number> = { internal: 0, outside: 1, task_external: 2, unknown_external: 3 };
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** Adresse aus „Name <adresse>“ oder roh, klein geschrieben. */
export const normAddr = (v: unknown) => { const s = String(v ?? '').trim(); const m = s.match(/<([^>]+)>/); return (m ? m[1] : s).trim().toLowerCase(); };

export interface Audience { audience: AudienceClass; recipients: { email: string; audience: AudienceClass; userId: string | null }[] }

/** Intern: aktive Person, effektives Projektmitglied (direkt oder über Gruppe), sieht das Teilprojekt. */
export async function isInternal(db: Db, q: { projectId: string; subprojectId: string | null; userId: string }): Promise<boolean> {
  const m = await db.maybeOne(`select 1 from project_members m join users u on u.id = m.user_id where m.project_id = $1 and m.user_id = $2 and u.active and u.kind = 'person'`, [q.projectId, q.userId]);
  return Boolean(m) && (await canSeeSubproject(db, q.userId, q.subprojectId));
}

/** AP-Familie: das AP bzw. die Aufgabe selbst, das Über-AP und die Aufgaben darunter. */
const FAMILY = `with fam as (select id from tasks where id = $1 union select parent_id from tasks where id = $1 and parent_id is not null union select id from tasks where parent_id = $1 and deleted_at is null)`;

/**
 * Adressen mit Bezug zum AP: Zuständigkeit am AP, Über-AP, an Aufgaben darunter oder an einem Task, Mails am AP (Absender,
 * An, Cc), Teilnahme an einer verknüpften Besprechung. Ab P10 kommen gebuchte Person-Ressourcen, ab P11 task_access dazu.
 */
async function relatedAddresses(db: Db, taskId: string): Promise<Set<string>> {
  const r = await db.query(
    `${FAMILY}
     select responsible_email as e from tasks where id in (select id from fam) and responsible_email is not null
     union select responsible_email from checklist_items where task_id in (select id from fam) and responsible_email is not null
     union select m.from_addr from mail_task_links l join mails m on m.id = l.mail_id where l.task_id in (select id from fam)
     union select x from mail_task_links l join mails m on m.id = l.mail_id, jsonb_array_elements_text(m.to_json || m.cc_json) x where l.task_id in (select id from fam)
     union select a->>'email' from meeting_tasks mt join meetings mm on mm.id = mt.meeting_id, jsonb_array_elements(mm.attendees) a where mt.task_id in (select id from fam)
     union select r.email from resource_bookings b join resources r on r.id = b.resource_id where b.task_id in (select id from fam) and r.kind = 'person' and r.email is not null`,
    [taskId]);
  return new Set(r.rows.map((x: any) => normAddr(x.e)).filter(Boolean));
}

/**
 * Regel E: Klasse je Empfänger (internal, outside = Org-Benutzer ohne Projektzugriff oder ohne Sicht auf das Teilprojekt,
 * task_external = Bezug zum AP, unknown_external = alle übrigen); für die Nachricht gilt die strengste Klasse, ein externer
 * Cc macht die ganze Mail extern.
 */
export async function audienceOf(db: Db, q: { projectId: string; taskId: string | null; recipients: string[] }): Promise<Audience> {
  const list = [...new Set(q.recipients.map(normAddr).filter((x) => EMAIL.test(x)))];
  const p = await db.one(`select org_id from projects where id = $1`, [q.projectId]);
  const task = q.taskId ? await db.maybeOne(`select subproject_id from tasks where id = $1`, [q.taskId]) : null;
  const related = q.taskId ? await relatedAddresses(db, q.taskId) : new Set<string>();
  const recipients: Audience['recipients'] = [];
  for (const email of list) {
    const u = await db.maybeOne(`select id from users where org_id = $1 and lower(email) = $2`, [p.org_id, email]);
    const audience: AudienceClass = u ? ((await isInternal(db, { projectId: q.projectId, subprojectId: task?.subproject_id ?? null, userId: u.id })) ? 'internal' : 'outside') : related.has(email) ? 'task_external' : 'unknown_external';
    recipients.push({ email, audience, userId: u?.id ?? null });
  }
  return { audience: recipients.reduce<AudienceClass>((a, r) => (RANK[r.audience] > RANK[a] ? r.audience : a), 'internal'), recipients };
}

/** Kurzform für Log und Oberfläche, z. B. „Aufgabenbezug WEB-9“ oder „erster Kontakt“. */
export function audienceText(a: AudienceClass, code: string): string {
  return { internal: 'intern', outside: `Org-Benutzer ohne Zugriff auf ${code}`, task_external: `Aufgabenbezug ${code}`, unknown_external: 'ohne Bezug zum AP, erster Kontakt' }[a];
}

/** Externes Profil des Projekts (pflegt die PL): Name nach außen, Adresse, Zufahrt, Ansprechpartner für Externe. */
/** Ansprechpartner für Externe: Projektkontakte mit Kennzeichen external (eine Kontaktliste je Projekt). */
export async function externalContacts(db: Db, projectId: string): Promise<NonNullable<ExternalProfile['contacts']>> {
  const r = await db.query(`select name, email, role from project_contacts where project_id = $1 and external order by coalesce(name, email)`, [projectId]);
  return (r.rows as any[]).map((c) => ({ name: c.name ?? c.email, email: c.email, ...(c.role ? { role: c.role } : {}) }));
}

export function profileOf(v: any): ExternalProfile {
  const s = (x: unknown, n: number) => String(x ?? '').trim().slice(0, n);
  const contacts = (Array.isArray(v?.contacts) ? v.contacts : []).map((c: any) => ({ name: s(c?.name, 120), email: normAddr(c?.email).slice(0, 200), role: s(c?.role, 120) })).filter((c: any) => c.name || c.email).slice(0, 10);
  return { name: s(v?.name, 200), address: s(v?.address, 500), access: s(v?.access, 1000), contacts };
}

/** Stufe der Außenprüfung (Verwaltung › KI): strict = neu formulieren und prüfen, check = nur prüfen. */
export async function externalGuardLevel(db: Db, orgId: string): Promise<'strict' | 'check'> {
  return (await orgAiSettings(db, orgId)).externalGuard;
}

interface Scope {
  project: { id: string; org_id: string; key: string; name: string; mail_address: string | null; profile: ExternalProfile };
  task: any | null;
  family: { id: string; number: number; title: string; column_name: string; is_done: boolean; kind: string; parent_id: string | null }[];
  externals: string[];
  /** Seiten, die für alle externen Empfänger freigegeben sind (Verteiler des Ordners bzw. der Seite oder aktive Freigabe) */
  released: Set<string>;
}

/** Freigegeben für eine Adresse: im Verteiler (Ordner oder Seite) oder aktive doc_shares-Zeile, auch über eine Oberseite mit „inkl. Unterseiten“. */
async function releasedPages(db: Db, projectId: string, emails: string[]): Promise<Set<string>> {
  if (!emails.length) return new Set();
  const r = await db.query(
    `with recursive tree as (
       select s.page_id as id, s.email, s.include_children from doc_shares s where s.project_id = $1 and s.revoked_at is null and (s.expires_at is null or s.expires_at > now()) and lower(s.email) = any($2::text[])
       union all
       select p.id, t.email, t.include_children from doc_pages p join tree t on p.parent_page_id = t.id where t.include_children
     )
     select p.id, lower(x) as email from doc_pages p left join doc_folders f on f.id = p.folder_id,
       jsonb_array_elements_text(case when jsonb_array_length(coalesce(f.distribution_list, '[]'::jsonb)) > 0 then f.distribution_list else coalesce(p.settings->'recipients', '[]'::jsonb) end) x
     where p.project_id = $1 and p.deleted_at is null and lower(x) = any($2::text[])
     union select id, lower(email) from tree`,
    [projectId, emails]);
  const per = new Map<string, Set<string>>();
  for (const row of r.rows as any[]) per.set(row.id, (per.get(row.id) ?? new Set()).add(row.email));
  return new Set([...per].filter(([, s]) => emails.every((e) => s.has(e))).map(([id]) => id));
}

async function scopeOf(db: Db, projectId: string, taskId: string | null, aud: Audience): Promise<Scope> {
  const p = await db.one(`select id, org_id, key, name, mail_address, external_profile from projects where id = $1`, [projectId]);
  const task = taskId ? await db.maybeOne(`select t.*, c.name as column_name, c.is_done, c.kind as column_kind, pt.number as parent_number, pt.title as parent_title from tasks t join board_columns c on c.id = t.column_id left join tasks pt on pt.id = t.parent_id where t.id = $1`, [taskId]) : null;
  const family = taskId ? (await db.query(`${FAMILY} select t.id, t.number, t.title, t.parent_id, c.name as column_name, c.is_done, c.kind from tasks t join board_columns c on c.id = t.column_id where t.id in (select id from fam) order by t.parent_id nulls first, t.number`, [taskId])).rows : [];
  const externals = aud.recipients.filter((r) => r.audience !== 'internal').map((r) => r.email);
  return { project: { ...p, profile: { ...profileOf(p.external_profile), contacts: await externalContacts(db, projectId) } }, task, family, externals, released: await releasedPages(db, projectId, externals) };
}

const d10 = (v: any) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : '');
const cut = (s: string | null | undefined, n: number) => { const t = (s ?? '').trim(); return t.length > n ? t.slice(0, n) + ' …' : t; };
const statusWords = (x: { is_done: boolean; kind: string }) => (x.is_done ? 'erledigt' : x.kind === 'backlog' ? 'geplant' : x.kind === 'parked' ? 'zurückgestellt' : 'in Bearbeitung');

/**
 * text geht an die Neuformulierung; trusted ist der Teil, den Menschen im Projekt für Externe bestimmt haben (alles außer
 * den Mailtexten). Nur trusted nimmt checkOutbound von Fundstellen aus: was ein Externer selbst schreibt, schaltet die
 * Prüfung nicht ab.
 */
export interface ExternalContext { text: string; trusted: string; scope: Scope }

/**
 * Außenkontext einer Aufgabe für die externen Empfänger einer Nachricht (bei mehreren nur, was für alle gilt): Titel,
 * Termine und Status in Worten, ihre Tasks (bei eigener Zuständigkeit alle), Außenbeschreibung, Beschreibung nur bei
 * Zuweisung an diesen Externen, Mails mit ihnen am AP (Inhalte aus persönlichen Konten nur, wenn freigegeben), Log-Einträge
 * „für Externe sichtbar“, freigegebene Seiten, Termine verknüpfter Besprechungen mit ihnen, externes Profil. Nie: andere
 * APs, Teilprojekte, Mitglieder, Doku-Index, Meilensteine, Belegt-Zeiten, andere Mails, Preise.
 */
export async function externalContext(db: Db, taskId: string | null, aud: Audience, projectId?: string): Promise<ExternalContext> {
  const pid = projectId ?? (await db.one(`select project_id from tasks where id = $1`, [taskId])).project_id;
  const sc = await scopeOf(db, pid, taskId, aud);
  const { project: p, task: t, externals } = sc;
  const all = (pred: (e: string) => boolean) => externals.length > 0 && externals.every(pred);
  const lines: string[] = [];
  /** Mailtexte: gehen an die Neuformulierung, sind aber keine Ausnahme der Prüfung */
  let mailLine = '';
  const pr = p.profile;
  lines.push(`Projekt nach außen: ${pr.name || '(kein Name nach außen hinterlegt; Projektnamen nicht nennen)'}`);
  if (pr.address) lines.push(`Adresse: ${pr.address}`);
  if (pr.access) lines.push(`Zufahrt und Hinweise: ${pr.access}`);
  lines.push(`Ansprechpartner für Externe: ${pr.contacts?.length ? pr.contacts.map((c) => `${c.name}${c.role ? ` (${c.role})` : ''}${c.email ? ` <${c.email}>` : ''}`).join('; ') : `keiner benannt (Verweis an „die Projektleitung“${p.mail_address ? ` über ${p.mail_address}` : ''})`}`);
  if (t) {
    const code = (n: number) => `${p.key}-${n}`;
    lines.push(`${t.parent_id ? 'Aufgabe' : 'Arbeitspaket'} ${code(t.number)} „${t.title}“ · ${statusWords({ is_done: t.is_done, kind: t.column_kind })}${t.start_date ? ` · Beginn ${d10(t.start_date)}` : ''}${t.due_date ? ` · Termin ${d10(t.due_date)}` : ''}`);
    if (t.parent_id) lines.push(`Teil von ${code(t.parent_number)} „${t.parent_title}“`);
    const subs = sc.family.filter((x) => x.parent_id === t.id);
    if (subs.length) lines.push(`Schritte: ${subs.map((x) => `${code(x.number)} „${x.title}“ (${statusWords(x)})`).join(', ')}`);
    if (t.external_brief?.trim()) lines.push(`Beschreibung für Externe: ${cut(t.external_brief, 2000)}`);
    const assigned = all((e) => normAddr(t.responsible_email) === e);
    if (assigned && t.description?.trim()) lines.push(`Beschreibung: ${cut(t.description, 2000)}`);
    const items = (await db.query(`select title, done, responsible_email from checklist_items where task_id = $1 order by position`, [t.id])).rows.filter((i: any) => assigned || all((e) => normAddr(i.responsible_email) === e));
    if (items.length) lines.push(`Tasks für die Empfänger:\n${items.map((i: any) => `- [${i.done ? 'x' : ' '}] ${i.title}`).join('\n')}`);
    const log = await db.query(`select body, created_at from task_comments where task_id = $1 and visibility = 'external' order by created_at desc limit 10`, [t.id]);
    if (log.rows.length) lines.push(`Mitteilungen für Externe (aus dem Log):\n${log.rows.map((x: any) => `- ${new Date(x.created_at).toLocaleDateString('de-DE')}: ${cut(x.body, 600)}`).join('\n')}`);
    // Mailtexte aus persönlichen Konten nur, wenn sie freigegeben sind (wie im Agenten-Prompt); sie zählen nicht zu trusted
    const mails = (await db.query(`select m.subject, m.from_addr, m.to_json, m.cc_json, m.date, m.outgoing, coalesce(m.text_body, m.snippet) as body, l.copied, ux.use, ux.use_user_id from mail_task_links l join mails m on m.id = l.mail_id join mail_accounts a on a.id = m.account_id ${USE_LATERAL('a', '$2::uuid')} where l.task_id = $1 order by m.date desc limit 12`, [t.id, p.id])).rows
      .filter((m: any) => all((e) => [m.from_addr, ...(m.to_json ?? []), ...(m.cc_json ?? [])].map(normAddr).includes(e))).slice(0, 5);
    const humans = mails.length ? await projectHumans(db, p.id) : [];
    if (mails.length) lines.push(mailLine = `Mails mit den Empfängern zu dieser Aufgabe (neueste zuerst):\n${mails.map((m: any) => `- ${new Date(m.date).toLocaleDateString('de-DE')} ${m.outgoing ? 'an' : 'von'} ${m.outgoing ? (m.to_json ?? []).join(', ') : m.from_addr}: ${m.subject} – ${mailBodyOk(m, humans) ? cut(m.body, 500) : '(Inhalt aus einem persönlichen Konto, nicht freigegeben)'}`).join('\n')}`);
    const meetings = (await db.query(`select mm.title, mm.starts_at, mm.location, mm.tentative, mm.attendees from meeting_tasks mt join meetings mm on mm.id = mt.meeting_id where mt.task_id = $1 order by mm.starts_at`, [t.id])).rows
      .filter((m: any) => all((e) => (m.attendees ?? []).some((a: any) => normAddr(a?.email) === e)));
    if (meetings.length) lines.push(`Termine mit den Empfängern: ${meetings.map((m: any) => `${m.title} ${new Date(m.starts_at).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}${m.location ? ` (${m.location})` : ''}${m.tentative ? ' [vorläufig]' : ''}`).join(', ')}`);
  }
  if (sc.released.size) {
    const pages = await db.query(`select title, status from doc_pages where id = any($1::uuid[]) and deleted_at is null order by title`, [[...sc.released]]);
    lines.push(`Für die Empfänger freigegebene Seiten: ${pages.rows.map((x: any) => `„${x.title}“${x.status === 'final' ? '' : ' (Entwurf, geht nicht hinaus)'}`).join(', ')}`);
  }
  return { text: lines.join('\n'), trusted: lines.filter((l) => l !== mailLine).join('\n'), scope: sc };
}

const COMPOSE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['subject', 'text', 'withheld'],
  properties: {
    subject: { type: 'string', description: 'Betreff der Mail nach außen' },
    text: { type: 'string', description: 'Mailtext mit Anrede und unveränderter Unterschrift' },
    withheld: { type: 'array', items: { type: 'string' }, description: 'Was aus der Absicht weggelassen wurde, weil es projektintern wirkt (kurz, je Punkt ein Eintrag); sonst leer' }
  }
};
const COMPOSE_SYSTEM = `Du formulierst eine Mail eines KI-Agenten an Externe neu, bevor sie das Projekt verlässt. Du kennst nur den Außenkontext der Aufgabe und die Absicht des Agenten.
Übernimm aus der Absicht nur, was zu dieser Aufgabe gehört. Neu zu dieser Aufgabe sind Terminvorschläge, Mengen und Fragen erlaubt. Lass alles weg, was nach Projektinternem aussieht: andere Arbeitspakete oder Teilprojekte und ihre Kennungen, Namen und Adressen interner Personen außer den Ansprechpartnern für Externe, Preise und Budgets, Doku, die nicht freigegeben ist, Links ins Tool, interne Abläufe und Entscheidungen. Nenne jedes Weggelassene kurz in withheld.
Erfinde nichts. Behalte Sprache, Anrede, Ton und die Unterschrift bei. Antworte ausschließlich mit JSON nach dem Schema; nicht genutzte Felder bleiben leer ("" bzw. []).`;

/**
 * Schicht 2 (Stufe strict): eigener kleiner Aufruf, der nur den Außenkontext und die Absicht kennt; liefert Betreff, Text und
 * das Zurückgehaltene. Ohne Text gilt die Neuformulierung als fehlgeschlagen (Fehler, der Aufrufer hält die Mail an).
 */
export async function composeExternal(cfg: AiConfig, fetchFn: typeof fetch, p: { context: string; to: string[]; subject: string; text: string }): Promise<{ subject: string; text: string; withheld: string[]; inputTokens: number; outputTokens: number }> {
  const prompt = `Außenkontext:\n${p.context}\n\nAbsicht des Agenten (an ${p.to.join(', ')}):\nBetreff: ${p.subject.replace(/\n/g, ' ')}\nText:\n${p.text}`;
  const r = await complete(cfg, fetchFn, { system: COMPOSE_SYSTEM, prompt, maxTokens: cfg.enableThinking === true ? 4000 : 1500, schema: COMPOSE_SCHEMA });
  const j = parseJson<{ subject?: string; text?: string; withheld?: string[] }>(r.text);
  const text = String(j.text ?? '').trim();
  if (!text) throw new Error('Neuformulierung lieferte keinen Text');
  return { subject: String(j.subject ?? '').trim() || p.subject, text, withheld: (Array.isArray(j.withheld) ? j.withheld : []).map((x) => cut(String(x), 200)).filter(Boolean).slice(0, 10), inputTokens: r.inputTokens, outputTokens: r.outputTokens };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Ganzer Ausdruck (nicht Teil eines Worts), ohne Groß-/Kleinschreibung. */
const has = (hay: string, needle: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(needle.trim())}($|[^\\p{L}\\p{N}])`, 'iu').test(hay);

export interface CheckResult { result: 'pass' | 'held' | 'blocked'; findings: OutboundFinding[] }

/**
 * Schicht 3, deterministisch: fremde Kennungen (alles außer AP, Über-AP und Aufgaben darunter), Titel anderer APs und
 * Teilprojekte, Titel nicht freigegebener Seiten, Adressen interner Personen außer den Kontakten aus dem externen Profil,
 * andere Projektkennungen und -namen, App-Links, Anhänge, die nicht final oder nicht freigegeben sind (blocked). Was Menschen
 * im Projekt für Externe bestimmt haben (Außenbeschreibung, Log „für Externe sichtbar“, Profil, freigegebene Seiten), ist kein
 * Fund; was der Externe selbst geschrieben hat, schon. viewerId (Hinweise für eine Person): Fundstellen zu Teilprojekten, die
 * sie nicht sieht, entfallen, damit die Prüfung nichts über eingeschränkte Teilprojekte verrät.
 */
export async function checkOutbound(db: Db, q: { projectId: string; taskId: string | null; aud: Audience; subject: string; text: string; pageIds?: string[]; context?: ExternalContext; viewerId?: string }): Promise<CheckResult> {
  if (q.aud.audience === 'internal') return { result: 'pass', findings: [] };
  const ctx = q.context ?? (await externalContext(db, q.taskId, q.aud, q.projectId));
  const sc = ctx.scope;
  const hay = `${q.subject}\n${q.text}`;
  const known = ctx.trusted;
  const findings: OutboundFinding[] = [];
  const add = (f: OutboundFinding) => { if (!findings.some((x) => x.kind === f.kind && x.match.toLowerCase() === f.match.toLowerCase())) findings.push(f); };
  const p = sc.project;
  const own = new Set(sc.family.map((x) => x.number));
  const famIds = new Set(sc.family.map((x) => x.id));
  const famTitles = new Set(sc.family.map((x) => x.title.toLowerCase()));
  // Kennungen: eigenes Projekt nur AP-Familie, andere Projektkennungen des Mandanten nie. Das Muster entsteht aus den
  // tatsächlichen Kürzeln (auch mit Bindestrich oder Ziffer am Anfang, z. B. BAU-HH-12, 24HH-3), längere zuerst
  const keys = new Map<string, string>((await db.query(`select key, name from projects where org_id = $1 and id <> $2 and kind = 'project'`, [p.org_id, p.id])).rows.map((r: any) => [String(r.key).toUpperCase(), r.name]));
  const alt = [...new Set([p.key.toUpperCase(), ...keys.keys()])].filter(Boolean).sort((a, b) => b.length - a.length).map(esc).join('|');
  for (const m of hay.matchAll(new RegExp(`(?<![\\p{L}\\p{N}-])(${alt})-(\\d+)(?![\\p{N}])`, 'giu'))) {
    const key = m[1].toUpperCase();
    if (has(known, m[0])) continue;
    if (key === p.key.toUpperCase() && !own.has(Number(m[2]))) add({ kind: 'ref', match: m[0], text: `fremde Kennung ${m[0]}` });
    else if (keys.has(key)) add({ kind: 'project', match: m[0], text: `Kennung aus einem anderen Projekt (${m[0]})` });
  }
  for (const [, name] of keys) if (name && name.length >= 5 && has(hay, name) && !has(known, name)) add({ kind: 'project', match: name, text: `Name eines anderen Projekts „${name}“` });
  // Titel anderer APs und Aufgaben sowie aller Teilprojekte (für eine Person nur, soweit sie das Teilprojekt sieht)
  const tasks = await db.query(`select t.id, t.number, t.title from tasks t where t.project_id = $1 and t.deleted_at is null and length(t.title) >= 6${q.viewerId ? ` and ${visibleSubprojectSql(2)}` : ''}`, q.viewerId ? [p.id, q.viewerId] : [p.id]);
  for (const t of tasks.rows as any[]) if (!famIds.has(t.id) && !famTitles.has(String(t.title).toLowerCase()) && has(hay, t.title) && !has(known, t.title)) add({ kind: 'task', match: t.title, text: `Titel eines anderen Arbeitspakets (${p.key}-${t.number} „${t.title}“)` });
  const sps = await db.query(`select id, name from subprojects where project_id = $1 and length(name) >= 4`, [p.id]);
  for (const s of sps.rows as any[]) if (has(hay, s.name) && !has(known, s.name) && (!q.viewerId || (await canSeeSubproject(db, q.viewerId, s.id)))) add({ kind: 'subproject', match: s.name, text: `Name eines Teilprojekts „${s.name}“` });
  // Seiten, die für die Empfänger nicht freigegeben sind
  const pages = await db.query(`select id, title from doc_pages where project_id = $1 and deleted_at is null and length(title) >= 6`, [p.id]);
  for (const pg of pages.rows as any[]) if (!sc.released.has(pg.id) && has(hay, pg.title) && !has(known, pg.title)) add({ kind: 'page', match: pg.title, text: `Titel einer nicht freigegebenen Seite „${pg.title}“`, pageId: pg.id });
  // Adressen interner Personen (außer Ansprechpartnern aus dem externen Profil und den Empfängern selbst)
  const allowed = new Set([...(p.profile.contacts ?? []).map((c) => c.email), ...q.aud.recipients.map((r) => r.email), normAddr(p.mail_address)].filter(Boolean));
  const addrs = [...new Set([...hay.matchAll(/[^\s<>()"',;:]+@[^\s<>()"',;:]+\.[a-z]{2,}/gi)].map((m) => normAddr(m[0])))].filter((a) => !allowed.has(a));
  if (addrs.length) {
    const internal = await db.query(`select lower(email) as email from users where org_id = $1 and lower(email) = any($2::text[])`, [p.org_id, addrs]);
    for (const r of internal.rows as any[]) add({ kind: 'address', match: r.email, text: `Adresse einer internen Person (${r.email})` });
  }
  // Links ins Tool
  for (const m of hay.matchAll(/\S*\/(?:projekte|doku|chat)\/\S*/gi)) add({ kind: 'link', match: m[0], text: `Link ins Tool (${cut(m[0], 80)})` });
  // Anhänge: nur finale Seiten, die für alle externen Empfänger freigegeben sind
  for (const pid of q.pageIds ?? []) {
    const pg = await db.maybeOne(`select id, title, status from doc_pages where id = $1 and deleted_at is null`, [pid]);
    if (!pg) add({ kind: 'attachment', match: pid, text: 'Anhang: Seite nicht gefunden', pageId: pid });
    else if (pg.status !== 'final') add({ kind: 'attachment', match: pg.title, text: `Anhang „${pg.title}“ ist nicht final (Entwürfe gehen nie nach außen)`, pageId: pg.id });
    else if (!sc.released.has(pg.id)) add({ kind: 'attachment', match: pg.title, text: `Anhang „${pg.title}“ ist für ${sc.externals.join(', ')} nicht freigegeben`, pageId: pg.id });
  }
  return { result: findings.some((f) => f.kind === 'attachment') ? 'blocked' : findings.length ? 'held' : 'pass', findings };
}

export interface GuardResult extends CheckResult { subject: string; text: string; withheld: string[]; inputTokens: number; outputTokens: number }

/**
 * Agenten-Mail an Nicht-Interne: Stufe strict formuliert neu (höchstens ein Aufruf je Mail), danach checkOutbound. Schlägt
 * die Neuformulierung fehl, bleibt der Text der Absicht und die Mail wird angehalten (Fund „compose“), nie ungeprüft gesendet.
 */
export async function guardOutbound(db: Db, cfg: AiConfig, fetchFn: typeof fetch, q: { projectId: string; taskId: string | null; aud: Audience; subject: string; text: string; compose: boolean; keepSubject?: boolean; pageIds?: string[] }): Promise<GuardResult> {
  const ctx = await externalContext(db, q.taskId, q.aud, q.projectId);
  let subject = q.subject; let text = q.text; let withheld: string[] = []; let inputTokens = 0; let outputTokens = 0;
  const pre: OutboundFinding[] = [];
  if (q.compose && (await externalGuardLevel(db, ctx.scope.project.org_id)) === 'strict') {
    try {
      const r = await composeExternal(cfg, fetchFn, { context: ctx.text, to: q.aud.recipients.map((x) => x.email), subject, text });
      if (!q.keepSubject) subject = r.subject;
      text = r.text; withheld = r.withheld; inputTokens = r.inputTokens; outputTokens = r.outputTokens;
    } catch (e: any) {
      pre.push({ kind: 'compose', match: '', text: `Neuformulierung fehlgeschlagen (${cut(String(e?.message ?? e), 120)}); Text der Absicht zur Prüfung` });
    }
  }
  const c = await checkOutbound(db, { projectId: q.projectId, taskId: q.taskId, aud: q.aud, subject, text, pageIds: q.pageIds, context: ctx });
  const findings = [...pre, ...c.findings];
  return { subject, text, withheld, inputTokens, outputTokens, findings, result: c.result === 'blocked' ? 'blocked' : findings.length ? 'held' : 'pass' };
}

/** Schicht 4: jede Prüfung mit Fundstellen und Zurückgehaltenem; Audit ai.outbound. */
export async function recordCheck(db: Db, r: { orgId: string; projectId: string; taskId: string | null; runId?: string | null; channel: 'mail' | 'reply_origin' | 'pdf' | 'draft' | 'chat'; aud: Audience; result: CheckResult['result']; findings: OutboundFinding[]; withheld?: string[]; mailDraftId?: string | null; userId: string | null }): Promise<string> {
  const row = await db.one(`insert into outbound_checks (org_id, project_id, task_id, run_id, channel, recipients, audience, result, findings, withheld, mail_draft_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [r.orgId, r.projectId, r.taskId, r.runId ?? null, r.channel, JSON.stringify(r.aud.recipients.map((x) => ({ email: x.email, audience: x.audience }))), r.aud.audience, r.result, JSON.stringify(r.findings), JSON.stringify(r.withheld ?? []), r.mailDraftId ?? null]);
  await audit(db, { orgId: r.orgId, projectId: r.projectId, userId: r.userId, action: 'ai.outbound', objectType: r.mailDraftId ? 'mail_draft' : 'task', objectId: r.mailDraftId ?? r.taskId, details: { checkId: row.id, channel: r.channel, audience: r.aud.audience, result: r.result, findings: r.findings.length, withheld: r.withheld?.length ?? 0, to: r.aud.recipients.map((x) => x.email) } });
  return row.id;
}

/**
 * Prüfung als Hinweis für eine Person (KI-Entwürfe, Abschluss-Antwort mit KI, Mails, die sie selbst sendet): blockiert nie,
 * wird protokolliert (Kanal draft) und angezeigt; record: false nur für die Vorschau vor dem Senden.
 */
export async function checkHint(db: Db, q: { orgId: string; projectId: string; taskId: string | null; recipients: string[]; subject: string; text: string; mailDraftId?: string | null; userId: string; record?: boolean }): Promise<{ audience: AudienceClass; result: CheckResult['result']; findings: OutboundFinding[] } | null> {
  const aud = await audienceOf(db, { projectId: q.projectId, taskId: q.taskId, recipients: q.recipients });
  if (aud.audience === 'internal' || !aud.recipients.length) return null;
  const c = await checkOutbound(db, { projectId: q.projectId, taskId: q.taskId, aud, subject: q.subject, text: q.text, viewerId: q.userId });
  if (q.record !== false) await recordCheck(db, { orgId: q.orgId, projectId: q.projectId, taskId: q.taskId, channel: 'draft', aud, result: c.result, findings: c.findings, mailDraftId: q.mailDraftId ?? null, userId: q.userId });
  return { audience: aud.audience, ...c };
}

/** Kennzeichen der Chat-Nachricht an die Kette; eine Antwort mit dem Freigabesatz wird Teil des Außenkontexts (routes/chat.ts). */
export const REFER_MARK = 'Rückfrage von extern';
const RELEASE_END = /(^|[.!;:,\n–-])\s*(?:(?:das|dies|es|alles|das alles|diese antwort)\s+)?darf weitergegeben werden\s*[.!]?\s*$/i;

/**
 * Freigabe einer Antwort auf refer: nur, wenn die Nachricht mit dem eigenen Satz „Darf weitergegeben werden.“ endet (auch
 * „…, das darf weitergegeben werden.“). Verneinungen, Fragen und Einschränkungen („Nichts davon darf …“, „Kein Wort darf …“,
 * „Was davon darf …, kläre ich noch“) geben nichts frei. Liefert den freigegebenen Text ohne den Satz, sonst null. Ab P5
 * wird daraus eine Antwortoption der Frage external_referral.
 */
export function releasedText(body: string): string | null {
  const m = body.match(RELEASE_END);
  if (!m) return null;
  return body.slice(0, m.index! + m[1].length).replace(/[\s,;:–-]+$/, '').trim() || null;
}

/**
 * Aktion refer: Frage eines Externen außerhalb seiner Aufgabe an den nächsten Menschen der Kette (Zuständige des Über-AP,
 * Teilprojekt-Verantwortung, PL). Übergangsweise (bis P5) als Log-Eintrag, Meldung und Direktnachricht an die erste Person;
 * ab P5 wird daraus eine Frage external_referral (askQuestion), die Signatur bleibt. Liefert die Person und den Text des
 * Verweises für den Externen (Kontakt aus dem externen Profil, sonst „die Projektleitung“ über die Projektadresse).
 */
export async function referToChain(db: Db, q: { task: any; agent: { id: string; name: string; org_id: string }; question: string; from: string | null }): Promise<{ contact: { id: string; name: string; email: string; why: string }; referral: string } | { error: string }> {
  const t = q.task;
  const chain = await contactChain(db, t, { exclude: [q.agent.id] });
  const contact = chain[0];
  if (!contact) return { error: 'refer: niemand in der Kette (Über-AP, Teilprojekt, PL) erreichbar' };
  const code = `${t.project_key}-${t.number}`;
  await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [t.id, q.agent.id, `${REFER_MARK}${q.from ? ` (${q.from})` : ''} außerhalb der Aufgabe an ${contact.name} weitergegeben (${contact.why}): ${cut(q.question, 1500)}`]);
  await notify(db, { userId: contact.id, projectId: t.project_id, taskId: t.id, type: 'external.referral', title: `${REFER_MARK}: ${t.title}`, body: cut(q.question, 300), link: `/projekte/${t.project_id}/board?task=${t.id}`, ref: { type: 'task', id: t.id }, actorId: q.agent.id, chatted: true, dedupeKey: null });
  await agentChatMessage(db, q.agent, { userId: contact.id }, `${code} „${t.title}“: ${REFER_MARK}${q.from ? ` (${q.from})` : ''}, gehört nicht zu dieser Aufgabe: ${cut(q.question, 1500)}\nAntworte hier; endet deine Antwort mit dem Satz „Darf weitergegeben werden.“, wird sie für Externe sichtbar und ich gebe sie weiter.`, t.project_id);
  const p = await db.one(`select mail_address from projects where id = $1`, [t.project_id]);
  const c = (await externalContacts(db, t.project_id))[0];
  const referral = c ? `${c.name}${c.role ? ` (${c.role})` : ''}${c.email ? `, ${c.email}` : ''}` : `die Projektleitung${p.mail_address ? ` (erreichbar über ${p.mail_address})` : ''}`;
  return { contact, referral };
}
