import type { Db } from '../db.js';
import { audit } from '../audit.js';
import { htmlToText } from '../docs/html.js';
import { reportFactsHtml } from '../docs/report.js';
import { getMembership, getViewRights, visibleSubprojectSql } from '../rights.js';
import { complete, parseJson, type AiConfig } from './client.js';
import { recordAssist } from './policy.js';
import type { User } from '@projekttool/shared';

const BASE_SYSTEM = 'Du bist die KI-Assistenz eines Projekttools (Arbeitspakete, Mails, Doku). Antworte knapp, sachlich und auf Deutsch. Erfinde keine Fakten; was nicht in den Daten steht, kennzeichne als unbekannt.';
const cut = (s: string | null | undefined, n: number) => { const t = (s ?? '').trim(); return t.length > n ? t.slice(0, n) + ' …' : t; };

function mailText(m: any): string {
  const body = m.text_body ?? (m.html_body ? htmlToText(m.html_body) : m.snippet) ?? '';
  return `Betreff: ${m.subject}\nVon: ${m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr}\nAn: ${(m.to_json ?? []).join(', ')}\nDatum: ${new Date(m.date).toLocaleString('de-DE')}\n\n${cut(body, 12000)}`;
}

/** Assistenz-Aufruf: Audit für die auslösende Person, Lauf des ausführenden Agenten (zählt in sein Tagesbudget). */
async function logCall(db: Db, cfg: AiConfig, user: User, projectId: string | null, kind: string, c: { inputTokens: number; outputTokens: number; model: string }, objectType: string, objectId: string) {
  await audit(db, { orgId: user.orgId, projectId, userId: user.id, action: 'ai.call', objectType, objectId, details: { kind, model: c.model, inputTokens: c.inputTokens, outputTokens: c.outputTokens, agentId: cfg.agentUserId ?? null } });
  if (cfg.agentUserId && projectId) await recordAssist(db, { id: cfg.agentUserId, org_id: user.orgId }, projectId, kind, c);
}

/** Zusammenfassung einer Mail (wird an der Mail gespeichert, zweiter Aufruf kostet nichts). */
export async function summarizeMail(db: Db, cfg: AiConfig, fetchFn: typeof fetch, user: User, mail: any, projectId: string | null): Promise<string> {
  if (mail.ai_summary) return mail.ai_summary;
  const c = await complete(cfg, fetchFn, { system: BASE_SYSTEM, maxTokens: 500, prompt: `Fasse diese Mail in höchstens fünf Sätzen zusammen. Nenne zuerst, was gefordert oder entschieden wird, dann offene Punkte und Termine.\n\n${mailText(mail)}` });
  await db.query(`update mails set ai_summary = $2 where id = $1`, [mail.id, c.text]);
  await logCall(db, cfg, user, projectId, 'summarize', c, 'mail', mail.id);
  return c.text;
}

const ESSENCE_SCHEMA = { type: 'object', additionalProperties: false, required: ['summary', 'logEntry', 'columnName', 'dueDate', 'questions'], properties: { summary: { type: 'string' }, logEntry: { type: 'string' }, columnName: { type: ['string', 'null'] }, dueDate: { type: ['string', 'null'] }, questions: { type: 'array', items: { type: 'string' } } } };

export interface TaskEssence { summary: string; logEntry: string; columnName: string | null; dueDate: string | null; questions: string[] }

/** Essenz einer Mail für ein Arbeitspaket: Log-Eintrag, ggf. neuer Status oder Termin, offene Fragen. Nur Vorschlag. */
export async function essenceForTask(db: Db, cfg: AiConfig, fetchFn: typeof fetch, user: User, mail: any, task: { id: string; title: string; description: string | null; dueDate: string | null; columnName: string; projectId: string }, columns: string[]): Promise<TaskEssence> {
  const prompt = `Arbeitspaket: „${task.title}“ (Status: ${task.columnName}${task.dueDate ? `, Termin ${task.dueDate}` : ''})\nBeschreibung: ${cut(task.description, 1500) || '–'}\nMögliche Status: ${columns.join(', ')}\n\nMail:\n${mailText(mail)}\n\nLiefere JSON mit den Feldern:\n- summary: ein Satz, was die Mail für das Arbeitspaket bedeutet\n- logEntry: 2–6 Sätze als Log-Eintrag (Fakten, Zusagen, Termine, Verantwortliche)\n- columnName: einer der möglichen Status, wenn die Mail eine Statusänderung klar belegt, sonst null\n- dueDate: neues Datum als YYYY-MM-DD, wenn die Mail einen neuen Termin klar nennt, sonst null\n- questions: Liste offener Fragen (leer, wenn keine)`;
  const c = await complete(cfg, fetchFn, { system: BASE_SYSTEM + ' Antworte ausschließlich mit einem JSON-Objekt.', maxTokens: 900, prompt, schema: ESSENCE_SCHEMA });
  const j = parseJson(c.text);
  await logCall(db, cfg, user, task.projectId, 'task_essence', c, 'task', task.id);
  const col = typeof j.columnName === 'string' ? columns.find((x) => x.toLowerCase() === j.columnName.toLowerCase()) ?? null : null;
  const due = typeof j.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(j.dueDate) ? j.dueDate : null;
  return { summary: String(j.summary ?? '').trim(), logEntry: String(j.logEntry ?? '').trim(), columnName: col, dueDate: due, questions: Array.isArray(j.questions) ? j.questions.map(String).slice(0, 8) : [] };
}

/** Essenz einer Mail als Abschnitt für ein Protokoll oder einen Bericht (Markdown, ohne Überschrift erster Ebene). */
export async function essenceForPage(db: Db, cfg: AiConfig, fetchFn: typeof fetch, user: User, mail: any, page: { id: string; title: string; content_md: string; project_id: string }): Promise<string> {
  const prompt = `Seite „${page.title}“ (Auszug):\n${cut(page.content_md, 3000) || '–'}\n\nMail:\n${mailText(mail)}\n\nSchreibe einen Abschnitt in Markdown, der die Essenz der Mail in den Stil der Seite einfügt: Überschrift zweiter Ebene mit Thema und Datum, dann Stichpunkte (Entscheidungen, Zusagen, Termine, offene Punkte). Keine Einleitung, kein Zitat der Mail.`;
  const c = await complete(cfg, fetchFn, { system: BASE_SYSTEM, maxTokens: 800, prompt });
  await logCall(db, cfg, user, page.project_id, 'page_essence', c, 'doc_page', page.id);
  return c.text;
}

/** Entwurf eines Statusberichts aus den Kennzahlen des Regelwerks, RAID und Ampel; Markdown für eine Entwurfsseite. */
export async function statusReportDraft(db: Db, cfg: AiConfig, fetchFn: typeof fetch, user: User, projectId: string, today: string): Promise<string> {
  const pr = await db.one(`select name, key, description, health from projects where id = $1`, [projectId]);
  const since = new Date(new Date(today + 'T00:00:00Z').getTime() - 14 * 86400_000).toISOString().slice(0, 10);
  const facts = htmlToText(await reportFactsHtml(db, projectId, today, since));
  const raid = await db.query(`select kind, title, status, probability, impact from raid_items where project_id = $1 and status <> 'closed' order by (probability * impact) desc nulls last limit 12`, [projectId]).catch(() => ({ rows: [] as any[] }));
  const recent = await db.query(`select c.body, t.title from task_comments c join tasks t on t.id = c.task_id where t.project_id = $1 and c.created_at >= $2::date order by c.created_at desc limit 20`, [projectId, since]);
  const health = pr.health ?? null;
  const prompt = `Projekt ${pr.key} „${pr.name}“${pr.description ? `: ${cut(pr.description, 400)}` : ''}\nStand ${today}${health?.color ? `, Ampel laut Projektleitung: ${health.color}${health.note ? ` (${health.note})` : ''}` : ''}\n\nKennzahlen und Listen (automatisch):\n${cut(facts, 6000)}\n\nRisiken, Annahmen, Issues, Entscheidungen (offen):\n${raid.rows.map((r: any) => `- [${r.kind}] ${r.title} (${r.status}${r.probability ? `, W×A ${r.probability}×${r.impact}` : ''})`).join('\n') || '–'}\n\nLog-Einträge der letzten zwei Wochen:\n${recent.rows.map((r: any) => `- ${r.title}: ${cut(r.body, 200)}`).join('\n') || '–'}\n\nSchreibe den Entwurf eines Statusberichts in Markdown mit den Abschnitten: Management-Summary (3–5 Sätze), Fortschritt, Risiken und Probleme, Entscheidungsbedarf, Nächste Schritte. Nutze nur die Daten oben; Zahlen exakt übernehmen. Überschriften zweiter Ebene.`;
  const c = await complete(cfg, fetchFn, { system: BASE_SYSTEM, maxTokens: 1600, prompt });
  await logCall(db, cfg, user, projectId, 'status_report', c, 'project', projectId);
  return c.text;
}

export interface AskSource { type: 'task' | 'page' | 'mail'; id: string; title: string }

/** Frage ans Projekt: Stichwortsuche über Arbeitspakete, Seiten und lesbare Mails, Antwort mit Quellenangabe. */
export async function askProject(db: Db, cfg: AiConfig, fetchFn: typeof fetch, user: User, projectId: string, question: string): Promise<{ answer: string; sources: AskSource[] }> {
  const words = [...new Set(question.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter((w) => w.length >= 4))].slice(0, 8);
  const likeAny = words.length ? words.map((_, i) => `$${i + 3}`) : [];
  const cond = (cols: string[]) => (likeAny.length ? `and (${cols.map((c) => likeAny.map((p) => `${c} ilike ${p}`).join(' or ')).join(' or ')})` : '');
  const params = [projectId, user.id, ...words.map((w) => `%${w}%`)];
  const tasks = await db.query(`select t.id, t.title, t.description, t.due_date, c.is_done as done, t.blocked, t.blocked_reason, c.name as column_name, (select string_agg(x.body, ' | ') from (select body from task_comments where task_id = t.id order by created_at desc limit 3) x) as log
    from tasks t join board_columns c on c.id = t.column_id where t.project_id = $1 and t.deleted_at is null and ${visibleSubprojectSql(2)} ${cond(['t.title', 't.description'])} order by t.updated_at desc limit 12`, params);
  const pages = await db.query(`select d.id, d.title, d.content_md from doc_pages d where d.project_id = $1 and d.deleted_at is null and $2::uuid is not null ${cond(['d.title', 'd.content_md'])} order by d.updated_at desc limit 6`, params);
  const views = await db.query(`select id from mail_views where project_id = $1`, [projectId]);
  const readable: string[] = [];
  const m = await getMembership(db, projectId, user.id);
  for (const v of views.rows) if ((await getViewRights(db, v.id, user, m)).canRead) readable.push(v.id);
  const mails = readable.length ? await db.query(`select distinct m.id, m.subject, m.from_addr, m.date, m.text_body, m.snippet from mails m join mail_view_matches x on x.mail_id = m.id where x.view_id = any($1::uuid[]) ${likeAny.length ? `and (${words.map((_, i) => `m.subject ilike $${i + 2} or m.text_body ilike $${i + 2}`).join(' or ')})` : ''} order by m.date desc limit 8`, [readable, ...words.map((w) => `%${w}%`)]) : { rows: [] as any[] };
  const sources: AskSource[] = [
    ...tasks.rows.map((t: any) => ({ type: 'task' as const, id: t.id, title: t.title })),
    ...pages.rows.map((p: any) => ({ type: 'page' as const, id: p.id, title: p.title })),
    ...mails.rows.map((x: any) => ({ type: 'mail' as const, id: x.id, title: x.subject }))
  ];
  const ctx = [
    ...tasks.rows.map((t: any, i: number) => `[Q${i + 1}] Arbeitspaket „${t.title}“ – Status ${t.column_name}${t.done ? ' (erledigt)' : ''}${t.due_date ? `, Termin ${String(t.due_date).slice(0, 10)}` : ''}${t.blocked ? `, blockiert: ${t.blocked_reason ?? ''}` : ''}\n${cut(t.description, 400)}${t.log ? `\nLog: ${cut(t.log, 500)}` : ''}`),
    ...pages.rows.map((p: any, i: number) => `[Q${tasks.rows.length + i + 1}] Seite „${p.title}“\n${cut(p.content_md, 1500)}`),
    ...mails.rows.map((x: any, i: number) => `[Q${tasks.rows.length + pages.rows.length + i + 1}] Mail „${x.subject}“ von ${x.from_addr}, ${new Date(x.date).toLocaleDateString('de-DE')}\n${cut(x.text_body ?? x.snippet, 800)}`)
  ];
  const prompt = `Frage: ${question}\n\nQuellen aus dem Projekt:\n${ctx.join('\n\n') || '(keine Treffer)'}\n\nBeantworte die Frage nur aus den Quellen und verweise mit [Q1], [Q2] … auf die genutzten. Wenn die Quellen nicht reichen, sage das.`;
  const c = await complete(cfg, fetchFn, { system: BASE_SYSTEM, maxTokens: 800, prompt });
  await logCall(db, cfg, user, projectId, 'ask', c, 'project', projectId);
  const used = new Set([...c.text.matchAll(/\[Q(\d+)\]/g)].map((x) => Number(x[1]) - 1));
  return { answer: c.text, sources: sources.filter((_, i) => used.size === 0 || used.has(i)) };
}

