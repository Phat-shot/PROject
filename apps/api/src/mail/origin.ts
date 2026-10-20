import type { Db } from '../db.js';
import { complete, type AiConfig } from '../ai/client.js';
import { USE_LATERAL } from './accounts.js';

/**
 * Ursprungsmail: Entsteht ein Arbeitspaket oder eine Aufgabe aus einer eingehenden Mail, ist die Verknüpfung als Ursprung
 * markiert. Zum Abschluss wird die Ursprungsmail beantwortet (aufbereitetes Ergebnis statt Log), die Antwort hängt als
 * Mail am Arbeitspaket, nicht im Log.
 */
export async function originMails(db: Db, taskId: string): Promise<any[]> {
  const r = await db.query(
    `select m.*, ux.use, ux.use_user_id, t.project_id,
       exists (select 1 from mails x where x.account_id = m.account_id and x.outgoing and m.message_id is not null and x.in_reply_to = m.message_id) as answered,
       exists (select 1 from mail_drafts d where d.account_id = m.account_id and m.message_id is not null and d.in_reply_to = m.message_id and d.status in ('draft','pending_approval')) as draft_open
     from mail_task_links l join mails m on m.id = l.mail_id join mail_accounts a on a.id = m.account_id join tasks t on t.id = l.task_id ${USE_LATERAL('a', 't.project_id')}
     where l.task_id = $1 and l.origin and not m.outgoing order by m.date`, [taskId]);
  return r.rows;
}

/**
 * Inhalt einer Mail am Arbeitspaket für KI-Kontexte (Agenten-Prompt, Neuformulierung nach außen): über eine persönliche Bindung
 * nur, wenn ihn alle Menschen im Projekt ohnehin lesen dürften (Kopie) oder nur der Eigentümer Mitglied ist (persönliches Projekt).
 */
export const mailBodyOk = (x: { use: string | null; copied?: boolean | null; use_user_id: string | null }, humans: string[]) => x.use !== 'personal' || Boolean(x.copied) || humans.every((h) => h === x.use_user_id);

/** Menschen (keine Agenten) im Projekt, für mailBodyOk. */
export async function projectHumans(db: Db, projectId: string): Promise<string[]> {
  return (await db.query(`select m.user_id from project_members m join users u on u.id = m.user_id where m.project_id = $1 and u.kind <> 'agent'`, [projectId])).rows.map((r: any) => r.user_id);
}

const dateDe = (d: any) => new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Berlin' });
export const reSubject = (s: string | null | undefined) => { const x = (s ?? '').trim() || '(kein Betreff)'; return /^(re|aw):/i.test(x) ? x : `Re: ${x}`; };

async function resultParts(db: Db, taskId: string) {
  const subs = await db.query(`select t.title, c.is_done from tasks t join board_columns c on c.id = t.column_id where t.parent_id = $1 and t.deleted_at is null and t.archived_at is null order by t.position, t.created_at`, [taskId]);
  const items = await db.query(`select title, done from checklist_items where task_id = $1 order by position`, [taskId]);
  return {
    done: [...subs.rows.filter((x: any) => x.is_done).map((x: any) => x.title), ...items.rows.filter((x: any) => x.done).map((x: any) => x.title)] as string[],
    open: [...subs.rows.filter((x: any) => !x.is_done).map((x: any) => x.title), ...items.rows.filter((x: any) => !x.done).map((x: any) => x.title)] as string[]
  };
}

/** Abschluss-Antwort ohne KI: Anrede, Bezug, erledigte Schritte als Ergebnis, Offenes, Gruß. Kein Log. */
export async function finalReplyText(db: Db, task: { id: string; title: string; is_done: boolean }, mail: any, signer: string): Promise<string> {
  const { done, open } = await resultParts(db, task.id);
  return [
    mail.from_name ? `Guten Tag ${mail.from_name},` : 'Guten Tag,',
    '',
    `zu Ihrer Nachricht „${mail.subject || '(kein Betreff)'}“ vom ${dateDe(mail.date)}: ${task.is_done ? `„${task.title}“ ist erledigt.` : `der aktuelle Stand zu „${task.title}“.`}`,
    '',
    'Ergebnis:',
    ...(done.length ? done.map((x) => `- ${x}`) : ['- (bitte ergänzen)']),
    ...(open.length ? ['', 'Noch offen:', ...open.map((x) => `- ${x}`)] : []),
    '',
    'Mit freundlichen Grüßen',
    signer
  ].join('\n');
}

const cut = (s: string | null | undefined, n: number) => { const t = (s ?? '').trim(); return t.length > n ? t.slice(0, n) + ' …' : t; };

/** Abschluss-Antwort mit der Projekt-KI: Ergebnis für den Absender, aus Arbeitspaket, Aufgaben, Tasks und Log verdichtet. */
export async function aiFinalReply(db: Db, cfg: AiConfig, fetchFn: typeof fetch, task: any, mail: any, signer: string): Promise<{ text: string; inputTokens: number; outputTokens: number; model: string }> {
  const { done, open } = await resultParts(db, task.id);
  const log = await db.query(`select c.body, c.created_at, u.name from task_comments c left join users u on u.id = c.user_id where c.task_id = $1 and c.source <> 'system' order by c.created_at desc limit 15`, [task.id]);
  const system = `Du schreibst die abschließende Antwort auf eine Mail, aus der ein Arbeitspaket entstanden ist. Fasse für den Absender das Ergebnis zusammen: was erledigt wurde, das Ergebnis bzw. die Entscheidung, nötige nächste Schritte oder offene Punkte. Keine Wiedergabe des Logs, keine internen Abläufe, Werkzeuge oder Namen von Teammitgliedern, nichts erfinden, was nicht im Kontext steht. Anrede passend zur Ursprungsmail (Sie, außer der Absender duzt). Antworte nur mit dem Mailtext ohne Betreff, mit Anrede, Gruß und der Unterschrift „${signer}“.`;
  const prompt = `Ursprungsmail von ${mail.from_name ? `${mail.from_name} <${mail.from_addr}>` : mail.from_addr}, ${dateDe(mail.date)}, Betreff „${mail.subject ?? ''}“:
${cut(mail.text_body ?? mail.snippet, 3000)}

Arbeitspaket „${task.title}“ · ${task.is_done ? 'erledigt' : 'noch offen'}
Beschreibung: ${cut(task.description, 1500) || '–'}
Erledigt: ${done.join('; ') || '–'}
Offen: ${open.join('; ') || '–'}
Log (neueste zuerst, nur als Quelle, nicht wiedergeben):
${log.rows.map((x: any) => `- ${dateDe(x.created_at)} ${x.name ?? 'System'}: ${cut(x.body, 300)}`).join('\n') || '–'}`;
  const r = await complete(cfg, fetchFn, { system, prompt, maxTokens: cfg.enableThinking === true ? 4000 : 1200 });
  return { text: r.text.trim(), inputTokens: r.inputTokens, outputTokens: r.outputTokens, model: r.model };
}
