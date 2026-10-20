import type { MailInquiry, MailInquiryMode } from '@projekttool/shared';
import type { Db } from '../db.js';
import { askQuestion, type Asker, type QuestionRow, type AnswerInput } from '../questions.js';
import { queueAgentRun } from './agentEvents.js';
import { onSynergyAnswered } from './knowledge.js';
import { onBookingAnswered } from '../resources/service.js';

/**
 * Mail-Rückfrage (Konzept 5, #51): Nennt die Mail-KI zu einer neuen Mail offene Punkte, fragt der Agent nach, statt zu raten.
 * Einstellung je Projekt mit Vererbung vom Mandanten (orgs.settings.mailInquiry), Standard: Rückfrage an die PL mit Frist 48 h.
 * - ask_pl: Entscheidung an die PL mit den Karten „Klar / Infos kommen“, „Im Projekt fragen“, „Beim Absender rückfragen“
 * - ask_project: Frage direkt im Projektkanal (Frist = waitHours, danach Weitergabe über die Kette)
 * - ask_sender: der Agent fragt beim Absender nach (Lauf mit Anlass inquiry, Antwort über die Außengrenze)
 * - off: offene Punkte stehen nur im Log des Arbeitspakets
 * Ohne Agent (Ordner „KI Bearbeiten“ einer Person) gibt es keinen Fragenden: offene Punkte stehen im Log und in der Meldung.
 */
export const DEFAULT_INQUIRY: MailInquiry = { mode: 'ask_pl', waitHours: 48 };
export const INQUIRY_MODES: MailInquiryMode[] = ['ask_pl', 'ask_project', 'ask_sender', 'off'];
export const INQUIRY_LABEL: Record<MailInquiryMode, string> = { ask_pl: 'PL fragen', ask_project: 'im Projekt fragen', ask_sender: 'beim Absender rückfragen', off: 'aus (nur Log)' };

const cut = (s: string | null | undefined, n: number) => { const t = (s ?? '').trim(); return t.length > n ? t.slice(0, n) + ' …' : t; };

/** Einstellung aus dem Rohwert (projects.mail_inquiry bzw. settings.mailInquiry); ohne Modus unvollständig → null. */
export function inquiryOf(raw: any): MailInquiry | null {
  if (!raw || typeof raw !== 'object' || !INQUIRY_MODES.includes(raw.mode)) return null;
  const h = Number(raw.waitHours);
  return { mode: raw.mode, waitHours: Number.isFinite(h) && h > 0 ? Math.min(720, Math.round(h)) : DEFAULT_INQUIRY.waitHours };
}

/** Wirksame Einstellung: Projekt, sonst Mandant (inherited), sonst Standard (inherited). */
export async function effectiveMailInquiry(db: Db, projectId: string): Promise<MailInquiry> {
  const r = await db.maybeOne(`select p.mail_inquiry, o.settings->'mailInquiry' as org_inquiry from projects p join orgs o on o.id = p.org_id where p.id = $1`, [projectId]);
  const own = inquiryOf(r?.mail_inquiry);
  if (own) return own;
  return { ...(inquiryOf(r?.org_inquiry) ?? DEFAULT_INQUIRY), inherited: true };
}

/** Eingabe validieren (PATCH /projects/:id, PUT /org/settings); null = Vorgabe des Mandanten übernehmen. */
export function parseInquiry(b: unknown): MailInquiry | null {
  if (b === null) return null;
  if (!b || typeof b !== 'object') throw new Error('Mail-Rückfrage: mode und waitHours erwartet');
  const x = b as any;
  if (!INQUIRY_MODES.includes(x.mode)) throw new Error('Mail-Rückfrage: Modus ask_pl, ask_project, ask_sender oder off');
  const h = Number(x.waitHours ?? DEFAULT_INQUIRY.waitHours);
  if (!Number.isInteger(h) || h < 1 || h > 720) throw new Error('Mail-Rückfrage: Frist 1 bis 720 Stunden');
  return { mode: x.mode, waitHours: h };
}

export const INQUIRY_OPTIONS = [{ key: 'klar', label: 'Klar / Infos kommen' }, { key: 'ask_project', label: 'Im Projekt fragen' }, { key: 'ask_sender', label: 'Beim Absender rückfragen' }];

export interface OpenPointsInput {
  project: { id: string; key: string; org_id: string };
  mail: { id: string; subject: string | null; from_addr: string; from_name: string | null };
  /** Arbeitspaket, an dem die Mail hängt (ohne AP keine Frage, nur Meldungstext) */
  taskId: string | null;
  /** fragender Agent (Projektagent oder Agent der Ansicht); ohne Agent nur Log */
  asker: Asker | null;
  /** Ohne Agenten (nur noch Altfälle): Person für den Log-Eintrag */
  actorId: string | null;
  openPoints: string[];
}

const mailLabel = (m: OpenPointsInput['mail']) => `Mail „${cut(m.subject, 80) || '(ohne Betreff)'}“ von ${m.from_name ?? m.from_addr}`;
const pointsText = (points: string[]) => points.map((p) => `- ${p}`).join('\n');

/**
 * Offene Punkte nach einem Mail-KI-Lauf: je nach Einstellung Frage an die PL, ins Projekt, Rückfrage beim Absender oder nur Log.
 * Liefert, was passiert ist (für Lauf-Zusammenfassung und Tests).
 */
export async function handleOpenPoints(db: Db, x: OpenPointsInput): Promise<{ action: 'none' | 'log' | 'ask_pl' | 'ask_project' | 'ask_sender'; questionId?: string; error?: string }> {
  const points = x.openPoints.map((p) => cut(String(p), 200)).filter(Boolean).slice(0, 6);
  if (!points.length || !x.taskId) return { action: 'none' };
  const inquiry = await effectiveMailInquiry(db, x.project.id);
  const logOnly = async (why: string) => {
    await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [x.taskId, x.asker?.id ?? x.actorId, `Offene Punkte aus der ${mailLabel(x.mail)} (${why}):\n${pointsText(points)}`]);
    return { action: 'log' as const };
  };
  if (inquiry.mode === 'off') return logOnly('Mail-Rückfrage aus');
  if (!x.asker) return logOnly('kein Projektagent, der nachfragt');
  const context = { topic: 'mail_inquiry', mailId: x.mail.id, openPoints: points, waitHours: inquiry.waitHours };
  if (inquiry.mode === 'ask_sender') { await askSender(db, x.taskId, x.asker, x.mail, points, 'Einstellung Mail-Rückfrage'); return { action: 'ask_sender' }; }
  if (inquiry.mode === 'ask_project') {
    const r = await askQuestion(db, { taskId: x.taskId, asker: x.asker, kind: 'question', to: 'projekt', dueHours: inquiry.waitHours, body: `Zur ${mailLabel(x.mail)} ist offen:\n${pointsText(points)}\nWer weiß dazu etwas?`, type: 'mail.inquiry', title: `${x.asker.name} fragt zu einer Mail (${x.project.key})`, context });
    if (!('error' in r)) return { action: 'ask_project', questionId: r.question.id };
    // Kein Projektkanal (persönliches Projekt, eingeschränktes Teilprojekt): Rückfall auf die PL
  }
  const r = await askQuestion(db, { taskId: x.taskId, asker: x.asker, kind: 'decision', to: 'pl', dueHours: inquiry.waitHours, body: `Neue ${mailLabel(x.mail)}. Offen ist:\n${pointsText(points)}\nWie weiter?`, options: INQUIRY_OPTIONS, type: 'mail.inquiry', title: `${x.asker.name}: Rückfrage zu einer Mail (${x.project.key})`, context });
  if ('error' in r) { await logOnly(r.error); return { action: 'log', error: r.error }; }
  return { action: 'ask_pl', questionId: r.question.id };
}

/** Rückfrage beim Absender: Log-Eintrag mit den Punkten, dann Lauf des Agenten mit Anlass inquiry (reply_origin über die Außengrenze). */
async function askSender(db: Db, taskId: string, agent: Asker, mail: OpenPointsInput['mail'], points: string[], why: string) {
  await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'system')`, [taskId, agent.id, `Rückfrage beim Absender der ${mailLabel(mail)} (${why}); offen:\n${pointsText(points)}`]);
  queueAgentRun(taskId, 'inquiry', agent.id);
}

/**
 * Antwort auf die Entscheidung der PL (aus answerQuestion): „Im Projekt fragen“ stellt die Frage im Projektkanal,
 * „Beim Absender rückfragen“ startet den Agenten mit Anlass inquiry. Liefert true, wenn ein Folgeschritt den Lauf „answer“ ersetzt.
 */
export async function onQuestionAnswered(db: Db, q: QuestionRow, a: AnswerInput): Promise<boolean> {
  const ctx = (q as any).context as { topic?: string; mailId?: string; openPoints?: string[]; waitHours?: number } | null;
  // Frage synergy (Konzept 6.7): Entscheidung über eine Beziehung zwischen Arbeitspaketen
  if (ctx?.topic === 'synergy') return onSynergyAnswered(db, q, a);
  // Bestätigung einer Belegung (Konzept 10): confirm bestätigt, reject löscht; der Agent läuft danach regulär weiter
  if ((q as any).booking_id) return onBookingAnswered(db, q as any, a);
  if (ctx?.topic !== 'mail_inquiry' || q.kind !== 'decision' || !q.task_id) return false;
  const option = a.option ?? (/absender/i.test(a.text) ? 'ask_sender' : /projekt/i.test(a.text) ? 'ask_project' : null);
  if (option !== 'ask_project' && option !== 'ask_sender') return false;
  const agent = await db.maybeOne<Asker>(`select id, name, org_id, kind from users where id = $1 and active`, [q.asked_by]);
  const mail = ctx.mailId ? await db.maybeOne(`select id, subject, from_addr, from_name from mails where id = $1`, [ctx.mailId]) : null;
  if (!agent || !mail) return false;
  const points = (ctx.openPoints ?? []).map(String);
  const who = a.userId ? (await db.maybeOne(`select name from users where id = $1`, [a.userId]))?.name ?? 'PL' : 'PL';
  if (option === 'ask_sender') { await askSender(db, q.task_id, agent, mail, points, `Entscheidung von ${who}`); return true; }
  const r = await askQuestion(db, { taskId: q.task_id, asker: agent, kind: 'question', to: 'projekt', dueHours: ctx.waitHours ?? DEFAULT_INQUIRY.waitHours, body: `Zur ${mailLabel(mail)} ist offen:\n${pointsText(points)}\nWer weiß dazu etwas? (${who} hat entschieden, im Projekt zu fragen${a.text && a.text.trim() !== 'Im Projekt fragen' ? `: ${cut(a.text, 300)}` : ''})`, type: 'mail.inquiry', title: `${agent.name} fragt zu einer Mail`, context: { ...ctx, parentQuestionId: q.id } });
  if ('error' in r) { await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'system')`, [q.task_id, agent.id, `Im Projekt fragen nicht möglich: ${r.error}`]); return false; }
  return true;
}
