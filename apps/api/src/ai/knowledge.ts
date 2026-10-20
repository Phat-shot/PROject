import { createHash } from 'node:crypto';
import type { Db } from '../db.js';
import type { MailService } from '../mail/service.js';
import { audit } from '../audit.js';
import { notify } from '../notify.js';
import { canSeeSubproject, getMembership, visibleSubprojectSql } from '../rights.js';
import { contactChain } from '../tasks/service.js';
import { askQuestion, cancelQuestions, type AnswerInput, type Asker, type QuestionRow } from '../questions.js';
import { aiConfigFor, complete, parseJson } from './client.js';
import { effectiveAgentPolicy, folderAccessMap } from './agentPolicy.js';
import { findTaskByRef } from './plan.js';
import { AGENT_SHEET, PROJECT_RULES } from './sheet.js';

/**
 * Projektwissen (Konzept 6.6–6.8, P9): Suche im Projekt nur soweit berechtigt, Kandidaten für Überschneidungen ohne Token
 * (Signale contact, terms, date_place, page, dependency, question), Kontextbudget je Profil, Projektüberblick je Sichtbarkeit
 * (Struktur aus den Daten, Steckbrief vom Projektagenten), Beziehungen zwischen Arbeitspaketen mit Frage synergy und Entscheidung
 * mit den Rechten der entscheidenden Person, Projektdurchlauf werktags zur eingestellten Uhrzeit.
 */
const cut = (s: unknown, n: number) => { const t = String(s ?? '').trim(); return t.length > n ? t.slice(0, n) + ' …' : t; };
const d10 = (v: any) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : '');
const STOP = new Set(['und', 'oder', 'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'eines', 'für', 'mit', 'von', 'vom', 'zum', 'zur', 'auf', 'aus', 'bei', 'nach', 'über', 'unter', 'nicht', 'noch', 'auch', 'wird', 'werden', 'wurde', 'sind', 'ist', 'war', 'hat', 'haben', 'soll', 'sollen', 'kann', 'muss', 'bis', 'als', 'wie', 'the', 'and', 'for', 'with', 'this', 'that', 'arbeitspaket', 'aufgabe', 'projekt']);
export function tokens(text: unknown): string[] {
  return [...new Set(String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').map((w) => w.trim()).filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)))];
}
const jaccard = (a: string[], b: string[]) => { const A = new Set(a); const B = new Set(b); const inter = [...A].filter((x) => B.has(x)).length; const uni = new Set([...A, ...B]).size; return uni ? inter / uni : 0; };

/** Sichtbarkeit eines Agenten: Teilprojekte (SQL), Ordnerzugriff; Schlüssel für den Projektüberblick je Sichtbarkeit. */
export async function agentVisibility(db: Db, q: { agentId: string; projectId: string }): Promise<{ folderAccess: Map<string, 'write' | 'read' | 'none'>; subprojectIds: string[]; key: string }> {
  const folderAccess = await folderAccessMap(db, q.projectId);
  const sps = (await db.query(`select s.id from subprojects s where s.project_id = $1 and (not s.restricted or s.responsible_user_id = $2 or exists (select 1 from project_members pm where pm.project_id = s.project_id and pm.user_id = $2 and pm.role = 'pl') or exists (select 1 from subproject_access a where a.subproject_id = s.id and (a.user_id = $2 or a.group_id in (select group_id from group_members gm where gm.user_id = $2)))) order by s.id`, [q.projectId, q.agentId])).rows.map((r: any) => r.id as string);
  const none = [...folderAccess.entries()].filter(([, v]) => v === 'none').map(([k]) => k).sort();
  return { folderAccess, subprojectIds: sps, key: createHash('sha1').update(JSON.stringify({ sps, none })).digest('hex').slice(0, 16) };
}

export interface SearchHit { kind: 'page' | 'task'; id: string; title: string; ref?: string; excerpt?: string | null; status?: string; folder?: string | null }
/** Suche im Projekt (Titel und Inhalt, Stichwörter): bis 10 Seitentitel mit 3 Ausschnitten à 800 Zeichen und 5 Arbeitspakete; nur, was Agent (und ggf. Absender) sehen dürfen. */
export async function search(db: Db, q: { projectId: string; agentId: string; query: string; viewerId?: string | null; maxTitles?: number; maxExcerpts?: number }): Promise<{ pages: SearchHit[]; tasks: SearchHit[] }> {
  const terms = tokens(q.query).slice(0, 8);
  if (!terms.length) return { pages: [], tasks: [] };
  const vis = await agentVisibility(db, { agentId: q.agentId, projectId: q.projectId });
  const like = terms.map((t) => `%${t.replace(/[%_]/g, '')}%`);
  const pages = await db.query(
    `select p.id, p.title, p.status, p.content_md, p.folder_id, f.name as folder, (select count(*) from unnest($2::text[]) t where p.title ilike t or p.content_md ilike t) as score
     from doc_pages p left join doc_folders f on f.id = p.folder_id where p.project_id = $1 and p.deleted_at is null and exists (select 1 from unnest($2::text[]) t where p.title ilike t or p.content_md ilike t)
     order by score desc, p.updated_at desc limit $3`, [q.projectId, like, (q.maxTitles ?? 10) * 2]);
  const okPages = pages.rows.filter((p: any) => !p.folder_id || vis.folderAccess.get(p.folder_id) !== 'none').slice(0, q.maxTitles ?? 10);
  const excerpt = (md: string) => { const low = md.toLowerCase(); const idx = terms.map((t) => low.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0; const start = Math.max(0, idx - 200); return `${start ? '… ' : ''}${md.slice(start, start + 800).replace(/\s+/g, ' ').trim()}${start + 800 < md.length ? ' …' : ''}`; };
  const outPages: SearchHit[] = okPages.map((p: any, i: number) => ({ kind: 'page', id: p.id, title: p.title, status: p.status, folder: p.folder, excerpt: i < (q.maxExcerpts ?? 3) ? excerpt(String(p.content_md ?? '')) : null }));
  const params: any[] = [q.projectId, like, q.agentId];
  if (q.viewerId) params.push(q.viewerId);
  const tasks = await db.query(
    `select t.id, t.number, t.title, c.name as column_name, p.key from tasks t join board_columns c on c.id = t.column_id join projects p on p.id = t.project_id
     where t.project_id = $1 and t.deleted_at is null and t.archived_at is null and exists (select 1 from unnest($2::text[]) x where t.title ilike x or t.description ilike x)
       and ${visibleSubprojectSql(3)}${q.viewerId ? ` and ${visibleSubprojectSql(4)}` : ''} order by t.updated_at desc nulls last limit 5`, params);
  return { pages: outPages, tasks: tasks.rows.map((t: any) => ({ kind: 'task', id: t.id, ref: `${t.key}-${t.number}`, title: t.title, status: t.column_name })) };
}
export const searchText = (r: { pages: SearchHit[]; tasks: SearchHit[] }) => `${r.pages.length ? `Seiten:\n${r.pages.map((p) => `- „${p.title}“ (pageId ${p.id}, ${p.folder ?? 'ohne Ordner'}, ${p.status})${p.excerpt ? `\n  ${p.excerpt}` : ''}`).join('\n')}` : 'Seiten: keine Treffer'}\n${r.tasks.length ? `Arbeitspakete:\n${r.tasks.map((t) => `- ${t.ref} „${t.title}“ · ${t.status}`).join('\n')}` : 'Arbeitspakete: keine Treffer'}`;

export interface Candidate { taskId: string; ref: string; title: string; signals: { type: string; detail: string }[] }
/**
 * Kandidaten für Überschneidungen zu einem Arbeitspaket, ohne Token: gleicher Externer (contact), gemeinsame Stichwörter (terms),
 * überlappender Zeitraum am gleichen Ort (date_place), dieselbe Seite in beiden Logs (page), Abhängigkeit mit Terminkonflikt (dependency),
 * offene Fragen an dieselbe Person (question). Schon entschiedene Paare kommen nur mit einem neuen Signaltyp wieder.
 */
export async function findCandidates(db: Db, q: { projectId: string; taskId: string; agentId: string; max?: number }): Promise<Candidate[]> {
  const t = await db.maybeOne(`select t.*, p.key from tasks t join projects p on p.id = t.project_id where t.id = $1`, [q.taskId]);
  if (!t) return [];
  const own = { tokens: tokens(`${t.title} ${t.description ?? ''}`), senders: new Set<string>(), pages: new Set<string>(), addressees: new Set<string>(), locations: new Set<string>() };
  if (t.responsible_email) own.senders.add(String(t.responsible_email).toLowerCase());
  for (const m of (await db.query(`select lower(m.from_addr) as a from mail_task_links l join mails m on m.id = l.mail_id where l.task_id = $1 and not m.outgoing`, [t.id])).rows) own.senders.add(m.a);
  const pageRe = /doku\/([0-9a-f-]{36})|pageId ([0-9a-f-]{36})/gi;
  for (const c of (await db.query(`select body from task_comments where task_id = $1`, [t.id])).rows) for (const m of String(c.body).matchAll(pageRe)) own.pages.add((m[1] ?? m[2]).toLowerCase());
  for (const x of (await db.query(`select addressee_id from questions where task_id = $1 and status = 'open' and addressee_id is not null`, [t.id])).rows) own.addressees.add(x.addressee_id);
  for (const x of (await db.query(`select lower(m.location) as l from meeting_tasks mt join meetings m on m.id = mt.meeting_id where mt.task_id = $1 and m.location is not null`, [t.id])).rows) own.locations.add(x.l);
  const others = await db.query(
    `select t.id, t.number, t.title, t.description, t.start_date, t.due_date, t.responsible_email, t.parent_id from tasks t join board_columns c on c.id = t.column_id
     where t.project_id = $1 and t.id <> $2 and t.parent_id is distinct from $2 and ($3::uuid is null or t.id <> $3) and t.parent_id is null and t.deleted_at is null and t.archived_at is null and not c.is_done and ${visibleSubprojectSql(4)} limit 200`,
    [q.projectId, t.id, t.parent_id ?? null, q.agentId]);
  const decided = new Map<string, Set<string>>();
  for (const r of (await db.query(`select task_a, task_b, signals from task_relations where project_id = $1 and (task_a = $2 or task_b = $2) and status in ('accepted','rejected','asked')`, [q.projectId, t.id])).rows) {
    const other = r.task_a === t.id ? r.task_b : r.task_a;
    decided.set(other, new Set((r.signals ?? []).map((s: any) => s.type)));
  }
  const out: Candidate[] = [];
  for (const o of others.rows as any[]) {
    const signals: { type: string; detail: string }[] = [];
    const senders = new Set<string>(); if (o.responsible_email) senders.add(String(o.responsible_email).toLowerCase());
    for (const m of (await db.query(`select lower(m.from_addr) as a from mail_task_links l join mails m on m.id = l.mail_id where l.task_id = $1 and not m.outgoing`, [o.id])).rows) senders.add(m.a);
    const sharedContact = [...senders].find((a) => own.senders.has(a));
    if (sharedContact) signals.push({ type: 'contact', detail: `gleicher Kontakt ${sharedContact}` });
    const tk = tokens(`${o.title} ${o.description ?? ''}`);
    const shared = tk.filter((x) => own.tokens.includes(x));
    if (shared.length >= 3 || jaccard(own.tokens, tk) >= 0.35) signals.push({ type: 'terms', detail: `gemeinsame Stichwörter: ${shared.slice(0, 5).join(', ')}` });
    if (t.start_date && t.due_date && o.start_date && o.due_date && own.locations.size) {
      const overlap = d10(o.start_date) <= d10(t.due_date) && d10(o.due_date) >= d10(t.start_date);
      const loc = (await db.query(`select lower(m.location) as l from meeting_tasks mt join meetings m on m.id = mt.meeting_id where mt.task_id = $1 and m.location is not null`, [o.id])).rows.map((x: any) => x.l).find((l: string) => own.locations.has(l));
      if (overlap && loc) signals.push({ type: 'date_place', detail: `gleicher Zeitraum und Ort „${loc}“` });
    }
    if (own.pages.size) {
      const pages = new Set<string>();
      for (const c of (await db.query(`select body from task_comments where task_id = $1`, [o.id])).rows) for (const m of String(c.body).matchAll(pageRe)) pages.add((m[1] ?? m[2]).toLowerCase());
      const sharedPage = [...pages].find((p) => own.pages.has(p));
      if (sharedPage) signals.push({ type: 'page', detail: 'dieselbe Seite in beiden Logs' });
    }
    const dep = await db.maybeOne(`select d.predecessor_id, d.successor_id from task_dependencies d where (d.predecessor_id = $1 and d.successor_id = $2) or (d.predecessor_id = $2 and d.successor_id = $1)`, [t.id, o.id]);
    if (dep) {
      const pred = dep.predecessor_id === t.id ? t : o; const succ = dep.predecessor_id === t.id ? o : t;
      if (pred.due_date && (succ.start_date ?? succ.due_date) && d10(succ.start_date ?? succ.due_date) < d10(pred.due_date)) signals.push({ type: 'dependency', detail: `Abhängigkeit mit Terminkonflikt (${d10(pred.due_date)} vs. ${d10(succ.start_date ?? succ.due_date)})` });
    }
    if (own.addressees.size) {
      const same = await db.maybeOne(`select u.name from questions q join users u on u.id = q.addressee_id where q.task_id = $1 and q.status = 'open' and q.addressee_id = any($2::uuid[]) limit 1`, [o.id, [...own.addressees]]);
      if (same) signals.push({ type: 'question', detail: `offene Fragen an ${same.name} aus beiden` });
    }
    if (!signals.length) continue;
    const seen = decided.get(o.id);
    if (seen && signals.every((s) => seen.has(s.type))) continue;
    out.push({ taskId: o.id, ref: `${t.key}-${o.number}`, title: o.title, signals });
  }
  return out.sort((a, b) => b.signals.length - a.signals.length).slice(0, q.max ?? 3);
}
export const candidatesText = (c: Candidate[]) => c.map((x) => `- ${x.ref} „${cut(x.title, 60)}“ · ${x.signals.map((s) => s.detail).join('; ')}`).join('\n');

export interface BudgetSection { key: string; text: string; keep?: boolean }
export const estTokens = (s: string) => Math.ceil(s.length / 3.5);
/** Kontextbudget: kürzt in fester Reihenfolge (AP-Liste, Seitentitel, ähnliche APs, Mailtexte, Log, Steckbrief); eigenes AP und Bestätigungen bleiben. */
export function fitBudget(sections: BudgetSection[], limitTokens: number): { text: string; stats: { limit: number; before: number; after: number; trimmed: Record<string, { from: number; to: number }> } } {
  const order = ['aps', 'pages', 'similar', 'mails', 'log', 'brief'];
  const parts = sections.map((s) => ({ ...s }));
  const total = () => estTokens(parts.map((p) => p.text).join('\n'));
  const before = total();
  const trimmed: Record<string, { from: number; to: number }> = {};
  for (const key of order) {
    if (total() <= limitTokens) break;
    const p = parts.find((x) => x.key === key && !x.keep);
    if (!p || !p.text) continue;
    const from = estTokens(p.text);
    while (total() > limitTokens && p.text.length > 200) p.text = `${p.text.slice(0, Math.floor(p.text.length / 2)).replace(/\s+\S*$/, '')}\n… (gekürzt)`;
    trimmed[key] = { from, to: estTokens(p.text) };
  }
  return { text: parts.map((p) => p.text).join('\n'), stats: { limit: limitTokens, before, after: total(), trimmed } };
}

/** Projektüberblick je Sichtbarkeit: Struktur per Code (höchstens 4000 Zeichen), Steckbrief vom Projektagenten; gespeichert mit Quell-Hash. */
export async function projectDigest(db: Db, q: { projectId: string; agentId: string }): Promise<{ structure: string; brief: string | null; hash: string; changed: boolean; key: string }> {
  const vis = await agentVisibility(db, { agentId: q.agentId, projectId: q.projectId });
  const p = await db.one(`select p.key, p.name, p.description, p.status, (select name from users u join project_members m on m.user_id = u.id where m.project_id = p.id and m.role = 'pl' and not m.is_deputy limit 1) as lead from projects p where p.id = $1`, [q.projectId]);
  const sps = await db.query(`select s.name, s.start_date, s.end_date, u.name as resp, (select count(*)::int from tasks t join board_columns c on c.id = t.column_id where t.subproject_id = s.id and t.parent_id is null and t.deleted_at is null and t.archived_at is null and not c.is_done) as open from subprojects s left join users u on u.id = s.responsible_user_id where s.project_id = $1 and (s.id = any($2::uuid[])) order by s.position`, [q.projectId, vis.subprojectIds]);
  const cols = await db.query(`select c.name, c.is_done, count(t.id)::int as n from board_columns c left join tasks t on t.column_id = c.id and t.parent_id is null and t.deleted_at is null and t.archived_at is null and ${visibleSubprojectSql(2)} where c.project_id = $1 group by c.id, c.name, c.is_done, c.position order by c.position`, [q.projectId, q.agentId]);
  const ms = await db.query(`select name, date from milestones where project_id = $1 and date >= current_date order by date limit 10`, [q.projectId]);
  const ev = await db.query(`select title, starts_at from meetings where project_id = $1 and starts_at >= now() order by starts_at limit 5`, [q.projectId]);
  const qs = await db.one(`select count(*)::int as n from questions where project_id = $1 and status = 'open'`, [q.projectId]);
  const over = await db.one(`select count(*)::int as n from tasks t join board_columns c on c.id = t.column_id where t.project_id = $1 and t.parent_id is null and t.deleted_at is null and t.archived_at is null and not c.is_done and t.due_date < current_date and ${visibleSubprojectSql(2)}`, [q.projectId, q.agentId]);
  const structure = cut([
    `Projekt ${p.key} „${p.name}“ (${p.status}${p.lead ? `, PL ${p.lead}` : ''})${p.description ? `: ${cut(p.description, 400)}` : ''}`,
    `Teilprojekte: ${sps.rows.map((s: any) => `${s.name} (${s.resp ?? 'PL'}${s.start_date || s.end_date ? `, ${d10(s.start_date)}–${d10(s.end_date)}` : ''}, ${s.open} offen)`).join('; ') || '–'}`,
    `Arbeitspakete je Status: ${cols.rows.map((c: any) => `${c.name} ${c.n}`).join(', ')} · überfällig ${over.n} · offene Fragen ${qs.n}`,
    `Meilensteine: ${ms.rows.map((m: any) => `${m.name} ${d10(m.date)}`).join(', ') || '–'}`,
    `Nächste Termine: ${ev.rows.map((e: any) => `${e.title} ${new Date(e.starts_at).toLocaleDateString('de-DE')}`).join(', ') || '–'}`
  ].join('\n'), 4000);
  const latest = await db.one(`select coalesce(max(greatest(t.updated_at, t.created_at)), 'epoch')::text as u, (select count(*)::int from task_comments c join tasks t2 on t2.id = c.task_id where t2.project_id = $1) as comments from tasks t where t.project_id = $1`, [q.projectId]);
  const hash = createHash('sha1').update(structure).update(String(latest.u)).update(String(latest.comments)).digest('hex');
  const cur = await db.maybeOne(`select brief, source_hash from project_digests where project_id = $1 and visibility_key = $2`, [q.projectId, vis.key]);
  await db.query(`insert into project_digests (project_id, visibility_key, structure, source_hash, built_at) values ($1,$2,$3,$4,now()) on conflict (project_id, visibility_key) do update set structure = excluded.structure, source_hash = excluded.source_hash, built_at = now()`, [q.projectId, vis.key, structure, hash]);
  return { structure, brief: cur?.brief ?? null, hash, changed: cur?.source_hash !== hash, key: vis.key };
}
export const digestText = (d: { structure: string; brief: string | null }) => `# Projektüberblick\n${d.structure}${d.brief ? `\n\nSteckbrief (vom Projektagenten):\n${d.brief}` : ''}`;

// ---------------------------------------------------------------------------------------------------------------------
// Beziehungen zwischen Arbeitspaketen (Synergien, Konzept 6.7)

export type RelationKind = 'related' | 'sync' | 'duplicate' | 'dependency';
export const SYNERGY_OPTIONS = (lead: string) => [{ key: 'sync', label: `synchron bearbeiten (Lead ${lead})` }, { key: 'dependency', label: 'Abhängigkeit' }, { key: 'duplicate', label: 'zusammenführen' }, { key: 'independent', label: 'unabhängig' }];

export async function createRelation(db: Db, q: { projectId: string; a: string; b: string; kind: RelationKind; signals: { type: string; detail: string }[]; note?: string | null; foundBy: string | null }): Promise<{ id: string; status: string } | { error: string }> {
  const [ta, tb] = q.a < q.b ? [q.a, q.b] : [q.b, q.a];
  if (ta === tb) return { error: 'gleiches Arbeitspaket' };
  const existing = await db.maybeOne(`select id, status, decided_at, signals from task_relations where task_a = $1 and task_b = $2 and kind = $3`, [ta, tb, q.kind]);
  if (existing) {
    // Entschiedene Paare kommen nur mit einem neuen Signaltyp wieder
    const seen = new Set((existing.signals ?? []).map((s: any) => s.type));
    if (existing.status === 'rejected' && q.signals.some((s) => !seen.has(s.type))) { await db.query(`update task_relations set status = 'suggested', signals = $2, note = coalesce($3, note), decided_by = null, decided_at = null where id = $1`, [existing.id, JSON.stringify([...(existing.signals ?? []), ...q.signals]), q.note ?? null]); return { id: existing.id, status: 'suggested' }; }
    return { error: `Beziehung ${q.kind} ist schon ${existing.status === 'accepted' ? 'bestätigt' : existing.status === 'rejected' ? 'als unabhängig entschieden' : 'offen'}` };
  }
  const r = await db.one(`insert into task_relations (project_id, task_a, task_b, kind, signals, note, found_by) values ($1,$2,$3,$4,$5,$6,$7) returning id`, [q.projectId, ta, tb, q.kind, JSON.stringify(q.signals), q.note ?? null, q.foundBy]);
  return { id: r.id, status: 'suggested' };
}

/** Frage synergy an die Zuständigen (bzw. die PL, wenn Agenten zuständig sind oder die APs in verschiedenen Teilprojekten liegen). */
export async function askSynergy(db: Db, q: { relationId: string; agent: Asker; now?: Date }): Promise<{ questionId: string } | { error: string }> {
  const r = await db.one(`select r.*, a.number as a_number, a.title as a_title, a.subproject_id as a_sp, a.responsible_user_id as a_resp, b.number as b_number, b.title as b_title, b.subproject_id as b_sp, b.responsible_user_id as b_resp, p.key from task_relations r join tasks a on a.id = r.task_a join tasks b on b.id = r.task_b join projects p on p.id = r.project_id where r.id = $1`, [q.relationId]);
  const refA = `${r.key}-${r.a_number}`; const refB = `${r.key}-${r.b_number}`;
  const agents = await db.query(`select id from users where id = any($1::uuid[]) and kind = 'agent'`, [[r.a_resp, r.b_resp].filter(Boolean)]);
  const toPl = agents.rows.length > 0 || r.a_sp !== r.b_sp || !r.a_resp || !r.b_resp;
  const body = `${refA} „${r.a_title}“ und ${refB} „${r.b_title}“ hängen zusammen (${(r.signals ?? []).map((s: any) => s.detail).join('; ') || r.note || r.kind}). Wie weiter?`;
  const res = await askQuestion(db, { taskId: r.task_a, asker: q.agent, kind: 'synergy', to: toPl ? 'pl' : null, body, options: SYNERGY_OPTIONS(refA), now: q.now, type: 'synergy', title: `${q.agent.name}: Zusammenhang ${refA} ↔ ${refB}`, context: { topic: 'synergy', relationId: r.id, lead: r.task_a } });
  if ('error' in res) return res;
  await db.query(`update task_relations set status = 'asked', question_id = $2 where id = $1`, [r.id, res.question.id]);
  return { questionId: res.question.id };
}

/** Querverweise in beiden Logs (Synergien nutzen bzw. bestätigt). */
async function crossLog(db: Db, rel: any, userId: string, text: string) {
  const a = await db.one(`select t.id, t.number, t.title, p.key from tasks t join projects p on p.id = t.project_id where t.id = $1`, [rel.task_a]);
  const b = await db.one(`select t.id, t.number, t.title, p.key from tasks t join projects p on p.id = t.project_id where t.id = $1`, [rel.task_b]);
  await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'system')`, [a.id, userId, `Zusammenhang mit ${b.key}-${b.number} „${b.title}“: ${text}`]);
  await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'system')`, [b.id, userId, `Zusammenhang mit ${a.key}-${a.number} „${a.title}“: ${text}`]);
}

/** Synergien nutzen (Policy use, nur Selbstständig): Querverweis in beiden Logs, Beziehung bestätigt; Abhängigkeit und Zusammenführen entscheiden weiter Menschen (askSynergy). */
export async function acceptRelation(db: Db, q: { relationId: string; userId: string; text: string }): Promise<void> {
  const rel = await db.one(`select * from task_relations where id = $1`, [q.relationId]);
  await crossLog(db, rel, q.userId, q.text);
  await db.query(`update task_relations set status = 'accepted', lead_task_id = $2, decided_by = $3, decided_at = now() where id = $1`, [rel.id, rel.task_a, q.userId]);
}

/** Eigene, noch offene Beziehung zurückziehen (Frage synergy wird abgebrochen). */
export async function withdrawRelation(db: Db, q: { a: string; b: string; userId: string }): Promise<{ ok: true } | { error: string }> {
  const [ta, tb] = q.a < q.b ? [q.a, q.b] : [q.b, q.a];
  const rel = await db.maybeOne(`select * from task_relations where task_a = $1 and task_b = $2 and found_by = $3 and status in ('suggested','asked') order by created_at desc limit 1`, [ta, tb, q.userId]);
  if (!rel) return { error: 'keine eigene offene Beziehung zu diesem Arbeitspaket' };
  if (rel.question_id) { const oq = await db.maybeOne<QuestionRow>(`select * from questions where id = $1 and status = 'open'`, [rel.question_id]); if (oq) await cancelQuestions(db, { questionId: oq.id }, 'vom Agenten zurückgezogen', q.userId); }
  await db.query(`delete from task_relations where id = $1`, [rel.id]);
  return { ok: true };
}

/** Entscheidung mit den Rechten der entscheidenden Person: sync, dependency (Lead zuerst), duplicate (Zusammenführen als Hinweis an die PL), independent. */
export async function decideRelation(db: Db, q: { relationId: string; option: string; user: { id: string; name: string; orgId: string }; leadTaskId?: string | null; text?: string | null }): Promise<{ status: string; kind: string }> {
  const rel = await db.maybeOne(`select * from task_relations where id = $1`, [q.relationId]);
  if (!rel) throw new Error('Beziehung nicht gefunden');
  if (rel.status === 'accepted' || rel.status === 'rejected') throw new Error('Beziehung ist schon entschieden');
  const m = await getMembership(db, rel.project_id, q.user.id);
  const tasks = await db.query(`select id, responsible_user_id, subproject_id from tasks where id = any($1::uuid[])`, [[rel.task_a, rel.task_b]]);
  const responsible = tasks.rows.some((t: any) => t.responsible_user_id === q.user.id);
  let chainOk = false;
  for (const t of tasks.rows) { const c = await contactChain(db, { id: t.id, project_id: rel.project_id, parent_id: null, subproject_id: t.subproject_id }, {}); if (c[0]?.id === q.user.id) chainOk = true; }
  if (!(m?.role === 'pl' || responsible || chainOk || (q.option === 'independent' && m && m.role !== 'reader'))) throw new Error('Entscheiden dürfen die PL oder die Zuständigen der beiden Arbeitspakete');
  if (q.option === 'dependency' && m?.role !== 'pl' && !m?.canEditPlan) throw new Error('Eine Abhängigkeit setzt die PL oder wer „Projektplan ändern“ darf');
  const lead = q.leadTaskId && [rel.task_a, rel.task_b].includes(q.leadTaskId) ? q.leadTaskId : rel.task_a;
  const other = lead === rel.task_a ? rel.task_b : rel.task_a;
  const note = cut(q.text, 500) || null;
  let kind: string = rel.kind; let status = 'accepted';
  switch (q.option) {
    case 'sync': kind = 'sync'; await crossLog(db, rel, q.user.id, `synchron bearbeiten, Lead ${await code(db, lead)} (entschieden von ${q.user.name})${note ? ` – ${note}` : ''}`); break;
    case 'dependency': kind = 'dependency'; await db.query(`insert into task_dependencies (predecessor_id, successor_id) values ($1,$2) on conflict do nothing`, [lead, other]); await crossLog(db, rel, q.user.id, `Abhängigkeit: ${await code(db, lead)} zuerst (entschieden von ${q.user.name})`); break;
    case 'duplicate': {
      kind = 'duplicate';
      await crossLog(db, rel, q.user.id, `Doppelarbeit, zusammenführen in ${await code(db, lead)} (entschieden von ${q.user.name}); das Zusammenführen selbst nimmt die PL vor${note ? ` – ${note}` : ''}`);
      const pls = await db.query(`select m.user_id from project_members m join users u on u.id = m.user_id where m.project_id = $1 and m.role = 'pl' and u.kind <> 'agent' and u.active`, [rel.project_id]);
      for (const p of pls.rows) if (p.user_id !== q.user.id) await notify(db, { userId: p.user_id, projectId: rel.project_id, taskId: lead, type: 'task.merge', title: `Zusammenführen: ${await code(db, other)} in ${await code(db, lead)}`, body: `entschieden von ${q.user.name}`, link: `/projekte/${rel.project_id}/board?task=${lead}`, actorId: q.user.id });
      break;
    }
    case 'independent': status = 'rejected'; break;
    default: throw new Error('Option sync, dependency, duplicate oder independent');
  }
  await db.query(`update task_relations set kind = $2, status = $3, lead_task_id = $4, decided_by = $5, decided_at = now(), note = coalesce($6, note) where id = $1`, [rel.id, kind, status, status === 'accepted' ? lead : null, q.user.id, note]);
  if (rel.question_id) { const oq = await db.maybeOne<QuestionRow>(`select * from questions where id = $1 and status = 'open'`, [rel.question_id]); if (oq) await cancelQuestions(db, { questionId: oq.id }, `entschieden: ${q.option}`, q.user.id); }
  await audit(db, { orgId: q.user.orgId, projectId: rel.project_id, userId: q.user.id, action: 'relation.decide', objectType: 'task_relation', objectId: rel.id, details: { option: q.option, lead } });
  return { status, kind };
}
const code = async (db: Db, taskId: string) => { const t = await db.one(`select t.number, p.key from tasks t join projects p on p.id = t.project_id where t.id = $1`, [taskId]); return `${t.key}-${t.number}`; };

/** Antwort auf eine Frage synergy (Karte oder Chat) führt die Option aus; Freitext ohne Option gilt als „unabhängig“ nur mit klarem Nein. */
export async function onSynergyAnswered(db: Db, q: QuestionRow, a: AnswerInput): Promise<boolean> {
  const ctx = (q as any).context as { relationId?: string; lead?: string } | null;
  if (!ctx?.relationId || !a.userId) return false;
  const option = a.option ?? (/unabhängig|kein zusammenhang|nein/i.test(a.text) ? 'independent' : /abhängig/i.test(a.text) ? 'dependency' : /zusammen(führen|legen)|dopp/i.test(a.text) ? 'duplicate' : /synchron|gemeinsam|zusammen/i.test(a.text) ? 'sync' : null);
  if (!option) return false;
  const u = await db.maybeOne(`select id, name, org_id from users where id = $1`, [a.userId]);
  if (!u) return false;
  try { await decideRelation(db, { relationId: ctx.relationId, option, user: { id: u.id, name: u.name, orgId: u.org_id }, leadTaskId: ctx.lead ?? null, text: a.option ? null : a.text }); }
  catch (e: any) { if (q.task_id) await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'system')`, [q.task_id, a.userId, `Zusammenhang nicht entschieden: ${String(e?.message ?? e)}`]); }
  return true;
}

export function mapRelation(r: any, forTaskId: string) {
  const otherIsB = r.task_a === forTaskId;
  return { id: r.id, projectId: r.project_id, kind: r.kind, status: r.status, signals: r.signals ?? [], note: r.note ?? null, leadTaskId: r.lead_task_id ?? null, questionId: r.question_id ?? null, foundByName: r.found_by_name ?? null, decidedByName: r.decided_by_name ?? null, decidedAt: r.decided_at ?? null, createdAt: r.created_at,
    other: { id: otherIsB ? r.task_b : r.task_a, ref: `${r.key}-${otherIsB ? r.b_number : r.a_number}`, title: otherIsB ? r.b_title : r.a_title, done: Boolean(otherIsB ? r.b_done : r.a_done) } };
}
export const RELATION_SELECT = `select r.*, p.key, a.number as a_number, a.title as a_title, ca.is_done as a_done, b.number as b_number, b.title as b_title, cb.is_done as b_done, fu.name as found_by_name, du.name as decided_by_name
  from task_relations r join projects p on p.id = r.project_id join tasks a on a.id = r.task_a join board_columns ca on ca.id = a.column_id join tasks b on b.id = r.task_b join board_columns cb on cb.id = b.column_id left join users fu on fu.id = r.found_by left join users du on du.id = r.decided_by`;

// ---------------------------------------------------------------------------------------------------------------------
// Projektdurchlauf (Konzept 6.6): Projektagent mit scope project, werktags zur Uhrzeit reviewAt, nur bei geändertem Quell-Hash

const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['brief', 'actions'],
  properties: {
    brief: { type: 'string', description: 'Steckbrief des Projekts (höchstens 2500 Zeichen) oder leer, wenn unverändert' },
    actions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['type', 'ref', 'ref2', 'kind', 'text', 'reason'], properties: {
      type: { type: 'string', enum: ['relate', 'note', 'ask', 'none'] },
      ref: { type: 'string', description: 'relate/note/ask: Kennung des Arbeitspakets; sonst leer' },
      ref2: { type: 'string', description: 'relate: Kennung des zweiten Arbeitspakets; sonst leer' },
      kind: { type: 'string', description: 'relate: related, sync, duplicate oder dependency; sonst leer' },
      text: { type: 'string', description: 'relate: Begründung; note: Hinweis; ask: Frage an die PL; sonst leer' },
      reason: { type: 'string', description: 'none: Grund; sonst leer' }
    } } }
  }
};
const berlinNow = (d: Date) => { const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d); const g = (t: string) => parts.find((p) => p.type === t)?.value ?? ''; return { dow: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(g('weekday')) + 1, hm: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`, ymd: `${g('year')}-${g('month')}-${g('day')}` }; };

/** Worker: fällige Projektdurchläufe (Projektagent gesetzt, scope project, Werktag, Uhrzeit erreicht, heute noch keiner). */
export async function runProjectReviews(db: Db, mail: MailService, fetchFn: typeof fetch, now = new Date()): Promise<number> {
  const b = berlinNow(now);
  if (b.dow > 5) return 0;
  const projects = await db.query(`select p.id, p.key, p.agent_user_id from projects p join users u on u.id = p.agent_user_id where p.status = 'active' and p.agent_user_id is not null and u.active`);
  let n = 0;
  for (const p of projects.rows as any[]) {
    const pol = await effectiveAgentPolicy(db, { agentId: p.agent_user_id, projectId: p.id });
    if (pol.scope !== 'project' || b.hm < pol.reviewAt) continue;
    const today = await db.maybeOne(`select 1 from agent_runs where project_id = $1 and agent_user_id = $2 and scope = 'project' and created_at >= ($3::date)::timestamptz - interval '2 hours' limit 1`, [p.id, p.agent_user_id, b.ymd]);
    if (today) continue;
    const agent = await db.one(`select id, name, org_id, persona from users where id = $1`, [p.agent_user_id]);
    await runProjectReview(db, mail, fetchFn, agent, p.id, { now });
    n++;
  }
  return n;
}

/** Ein Projektdurchlauf; force = auch ohne geänderten Quell-Hash (Knopf der PL). */
export async function runProjectReview(db: Db, _mail: MailService, fetchFn: typeof fetch, agent: { id: string; name: string; org_id: string; persona?: string | null }, projectId: string, opts: { force?: boolean; now?: Date } = {}): Promise<{ runId: string | null; status: 'ok' | 'error' | 'skipped'; error?: string; actions: unknown[] }> {
  const now = opts.now ?? new Date();
  const project = await db.one(`select id, key, name, org_id from projects where id = $1`, [projectId]);
  const { cfg, decision } = await aiConfigFor(db, { userId: agent.id, projectId, feature: 'agent.run', now });
  const skip = async (error: string) => { const r = await db.one(`insert into agent_runs (org_id, agent_user_id, project_id, task_id, trigger, status, error, scope) values ($1,$2,$3,null,'project_review','skipped',$4,'project') returning id`, [project.org_id, agent.id, projectId, error.slice(0, 500)]); return { runId: r.id as string, status: 'skipped' as const, error, actions: [] }; };
  if (!cfg) return skip(decision.publicReason);
  const digest = await projectDigest(db, { projectId, agentId: agent.id });
  if (!digest.changed && !opts.force) return skip('Projekt unverändert seit dem letzten Durchlauf (kein LLM-Aufruf)');
  // Kandidatenpaare: je offenem AP bis 1 Kandidat, höchstens 10 Paare
  const aps = await db.query(`select t.id, t.number, t.title, c.name as column_name, s.name as sp, coalesce(u.name, t.responsible_email) as resp, t.due_date from tasks t join board_columns c on c.id = t.column_id left join subprojects s on s.id = t.subproject_id left join users u on u.id = t.responsible_user_id where t.project_id = $1 and t.parent_id is null and t.deleted_at is null and t.archived_at is null and not c.is_done and ${visibleSubprojectSql(2)} order by t.position limit 60`, [projectId, agent.id]);
  const pairs: { a: string; b: Candidate }[] = []; const seen = new Set<string>();
  for (const t of aps.rows as any[]) {
    if (pairs.length >= 10) break;
    for (const c of await findCandidates(db, { projectId, taskId: t.id, agentId: agent.id, max: 1 })) { const k = [t.id, c.taskId].sort().join('|'); if (!seen.has(k)) { seen.add(k); pairs.push({ a: `${project.key}-${t.number}`, b: c }); } }
  }
  const openQs = await db.query(`select q.body, q.created_at, p.key, t.number from questions q join projects p on p.id = q.project_id left join tasks t on t.id = q.task_id where q.project_id = $1 and q.status = 'open' order by q.created_at limit 15`, [projectId]);
  const recent = await db.query(`select t.number, t.title, c.body, c.created_at from task_comments c join tasks t on t.id = c.task_id where t.project_id = $1 and c.created_at > $2::timestamptz - interval '24 hours' and c.source <> 'ai' order by c.created_at desc limit 20`, [projectId, now]);
  const system = `${AGENT_SHEET}\n\n${PROJECT_RULES}\n\n# Du\nDu bist „${agent.name}“, Projektagent von ${project.key} „${project.name}“.`;
  const prompt = `Heute: ${now.toISOString().slice(0, 10)}
${digestText(digest)}

Offene Arbeitspakete (Kennung · Titel · Status · Teilprojekt · zuständig · fällig):
${aps.rows.map((t: any) => `- ${project.key}-${t.number} · ${cut(t.title, 70)} · ${t.column_name}${t.sp ? ` · ${t.sp}` : ''}${t.resp ? ` · ${t.resp}` : ''}${t.due_date ? ` · ${d10(t.due_date)}` : ''}`).join('\n') || '–'}
${pairs.length ? `Mögliche Überschneidungen (prüfen, bei Bedarf relate):\n${pairs.map((p) => `- ${p.a} ↔ ${p.b.ref} „${cut(p.b.title, 60)}“ · ${p.b.signals.map((s) => s.detail).join('; ')}`).join('\n')}\n` : ''}${openQs.rows.length ? `Offene Fragen im Projekt:\n${openQs.rows.map((q: any) => `- ${q.key}${q.number ? `-${q.number}` : ''} seit ${new Date(q.created_at).toLocaleDateString('de-DE')}: ${cut(q.body, 160)}`).join('\n')}\n` : ''}${recent.rows.length ? `Änderungen der letzten 24 Stunden:\n${recent.rows.map((c: any) => `- ${project.key}-${c.number} „${cut(c.title, 50)}“: ${cut(c.body, 200)}`).join('\n')}\n` : ''}
Finde Doppelarbeit, Synergien, Widersprüche und offene Punkte; schreibe den Steckbrief neu, wenn sich Wesentliches geändert hat.`;
  try {
    const r = await complete(cfg, fetchFn, { system, prompt, maxTokens: cfg.enableThinking === true ? 6000 : 2500, schema: REVIEW_SCHEMA });
    const j = parseJson<{ brief?: string; actions?: any[] }>(r.text);
    const actions = (Array.isArray(j.actions) ? j.actions : []).slice(0, 12);
    const applied: unknown[] = []; const errors: string[] = [];
    const pol = await effectiveAgentPolicy(db, { agentId: agent.id, projectId });
    const run = await db.one(`insert into agent_runs (org_id, agent_user_id, project_id, task_id, trigger, status, reasoning, actions, input_tokens, output_tokens, scope) values ($1,$2,$3,null,'project_review','ok',$4,'[]',$5,$6,'project') returning id`, [project.org_id, agent.id, projectId, cut(j.brief ? 'Steckbrief aktualisiert' : 'Durchlauf', 300), r.inputTokens, r.outputTokens]);
    const brief = cut(j.brief, 2500);
    if (brief) { await db.query(`update project_digests set brief = $3, brief_run_id = $4 where project_id = $1 and visibility_key = $2`, [projectId, digest.key, brief, run.id]); applied.push({ type: 'brief', text: cut(brief, 300) }); }
    for (const a of actions) {
      try {
        if (a.type === 'relate') {
          const ta = await findTaskByRef(db, projectId, a.ref); const tb = await findTaskByRef(db, projectId, a.ref2);
          if (!ta || !tb) { errors.push(`relate: ${a.ref ?? '?'}/${a.ref2 ?? '?'} nicht gefunden`); continue; }
          if (!(await canSeeSubproject(db, agent.id, ta.subproject_id)) || !(await canSeeSubproject(db, agent.id, tb.subproject_id))) { errors.push('relate: Teilprojekt nicht sichtbar'); continue; }
          if (pol.synergies === 'off') { errors.push('relate: Synergien sind aus (Agenten-Policy)'); continue; }
          const kind: RelationKind = ['related', 'sync', 'duplicate', 'dependency'].includes(a.kind) ? a.kind : 'related';
          const rel = await createRelation(db, { projectId, a: ta.id, b: tb.id, kind, signals: [{ type: 'agent', detail: cut(a.text, 200) || 'vom Projektagenten erkannt' }], note: cut(a.text, 500) || null, foundBy: agent.id });
          if ('error' in rel) { errors.push(`relate: ${rel.error}`); continue; }
          if (pol.synergies === 'use') { await crossLog(db, { task_a: ta.id < tb.id ? ta.id : tb.id, task_b: ta.id < tb.id ? tb.id : ta.id }, agent.id, cut(a.text, 300) || kind); await db.query(`update task_relations set status = 'accepted', decided_by = $2, decided_at = now() where id = $1`, [rel.id, agent.id]); }
          else { const q = await askSynergy(db, { relationId: rel.id, agent, now }); if ('error' in q) errors.push(`relate: ${q.error}`); }
          applied.push({ type: 'relate', ref: a.ref, ref2: a.ref2, kind });
        } else if (a.type === 'note') {
          const t = await findTaskByRef(db, projectId, a.ref);
          if (!t || !String(a.text ?? '').trim()) { errors.push(`note: ${a.ref ?? '?'} nicht gefunden oder leer`); continue; }
          if (!(await canSeeSubproject(db, agent.id, t.subproject_id))) { errors.push('note: Teilprojekt nicht sichtbar'); continue; }
          await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [t.id, agent.id, `Hinweis aus dem Projektdurchlauf: ${cut(a.text, 1000)}`]);
          applied.push({ type: 'note', ref: a.ref, text: cut(a.text, 200) });
        } else if (a.type === 'ask') {
          const t = await findTaskByRef(db, projectId, a.ref);
          if (!t) { errors.push(`ask: ${a.ref ?? '?'} nicht gefunden`); continue; }
          const q = await askQuestion(db, { taskId: t.id, asker: agent, kind: 'question', to: 'pl', body: String(a.text ?? '').trim(), now, type: 'project_review' });
          if ('error' in q) errors.push(`ask: ${q.error}`); else applied.push({ type: 'ask', ref: a.ref, text: cut(a.text, 200) });
        } else if (a.type === 'none') applied.push({ type: 'none', reason: a.reason });
      } catch (e: any) { errors.push(`${a.type}: ${String(e?.message ?? e).slice(0, 200)}`); }
    }
    await db.query(`update agent_runs set status = $2, actions = $3, error = $4, context_stats = $5 where id = $1`, [run.id, errors.length ? 'error' : 'ok', JSON.stringify(applied), errors.length ? errors.join(' | ').slice(0, 1000) : null, JSON.stringify({ limit: Math.floor((cfg.contextTokens ?? 32000) * 0.45), before: estTokens(system + prompt), after: estTokens(system + prompt), trimmed: {} })]);
    await audit(db, { orgId: project.org_id, projectId, userId: agent.id, action: 'agent.project_review', objectType: 'project', objectId: projectId, details: { runId: run.id, actions: applied.length, errors: errors.length, profile: cfg.name, model: r.model } });
    return { runId: run.id, status: errors.length ? 'error' : 'ok', error: errors.length ? errors.join(' | ') : undefined, actions: applied };
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 300);
    const r = await db.one(`insert into agent_runs (org_id, agent_user_id, project_id, task_id, trigger, status, error, scope) values ($1,$2,$3,null,'project_review','error',$4,'project') returning id`, [project.org_id, agent.id, projectId, msg]);
    return { runId: r.id, status: 'error', error: msg, actions: [] };
  }
}
