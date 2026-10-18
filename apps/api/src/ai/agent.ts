import type { Db } from '../db.js';
import type { MailService } from '../mail/service.js';
import type { AccountRow } from '../mail/types.js';
import { audit } from '../audit.js';
import { notify, notifyMany, usersWithRight } from '../notify.js';
import { dateStr, touchTask } from '../tasks/service.js';
import { aiConfigForAgent, complete, orgAiSettings, parseJson, type AiConfig } from './client.js';
import { htmlToMd, mdToHtml } from '../docs/html.js';
import { htmlToPdf } from '../docs/pdfHtml.js';
import * as L from '../docs/layout.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { publicBase } from '../docs/share.js';
import { AGENT_SHEET, TASK_RULES } from './sheet.js';
import { originMails, reSubject } from '../mail/origin.js';
import { canSeeSubproject, visibleSubprojectSql } from '../rights.js';
import { EFFECTIVE_JOINS, EFFECTIVE_RESPONSIBLE_SQL, afterAssign, agentChatMessage, createPlannedEvent, createPlannedTask, findTaskByRef, fmtWhen, resolvePerson, ymd, type PlanActor } from './plan.js';

/**
 * KI-Agent als Benutzer: handelt nur bei Arbeitspaketen, die ihm eine PL direkt zugewiesen hat, im Rahmen seiner
 * Mitgliedschaft (Mitglied mit Stellvertretung). Je Lauf bekommt das Modell den Kontext (Arbeitspaket, Log, Tasks,
 * Mails, Projekt) und liefert Aktionen als JSON: Log-Eintrag, Status, Task abhaken, Mail (direkt oder als Entwurf
 * zur Freigabe, je nach „darf Mails senden“), Blockade melden, Eskalation an die PL. Jeder Lauf wird mit Begründung,
 * Aktionen und Token gespeichert und steht im Audit; die PL kann den Agenten je Arbeitspaket pausieren.
 */
export type AgentAction =
  | { type: 'comment'; text: string }
  | { type: 'set_status'; column: string }
  | { type: 'check_item'; itemId: string }
  | { type: 'mail'; to: string[]; subject: string; text: string }
  | { type: 'reply_origin'; text: string }
  | { type: 'chat'; to: string[] | null; text: string }
  | { type: 'blocked'; reason: string }
  | { type: 'escalate'; text: string }
  | { type: 'wait'; kind: 'reply' | 'date' | 'task' | 'info'; reason: string; checkAfterHours?: number; until?: string; remindAfterHours?: number; escalateAfterHours?: number }
  | { type: 'add_item'; text: string }
  | { type: 'update_item'; itemId: string; text: string }
  | { type: 'doc_create'; title: string; folder?: string | null; text: string }
  | { type: 'doc_append'; pageId: string; text: string }
  | { type: 'read_page'; pageId: string }
  | { type: 'doc_update'; pageId: string; title?: string | null; text: string }
  | { type: 'doc_status'; pageId: string; status: 'draft' | 'review' | 'final' }
  | { type: 'doc_move'; pageId: string; folder: string }
  | { type: 'folder_create'; folder: string }
  | { type: 'doc_send_pdf'; pageId: string; to: string[] | null; subject: string; text: string }
  | { type: 'create_aufgabe'; title: string; text?: string | null; ref?: string | null; startDate?: string | null; dueDate?: string | null; responsible?: string | null; items?: string[] | null }
  | { type: 'create_ap'; title: string; text?: string | null; subproject?: string | null; startDate?: string | null; dueDate?: string | null; responsible?: string | null; items?: string[] | null }
  | { type: 'assign'; ref: string; responsible: string | null }
  | { type: 'set_dates'; ref?: string | null; startDate?: string | null; dueDate?: string | null }
  | { type: 'create_subproject'; title: string; responsible?: string | null; startDate?: string | null; dueDate?: string | null }
  | { type: 'create_milestone'; title: string; dueDate: string; subproject?: string | null }
  | { type: 'create_event'; title: string; startsAt: string; endsAt?: string | null; location?: string | null; text?: string | null }
  | { type: 'none'; reason?: string };

export interface AgentWait { kind: 'reply' | 'date' | 'task' | 'info'; reason: string; since: string; remindAt?: string | null; escalateAt?: string | null; reminded?: boolean; escalated?: boolean }
const H = 3600_000;
const DOC_TRANSITIONS: Record<string, string[]> = { draft: ['review', 'final'], review: ['draft', 'final'], final: ['draft'] };
const clampH = (v: unknown, def: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(24 * 14, Math.max(0.1, n)) : def; };
/** Termin aus until: ISO-Datum/-Zeit, YYYY-MM-DD oder HH:MM (heute, sonst morgen); Zeiten ohne Zone gelten als Europe/Berlin. */
export function parseUntil(v: unknown, now: Date): Date | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const berlinOffsetMin = (d: Date) => { const z = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', timeZoneName: 'shortOffset' }).formatToParts(d).find((x) => x.type === 'timeZoneName')?.value ?? 'GMT+1'; const m = z.match(/GMT([+-])(\d+)(?::(\d+))?/); return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 60; };
  const hm = s.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const local = new Date(now.getTime() + berlinOffsetMin(now) * 60_000);
    const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), Number(hm[1]), Number(hm[2])) - berlinOffsetMin(now) * 60_000);
    return d.getTime() <= now.getTime() ? new Date(d.getTime() + 86400_000) : d;
  }
  // Ortszeit ohne Zone: Versatz zum Zieldatum (Sommer-/Winterzeit), nicht zum aktuellen Zeitpunkt
  const local = (d: Date) => new Date(d.getTime() - berlinOffsetMin(new Date(d.getTime() - berlinOffsetMin(d) * 60_000)) * 60_000);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return local(new Date(s + 'T09:00:00Z'));
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !/[Zz]|[+-]\d{2}:?\d{2}$/.test(s)) { const d = new Date(s.slice(0, 16) + ':00Z'); return isNaN(d.getTime()) ? null : local(d); }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['note', 'actions'],
  properties: {
    note: { type: 'string', description: 'Kurze Notiz für das Protokoll: was mit den Aktionen unten veranlasst wird und warum. Nur Aktionen in der Liste werden ausgeführt.' },
    actions: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['type', 'text', 'column', 'itemId', 'to', 'subject', 'reason', 'kind', 'checkAfterHours', 'until', 'remindAfterHours', 'escalateAfterHours', 'pageId', 'title', 'folder', 'status', 'ref', 'responsible', 'startDate', 'dueDate', 'subproject', 'items', 'startsAt', 'endsAt', 'location'],
      properties: {
        type: { type: 'string', enum: ['comment', 'set_status', 'check_item', 'add_item', 'update_item', 'mail', 'reply_origin', 'chat', 'read_page', 'doc_create', 'doc_update', 'doc_append', 'doc_status', 'doc_move', 'folder_create', 'doc_send_pdf', 'create_aufgabe', 'create_ap', 'assign', 'set_dates', 'create_subproject', 'create_milestone', 'create_event', 'blocked', 'escalate', 'wait', 'none'] },
        text: { type: 'string', description: 'comment: Log-Text; mail/doc_send_pdf: Mailtext; reply_origin: Antworttext an den Absender der Ursprungsmail; chat: Chat-Nachricht; escalate: Text an die PL; add_item/update_item: Task-Text; doc_create/doc_update/doc_append: Seiteninhalt in Markdown (doc_update ersetzt den ganzen Inhalt); create_aufgabe/create_ap/create_event: Beschreibung; sonst leer' },
        column: { type: 'string', description: 'set_status: Zielstatus (exakt aus der Liste); sonst leer' },
        itemId: { type: 'string', description: 'check_item/update_item: itemId aus der Task-Liste; sonst leer' },
        pageId: { type: 'string', description: 'read_page/doc_update/doc_append/doc_status/doc_move/doc_send_pdf: pageId aus der Seitenliste; sonst leer' },
        status: { type: 'string', description: 'doc_status: draft, review oder final; sonst leer' },
        title: { type: 'string', description: 'doc_create: Seitentitel; doc_update: neuer Titel (optional); create_aufgabe/create_ap/create_subproject/create_milestone/create_event: Titel; sonst leer' },
        ref: { type: 'string', description: 'assign/set_dates: Kennung (z. B. WEB-12), bei set_dates leer = dieses; create_aufgabe: Kennung des Arbeitspakets, leer = dieses; sonst leer' },
        responsible: { type: 'string', description: 'create_aufgabe/create_ap/create_subproject/assign: E-Mail eines Projektmitglieds (oder externe Adresse), leer = keine direkte Zuweisung; sonst leer' },
        startDate: { type: 'string', description: 'create_aufgabe/create_ap/create_subproject/set_dates: Start als YYYY-MM-DD; sonst leer' },
        dueDate: { type: 'string', description: 'create_aufgabe/create_ap/set_dates: Termin als YYYY-MM-DD; create_subproject: Ende; create_milestone: Datum; sonst leer' },
        subproject: { type: 'string', description: 'create_ap/create_milestone: Name des Teilprojekts, leer = dieses bzw. keins; sonst leer' },
        items: { type: 'array', items: { type: 'string' }, description: 'create_aufgabe/create_ap: Tasks (Checkliste); sonst leer' },
        startsAt: { type: 'string', description: 'create_event: Beginn als YYYY-MM-DDTHH:MM (Europe/Berlin); sonst leer' },
        endsAt: { type: 'string', description: 'create_event: Ende als YYYY-MM-DDTHH:MM, leer = eine Stunde; sonst leer' },
        location: { type: 'string', description: 'create_event: Ort; sonst leer' },
        folder: { type: 'string', description: 'doc_create/doc_move: Ordnername aus der Ordnerliste; folder_create: Name des neuen Ordners; sonst leer' },
        to: { type: 'array', items: { type: 'string' }, description: 'mail: Empfängeradressen; chat: E-Mail von Projektmitgliedern, leer = PL, „projekt“ = Projektkanal; doc_send_pdf (nur finale Seiten): Projektmitglieder, Adressen aus dem Verteiler oder mit Freigabe der Seite, leer = Verteiler des Ordners; sonst leer' },
        subject: { type: 'string', description: 'mail: Betreff; sonst leer' },
        reason: { type: 'string', description: 'wait: worauf genau gewartet wird (Pflicht); blocked: Grund; none: Grund; sonst leer' },
        kind: { type: 'string', description: 'wait: genau einer der Werte reply, date, task, info; sonst leer' },
        checkAfterHours: { type: 'number', description: 'wait: Stunden bis zur nächsten Prüfung; sonst leer' },
        until: { type: 'string', description: 'wait mit kind date: Zeitpunkt als YYYY-MM-DDTHH:MM (Europe/Berlin), YYYY-MM-DD oder HH:MM (heute, sonst morgen); sonst leer' },
        remindAfterHours: { type: 'number', description: 'wait mit kind reply: Stunden bis zum Nachfassen; sonst leer' },
        escalateAfterHours: { type: 'number', description: 'wait mit kind reply: Stunden bis zur Eskalation an die PL; sonst leer' }
      } } }
  }
};

/** Schreibstil aus der Persona (Verwaltung › KI-Agenten); ohne Persona sachlich, kurz, auf Deutsch. Die Regeln oben gehen dem Stil vor. */
export function styleText(persona: string | null | undefined): string {
  const p = (persona ?? '').trim();
  return p ? `Dein Schreibstil für Log, Mails, Doku und Chat: ${p}. Der Stil ändert nichts an den Regeln oben (keine erfundenen Fakten, nur Aktionen aus der Liste).` : 'Du schreibst sachlich, kurz und auf Deutsch.';
}

const cut = (s: string | null | undefined, n: number) => { const t = (s ?? '').trim(); return t.length > n ? t.slice(0, n) + ' …' : t; };

export interface AgentRunResult { runId: string | null; taskId: string; status: 'ok' | 'error' | 'skipped'; actions: AgentAction[]; error?: string }

/** Ein Lauf für ein Arbeitspaket. trigger beschreibt den Anlass (assigned, mail, comment, due, daily, manual). */
export async function runAgentOnTask(db: Db, mail: MailService, fetchFn: typeof fetch, agent: { id: string; name: string; org_id: string; persona?: string | null }, taskId: string, trigger: string, cfg?: AiConfig | null, now = new Date()): Promise<AgentRunResult> {
  const task = await db.maybeOne(`select t.*, c.name as column_name, p.key as project_key, p.name as project_name, s.name as subproject_name, pt.title as parent_title, pt.number as parent_number from tasks t join board_columns c on c.id = t.column_id join projects p on p.id = t.project_id left join subprojects s on s.id = t.subproject_id left join tasks pt on pt.id = t.parent_id where t.id = $1 and t.deleted_at is null`, [taskId]);
  if (!task) return { runId: null, taskId, status: 'skipped', actions: [], error: 'Arbeitspaket nicht gefunden' };
  const m = await db.maybeOne(`select * from project_members where project_id = $1 and user_id = $2`, [task.project_id, agent.id]);
  if (!m) return { runId: null, taskId, status: 'skipped', actions: [], error: 'Agent ist kein Mitglied' };
  const c = cfg ?? (await aiConfigForAgent(db, agent.id));
  if (!c) return { runId: null, taskId, status: 'skipped', actions: [], error: 'Dem Agenten ist kein aktives KI-Profil zugewiesen (Verwaltung › KI-Agenten)' };
  const columns = await db.query(`select name, is_done from board_columns where project_id = $1 order by position`, [task.project_id]);
  const items = await db.query(`select id, title, done, responsible_email from checklist_items where task_id = $1 order by position`, [task.id]);
  const subtasks = await db.query(`select t.number, t.title, c.name as column_name, c.is_done, u.name as responsible_name from tasks t join board_columns c on c.id = t.column_id left join users u on u.id = t.responsible_user_id where t.parent_id = $1 and t.deleted_at is null and t.archived_at is null order by t.position, t.created_at`, [task.id]);
  const comments = await db.query(`select c.body, c.source, c.created_at, u.name from task_comments c left join users u on u.id = c.user_id where c.task_id = $1 order by c.created_at desc limit 12`, [task.id]);
  const mails = await db.query(`select m.subject, m.from_addr, m.date, m.snippet, m.text_body, m.outgoing, l.origin, l.copied, a.type as account_type, a.owner_user_id,
      exists (select 1 from mails x where x.account_id = m.account_id and x.outgoing and m.message_id is not null and x.in_reply_to = m.message_id) as answered
    from mail_task_links l join mails m on m.id = l.mail_id join mail_accounts a on a.id = m.account_id where l.task_id = $1 order by l.origin desc, m.date desc limit 6`, [task.id]);
  const members = await db.query(`select m.user_id, u.name, u.email, m.role, m.is_deputy, u.kind from project_members m join users u on u.id = m.user_id where m.project_id = $1`, [task.project_id]);
  const folders = await db.query(`select id, name from doc_folders where project_id = $1 order by position`, [task.project_id]);
  const pages = await db.query(`select p.id, p.title, p.status, p.updated_at, f.name as folder from doc_pages p left join doc_folders f on f.id = p.folder_id where p.project_id = $1 and p.deleted_at is null order by p.updated_at desc limit 40`, [task.project_id]);
  const pls = members.rows.filter((x: any) => x.role === 'pl' && !x.is_deputy);
  // Inhalt aus persönlichen Konten nur, wenn ihn alle Menschen im Projekt ohnehin lesen dürften (Kopie) oder nur der Eigentümer Mitglied ist (persönliches Projekt)
  const humans = members.rows.filter((x: any) => x.kind !== 'agent').map((x: any) => x.user_id);
  const bodyOk = (x: any) => x.account_type !== 'personal' || x.copied || humans.every((h: string) => h === x.owner_user_id);
  const today = now.toISOString().slice(0, 10);
  const account = await db.maybeOne<AccountRow>(`select * from mail_accounts where project_id = $1 and type = 'project' order by created_at limit 1`, [task.project_id]);
  const canMail = Boolean(m.agent_can_mail) && Boolean(account);
  // Ohne Projektkonto (z. B. persönliches Projekt): Konto einer Ansicht des Projekts, Mails dann nur als Entwurf (persönliches Konto: der Eigentümer sendet)
  const viewAccount = account ? null : await db.maybeOne<AccountRow & { view_id: string }>(`select a.*, v.id as view_id from mail_views v join mail_accounts a on a.id = v.account_id where v.project_id = $1 order by (a.type = 'personal') desc, v.created_at limit 1`, [task.project_id]);
  const signature = String((await db.one(`select signature from users where id = $1`, [agent.id])).signature ?? '').trim();
  // Zuständigkeit (direkt oder geerbt) und Planungsrahmen: stellvertretende PL oder „Projektplan ändern“ plant im ganzen Projekt, Teilprojekt-Verantwortung in ihren Teilprojekten
  const eff = await db.one(`select (${EFFECTIVE_RESPONSIBLE_SQL}) as eff, pt.responsible_user_id as parent_resp, s.name as sp_name from tasks t ${EFFECTIVE_JOINS} where t.id = $1`, [task.id]);
  const basis = task.responsible_user_id === agent.id ? 'direkt zugewiesen' : eff.eff === agent.id ? (eff.parent_resp === agent.id ? `geerbt vom Arbeitspaket ${task.project_key}-${task.parent_number}` : `geerbt vom Teilprojekt „${eff.sp_name}“, für das du verantwortlich bist`) : 'nicht deine Zuständigkeit (Lauf von Hand gestartet)';
  const isPl = m.role === 'pl';
  const canPlan = isPl || Boolean(m.can_edit_plan);
  const myTps: string[] = (await db.query(`select id from subprojects where project_id = $1 and responsible_user_id = $2`, [task.project_id, agent.id])).rows.map((r: any) => r.id);
  const subprojects = await db.query(`select s.id, s.name, s.start_date, s.end_date, u.name as resp from subprojects s left join users u on u.id = s.responsible_user_id where s.project_id = $1 and (not s.restricted or s.responsible_user_id = $2 or $3) order by s.position, s.created_at`, [task.project_id, agent.id, isPl]);
  const apScope = canPlan ? null : task.subproject_id;
  const aps = await db.query(
    `select t.number, t.title, t.start_date, t.due_date, c.name as column_name, c.is_done, t.responsible_user_id, t.responsible_email, eu.name as eff_name, s.name as sp_name,
       (select count(*)::int from tasks x where x.parent_id = t.id and x.deleted_at is null) as subs
     from tasks t join board_columns c on c.id = t.column_id ${EFFECTIVE_JOINS} left join users eu on eu.id = (${EFFECTIVE_RESPONSIBLE_SQL})
     where t.project_id = $1 and t.parent_id is null and t.deleted_at is null and t.archived_at is null and ($2::uuid is null or t.subproject_id = $2) and ${visibleSubprojectSql(3)}
     order by (t.subproject_id is not distinct from $4) desc, s.position nulls last, t.position limit 40`, [task.project_id, apScope, agent.id, task.subproject_id]);
  const milestones = canPlan || myTps.length ? await db.query(`select m.name, m.date, s.name as sp from milestones m left join subprojects s on s.id = m.subproject_id where m.project_id = $1 order by m.date limit 20`, [task.project_id]) : { rows: [] as any[] };
  const events = await db.query(`select title, starts_at, location, tentative from meetings where project_id = $1 and starts_at >= $2 and starts_at < $3 order by starts_at limit 15`, [task.project_id, new Date(now.getTime() - 86400_000), new Date(now.getTime() + 45 * 86400_000)]);
  // Ansprechpartner für Rückfragen und Zusagen: Zuständige des übergeordneten Elements (AP bzw. Teilprojekt), sonst die verantwortliche PL; immer eine Person
  const parentResp = task.parent_id ? (await db.maybeOne(`select (${EFFECTIVE_RESPONSIBLE_SQL}) as uid from tasks t ${EFFECTIVE_JOINS} where t.id = $1`, [task.parent_id]))?.uid : null;
  const spResp = task.subproject_id ? (await db.maybeOne(`select responsible_user_id as uid from subprojects where id = $1`, [task.subproject_id]))?.uid : null;
  const plId = (await db.maybeOne(`select user_id from project_members where project_id = $1 and role = 'pl' and not is_deputy`, [task.project_id]))?.user_id;
  let contact: any = null;
  for (const [uid, why] of [[parentResp, `zuständig für ${task.project_key}-${task.parent_number}`], [spResp, `verantwortlich für Teilprojekt „${task.subproject_name}“`], [plId, 'Projektleitung']] as [string | null, string][]) {
    if (!uid || uid === agent.id) continue;
    const u = await db.maybeOne(`select id, name, email from users where id = $1 and kind <> 'agent' and active`, [uid]);
    if (u) { contact = { ...u, why }; break; }
  }
  // Belegt-Zeiten des Ansprechpartners aus anderen Projekten (Termine, an denen er teilnimmt oder die er angelegt hat; ohne Titel), damit Terminvorschläge geprüft werden können
  const busy = contact ? await db.query(`select m.starts_at, m.ends_at from meetings m where m.project_id <> $2 and (m.created_by = $1 or m.attendees @> jsonb_build_array(jsonb_build_object('userId', $1::text))) and m.starts_at >= now() and m.starts_at < now() + interval '45 days' order by m.starts_at limit 20`, [contact.id, task.project_id]) : { rows: [] as any[] };
  // Direktnachrichten mit Menschen dieses Projekts (letzte 7 Tage): Antworten auf Fragen, die der Agent per Chat gestellt hat
  const dms = await db.query(
    `select m.body, m.created_at, u.name, m.user_id = $1 as mine from chat_messages m join chat_channels c on c.id = m.channel_id and c.kind = 'dm'
       join chat_channel_members me on me.channel_id = c.id and me.user_id = $1 join users u on u.id = m.user_id
     where m.deleted_at is null and m.created_at > now() - interval '7 days'
       and exists (select 1 from chat_channel_members o join project_members pm on pm.user_id = o.user_id and pm.project_id = $2 where o.channel_id = c.id and o.user_id <> $1)
     order by m.created_at desc limit 10`, [agent.id, task.project_id]);
  const d10 = (v: any) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : '');
  const span = (a: any, b: any) => (a || b ? ` · ${d10(a) || '?'} – ${d10(b) || '?'}` : '');
  // Fester Teil zuerst (KI-Sheet und Regeln, für alle Läufe gleich: Prefix-Cache), danach Name, Projekt und Schreibstil
  const system = `${AGENT_SHEET}\n\n${TASK_RULES}\n\n# Du\nDu bist „${agent.name}“, KI-Agent und ${isPl ? 'stellvertretende Projektleitung' : 'Mitglied'} im Projekt ${task.project_key} „${task.project_name}“. Für ${task.parent_id ? 'diese Aufgabe' : 'dieses Arbeitspaket'} bist du zuständig; du treibst es voran wie eine zuständige Person. ${signature ? `Mails nach außen haben eine Anrede und enden genau mit dieser Unterschrift:\n${signature}\n` : `Mails nach außen haben Anrede und Unterschrift „${agent.name} (KI-Agent, Projekt ${task.project_key})“. `}${styleText(agent.persona)}`;
  const prompt = `Heute: ${today}
${task.parent_id ? `Aufgabe ${task.project_key}-${task.number} „${task.title}“ im Arbeitspaket ${task.project_key}-${task.parent_number} „${task.parent_title}“` : `Arbeitspaket ${task.project_key}-${task.number} „${task.title}“`} · Status ${task.column_name}${task.due_date ? ` · fällig ${String(task.due_date).slice(0, 10)}` : ''}${task.subproject_name ? ` · Teilprojekt ${task.subproject_name}` : ''}${task.blocked ? ` · BLOCKIERT: ${task.blocked_reason ?? ''}` : ''}
Beschreibung: ${cut(task.description, 2000) || '–'}
Mögliche Status: ${columns.rows.map((x: any) => x.name + (x.is_done ? ' (erledigt)' : '')).join(', ')}
${subtasks.rows.length ? `Aufgaben (eigene Zuständigkeit und eigenes Log):\n${subtasks.rows.map((x: any) => `- ${task.project_key}-${x.number} „${x.title}“ · ${x.column_name}${x.is_done ? ' (erledigt)' : ''}${x.responsible_name ? ` · ${x.responsible_name}` : ''}`).join('\n')}\n` : ''}Tasks:
${items.rows.map((i: any) => `- [${i.done ? 'x' : ' '}] ${i.title} (itemId ${i.id})${i.responsible_email ? ` · extern ${i.responsible_email}` : ''}`).join('\n') || '–'}
Log (neueste zuerst):
${comments.rows.map((x: any) => `- ${new Date(x.created_at).toLocaleDateString('de-DE')} ${x.name ?? 'System'}${x.source === 'ai' ? ' (KI)' : ''}: ${cut(x.body, 400)}`).join('\n') || '–'}
${dms.rows.length ? `Chat (deine Direktnachrichten mit Projektmitgliedern, neueste zuerst):\n${dms.rows.map((x: any) => `- ${new Date(x.created_at).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' })} ${x.mine ? 'Du' : x.name}: ${cut(x.body, 400)}`).join('\n')}\n` : ''}Mails zum Arbeitspaket:
${mails.rows.map((x: any) => `- ${new Date(x.date).toLocaleDateString('de-DE')} ${x.outgoing ? 'AN' : 'VON'} ${x.from_addr}: ${x.subject}${x.origin && !x.outgoing ? ` [Ursprungsmail, ${x.answered ? 'beantwortet' : 'noch nicht beantwortet'}]` : ''} – ${bodyOk(x) ? cut(x.text_body ?? x.snippet, x.origin ? 1500 : 500) : '(Inhalt aus einem persönlichen Konto, nicht freigegeben)'}`).join('\n') || '–'}
Doku-Ordner: ${folders.rows.map((f: any) => f.name).join(', ') || '–'}
Doku-Seiten (neueste zuerst):
${pages.rows.map((p: any) => `- „${p.title}“ (pageId ${p.id}, ${p.folder ?? 'ohne Ordner'}, ${p.status}, ${new Date(p.updated_at).toLocaleDateString('de-DE')})`).join('\n') || '–'}
Projektmitglieder: ${members.rows.map((x: any) => `${x.name} <${x.email}>${x.role === 'pl' ? (x.is_deputy ? ' (PL-Stellvertretung)' : ' (PL)') : ''}${x.kind === 'agent' ? ' (Agent)' : ''}`).join(', ')}
Deine Zuständigkeit: ${basis}.
Teilprojekte: ${subprojects.rows.map((x: any) => `„${x.name}“ (verantwortlich ${x.resp ?? 'PL'}${span(x.start_date, x.end_date)})`).join(', ') || '–'}
Arbeitspakete${apScope ? ` im Teilprojekt „${task.subproject_name}“` : ' im Projekt'}:
${aps.rows.map((x: any) => `- ${task.project_key}-${x.number} „${x.title}“ · ${x.column_name}${x.is_done ? ' (erledigt)' : ''}${!apScope && x.sp_name ? ` · ${x.sp_name}` : ''} · ${x.responsible_user_id || x.responsible_email ? (x.eff_name ?? x.responsible_email) : `${x.eff_name ?? 'PL'} (geerbt)`}${span(x.start_date, x.due_date)}${x.subs ? ` · ${x.subs} Aufgaben` : ''}`).join('\n') || '–'}
${milestones.rows.length ? `Meilensteine: ${milestones.rows.map((x: any) => `${x.name} ${d10(x.date)}${x.sp ? ` (${x.sp})` : ''}`).join(', ')}\n` : ''}Termine im Projektkalender: ${events.rows.map((x: any) => `${x.title} ${fmtWhen(new Date(x.starts_at))}${x.location ? ` (${x.location})` : ''}${x.tentative ? ' [vorläufig, unbestätigt]' : ''}`).join(', ') || '–'}
Ansprechpartner für Rückfragen und Terminzusagen: ${contact ? `${contact.name} <${contact.email}> (${contact.why})` : 'keiner'}${busy.rows.length ? `\nBelegt (weitere Termine von ${contact.name}, ohne Details): ${busy.rows.map((x: any) => `${fmtWhen(new Date(x.starts_at))}–${new Date(x.ends_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' })}`).join(', ')}` : ''}
Deine Rechte: Mails ${canMail ? 'direkt senden (bis zu drei je Lauf, auch mit PDF einer Doku-Seite)' : 'nur als Entwurf zur Freigabe'}${account ? '' : viewAccount ? ` (kein Projektkonto; Entwürfe gehen über ${viewAccount.address}${viewAccount.type === 'personal' ? ', der Kontoinhaber gibt frei' : ''})` : ' (kein Mailkonto)'}; Antwort auf die Ursprungsmail (reply_origin) aus deren Konto; Chat an Projektmitglieder (chat); Status setzen; Tasks abhaken, ergänzen, umformulieren; Doku wie ein Mitglied: Seiten lesen (read_page), anlegen (doc_create), Inhalt ersetzen (doc_update), ergänzen (doc_append), Status setzen (doc_status: draft, review${m.can_finalize ? ', final' : '; final nur mit Recht „Final setzen“, das du nicht hast'}), verschieben (doc_move), Ordner anlegen (folder_create); PDF einer finalen Seite per Mail senden (doc_send_pdf: ${m.can_finalize ? 'an Projektmitglieder, Adressen aus dem Verteiler oder mit Freigabe der Seite; leer = Verteiler des Ordners' : 'an Projektmitglieder oder Adressen mit Freigabe der Seite; Verteiler nur mit Recht „Final setzen“, das du nicht hast'}); Log schreiben; Blockade melden; an PL eskalieren.
Planen: Aufgaben anlegen (create_aufgabe) ${canPlan ? 'unter jedem Arbeitspaket' : myTps.length ? 'unter Arbeitspaketen deiner Teilprojekte und deinen eigenen' : task.parent_id ? 'unter dem Arbeitspaket dieser Aufgabe' : 'unter diesem Arbeitspaket'}; Arbeitspakete anlegen (create_ap) ${canPlan ? 'in allen Teilprojekten' : myTps.length ? 'in deinen Teilprojekten' : 'nicht'}; Teilprojekte und Meilensteine ${canPlan ? 'ja' : 'nicht'}; zuweisen (assign) an Mitglieder${isPl ? ' und Agenten' : ' (Agenten weist nur die PL zu)'}; Start/Termin setzen (set_dates) ${canPlan ? 'überall' : 'bei Arbeit, die du angelegt hast oder die noch keinen Termin hat'}; Termine im Projektkalender (create_event). Projekte, Mitglieder, Rechte und Einstellungen nicht.
${waitText(task, now)}Anlass dieses Laufs: ${triggerText(trigger, task)}

Entscheide, was jetzt sinnvoll ist. Keine Wiederholung bereits erledigter oder bereits gefragter Dinge (siehe Log und Mails). Bis zu drei Mails je Lauf; was heute erledigt werden kann, erledige in diesem Lauf statt es zu vertagen.`;
  try {
    const errors: string[] = [];
    let extra = '';
    let inputTokens = 0; let outputTokens = 0; let model = '';
    let j: any = {};
    let actions: AgentAction[] = [];
    // Leserunden: read_page liefert Seiteninhalte, danach entscheidet das Modell erneut (max. zwei Leserunden)
    for (let round = 0; round < 3; round++) {
      // Denkmodus ausdrücklich an: Denk-Token zählen bei lokalen Servern zu max_tokens, deshalb mehr Spielraum
      const r = await complete(c, fetchFn, { system, prompt: prompt + extra, maxTokens: c.enableThinking === true ? 6500 : 2500, schema: SCHEMA });
      inputTokens += r.inputTokens; outputTokens += r.outputTokens; model = r.model;
      j = parseJson(r.text);
      actions = Array.isArray(j.actions) ? j.actions.slice(0, 25) : [];
      const reads = actions.filter((a) => a.type === 'read_page');
      if (!reads.length) break;
      if (round === 2) { errors.push('Lesen abgebrochen: mehr als zwei Leserunden'); actions = actions.filter((a) => a.type !== 'read_page'); break; }
      const texts: string[] = [];
      for (const a of reads.slice(0, 4)) {
        const pid = (a as any).pageId;
        const page = await db.maybeOne(`select id, title, status, version, content_md, content_html from doc_pages where id = $1 and project_id = $2 and deleted_at is null`, [pid, task.project_id]);
        if (!page) { texts.push(`- pageId ${pid ?? '?'}: nicht gefunden`); continue; }
        const md = page.content_html ? htmlToMd(page.content_html) : page.content_md ?? '';
        texts.push(`### „${page.title}“ (pageId ${page.id}, ${page.status}, Version ${page.version})\n${cut(md, 6000) || '(leer)'}`);
      }
      const others = actions.filter((a) => a.type !== 'read_page');
      extra += `\n\nGelesene Seiten (Markdown):\n${texts.join('\n\n')}\n${others.length ? 'Deine übrigen Aktionen der vorigen Antwort wurden NICHT ausgeführt, weil du erst gelesen hast. Gib jetzt alle Aktionen erneut an, die ausgeführt werden sollen.' : 'Gib jetzt deine Aktionen an.'} Kein erneutes read_page für bereits gelesene Seiten.`;
      actions = [];
    }
    const applied: AgentAction[] = [];
    let mailsSent = 0;
    let chats = 0;
    let waited = false;
    const plan = planner(db, { agent, m, task, canPlan, myTps, now });
    /** Tatsächlicher Versandstatus ins Log (der Agent selbst behauptet keinen Versand). */
    const logSys = (body: string) => db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [task.id, agent.id, body]);
    /** Entwurf wartet: persönliches Konto → Eigentümer, sonst die PL. */
    const notifyDraft = async (acc: AccountRow, subject: string) => {
      const targets = acc.type === 'personal' && acc.owner_user_id ? [acc.owner_user_id] : pls.map((p: any) => p.user_id);
      for (const u of targets) await notify(db, { userId: u, projectId: task.project_id, type: 'draft.review', title: `Mail-Entwurf von ${agent.name} zur Freigabe`, body: subject, link: `/projekte/${task.project_id}/mail/freigaben` });
    };
    for (const a of actions) {
      if (a.type === 'comment' && a.text?.trim()) {
        await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [task.id, agent.id, a.text.trim()]);
        applied.push(a);
      } else if (a.type === 'comment') errors.push('Log-Eintrag ohne Text verworfen');
      else if (a.type === 'set_status' && a.column) {
        const col = await db.maybeOne(`select id, name from board_columns where project_id = $1 and lower(name) = lower($2)`, [task.project_id, a.column]);
        if (!col) errors.push(`Status „${a.column}“ gibt es nicht`);
        if (col && col.id !== task.column_id) { await db.query(`update tasks set column_id = $2 where id = $1`, [task.id, col.id]); await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [task.id, agent.id, `Status → ${col.name}`]); applied.push({ type: 'set_status', column: col.name }); }
      } else if (a.type === 'check_item') {
        const it = items.rows.find((i: any) => i.id === a.itemId && !i.done);
        if (!it) errors.push(`Task-Abhaken verworfen: itemId ${a.itemId ?? 'fehlt'} unbekannt oder schon erledigt`);
        if (it) { await db.query(`update checklist_items set done = true where id = $1`, [it.id]); await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [task.id, agent.id, `Task erledigt: ${it.title}`]); applied.push(a); }
      } else if (a.type === 'add_item') {
        if (!a.text?.trim()) errors.push('Task ohne Text verworfen');
        else { const pos = await db.one(`select coalesce(max(position), 0) + 1 as p from checklist_items where task_id = $1`, [task.id]); await db.query(`insert into checklist_items (task_id, title, position) values ($1,$2,$3)`, [task.id, a.text.trim().slice(0, 300), pos.p]); applied.push(a); }
      } else if (a.type === 'update_item') {
        const it = items.rows.find((i: any) => i.id === a.itemId);
        if (!it || !a.text?.trim()) errors.push(`Task-Änderung verworfen: ${!it ? 'itemId unbekannt' : 'kein Text'}`);
        else { await db.query(`update checklist_items set title = $2 where id = $1`, [it.id, a.text.trim().slice(0, 300)]); await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [task.id, agent.id, `Task umformuliert: „${it.title}“ → „${a.text.trim().slice(0, 300)}“`]); applied.push(a); }
      } else if (a.type === 'doc_create') {
        if (!a.title?.trim() || !a.text?.trim()) errors.push('Seite verworfen: Titel oder Inhalt fehlt');
        else {
          const folder = a.folder ? await db.maybeOne(`select id from doc_folders where project_id = $1 and lower(name) = lower($2)`, [task.project_id, a.folder]) : null;
          const fid = folder?.id ?? (await db.maybeOne(`select id from doc_folders where project_id = $1 and name = 'Protokolle'`, [task.project_id]))?.id ?? null;
          const html = mdToHtml(a.text);
          const page = await db.one(`insert into doc_pages (project_id, folder_id, title, content_md, content_html, status, created_by, updated_by) values ($1,$2,$3,$4,$5,'draft',$6,$6) returning *`, [task.project_id, fid, a.title.trim().slice(0, 200), htmlToMd(html), html, agent.id]);
          await db.query(`insert into doc_page_versions (page_id, version, title, content_md, content_html, status, saved_by) values ($1,1,$2,$3,$4,'draft',$5)`, [page.id, page.title, page.content_md, page.content_html, agent.id]);
          await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [task.id, agent.id, `Doku-Seite angelegt: „${page.title}“ ${publicBase()}/projekte/${task.project_id}/doku/${page.id}`]);
          pages.rows.unshift({ id: page.id, title: page.title, status: 'draft', updated_at: new Date(), folder: a.folder ?? null });
          applied.push({ ...a, pageId: page.id } as any);
        }
      } else if (a.type === 'read_page') errors.push('read_page ohne weitere Aktionen verworfen');
      else if (a.type === 'doc_update') {
        const page = await db.maybeOne(`select * from doc_pages where id = $1 and project_id = $2 and deleted_at is null`, [a.pageId, task.project_id]);
        if (!page || !a.text?.trim()) errors.push(`Seitenänderung verworfen: ${!page ? 'pageId unbekannt' : 'kein Text'}`);
        else if (page.status === 'final') errors.push(`Seite „${page.title}“ ist final und gesperrt (erst doc_status draft)`);
        else {
          const html = mdToHtml(a.text);
          const title = a.title?.trim() ? a.title.trim().slice(0, 200) : page.title;
          const u = await db.one(`update doc_pages set title = $2, content_html = $3, content_md = $4, version = version + 1, updated_by = $5, updated_at = now() where id = $1 returning *`, [page.id, title, html, htmlToMd(html), agent.id]);
          await db.query(`insert into doc_page_versions (page_id, version, title, content_md, content_html, status, saved_by) values ($1,$2,$3,$4,$5,$6,$7)`, [u.id, u.version, u.title, u.content_md, u.content_html, u.status, agent.id]);
          await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [task.id, agent.id, `Doku-Seite überarbeitet: „${u.title}“ (Version ${u.version}) ${publicBase()}/projekte/${task.project_id}/doku/${u.id}`]);
          applied.push(a);
        }
      } else if (a.type === 'doc_status') {
        const page = await db.maybeOne(`select * from doc_pages where id = $1 and project_id = $2 and deleted_at is null`, [a.pageId, task.project_id]);
        const to = String(a.status ?? '');
        if (!page) errors.push('Statuswechsel verworfen: pageId unbekannt');
        else if (!DOC_TRANSITIONS[page.status]?.includes(to)) errors.push(`Übergang ${page.status} → ${to || '?'} bei „${page.title}“ nicht erlaubt`);
        else if ((to === 'final' || page.status === 'final') && !m.can_finalize) errors.push(`„${page.title}“: Final setzen oder aufheben erfordert das Recht „Final setzen“`);
        else {
          const u = await db.one(`update doc_pages set status = $2, finalized_at = case when $2 = 'final' then now() else null end, updated_by = $3, updated_at = now() where id = $1 returning *`, [page.id, to, agent.id]);
          await db.query(`update doc_page_versions set status = $3 where page_id = $1 and version = $2`, [u.id, u.version, to]);
          await audit(db, { orgId: agent.org_id, projectId: task.project_id, userId: agent.id, action: `page.${to}`, objectType: 'doc_page', objectId: u.id, details: { from: page.status, version: u.version } });
          if (to === 'review') await notifyMany(db, await usersWithRight(db, task.project_id, 'can_finalize'), { projectId: task.project_id, type: 'page.review', title: `Zur Prüfung: ${u.title}`, body: `von ${agent.name} (KI-Agent)`, link: `/projekte/${task.project_id}/doku/${u.id}` }, agent.id);
          await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [task.id, agent.id, `Doku-Seite „${u.title}“ → ${{ draft: 'Entwurf', review: 'In Prüfung', final: 'Final' }[to]}`]);
          applied.push(a);
        }
      } else if (a.type === 'doc_move') {
        const page = await db.maybeOne(`select * from doc_pages where id = $1 and project_id = $2 and deleted_at is null`, [a.pageId, task.project_id]);
        const folder = a.folder ? await db.maybeOne(`select id, name from doc_folders where project_id = $1 and lower(name) = lower($2)`, [task.project_id, a.folder]) : null;
        if (!page || !folder) errors.push(`Verschieben verworfen: ${!page ? 'pageId unbekannt' : `Ordner „${a.folder ?? ''}“ gibt es nicht`}`);
        else {
          await db.query(`update doc_pages set folder_id = $2, updated_by = $3, updated_at = now() where id = $1`, [page.id, folder.id, agent.id]);
          await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [task.id, agent.id, `Doku-Seite „${page.title}“ nach „${folder.name}“ verschoben`]);
          applied.push({ ...a, folder: folder.name });
        }
      } else if (a.type === 'folder_create') {
        const name = String(a.folder ?? '').trim().slice(0, 100);
        if (!name) errors.push('Ordner ohne Namen verworfen');
        else if (await db.maybeOne(`select 1 from doc_folders where project_id = $1 and lower(name) = lower($2)`, [task.project_id, name])) errors.push(`Ordner „${name}“ gibt es schon`);
        else {
          const pos = await db.one(`select coalesce(max(position), 0) + 1 as p from doc_folders where project_id = $1`, [task.project_id]);
          const f = await db.one(`insert into doc_folders (project_id, parent_id, name, position, distribution_list) values ($1,null,$2,$3,'[]') returning *`, [task.project_id, name, pos.p]);
          folders.rows.push({ id: f.id, name: f.name });
          await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [task.id, agent.id, `Doku-Ordner „${f.name}“ angelegt`]);
          applied.push({ type: 'folder_create', folder: f.name });
        }
      } else if (a.type === 'doc_append') {
        const page = await db.maybeOne(`select * from doc_pages where id = $1 and project_id = $2 and deleted_at is null`, [a.pageId, task.project_id]);
        if (!page || !a.text?.trim()) errors.push(`Seitenergänzung verworfen: ${!page ? 'pageId unbekannt' : 'kein Text'}`);
        else if (page.status === 'final') errors.push(`Seite „${page.title}“ ist final und gesperrt`);
        else {
          const html = `${(page.content_html ?? mdToHtml(page.content_md)).replace(/\s+$/, '')}\n${mdToHtml(a.text)}`;
          const u = await db.one(`update doc_pages set content_html = $2, content_md = $3, version = version + 1, updated_by = $4, updated_at = now() where id = $1 returning *`, [page.id, html, htmlToMd(html), agent.id]);
          await db.query(`insert into doc_page_versions (page_id, version, title, content_md, content_html, status, saved_by) values ($1,$2,$3,$4,$5,$6,$7)`, [u.id, u.version, u.title, u.content_md, u.content_html, u.status, agent.id]);
          await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [task.id, agent.id, `Doku-Seite ergänzt: „${page.title}“ (Version ${u.version})`]);
          applied.push(a);
        }
      } else if (a.type === 'doc_send_pdf') {
        const page = await db.maybeOne(`select p.*, f.distribution_list from doc_pages p left join doc_folders f on f.id = p.folder_id where p.id = $1 and p.project_id = $2 and p.deleted_at is null`, [a.pageId, task.project_id]);
        const useList = page && (!Array.isArray(a.to) || !a.to.length);
        const norm = (v: unknown[]) => v.map((x) => String(x).trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
        const list = page ? norm(page.distribution_list?.length ? page.distribution_list : page.settings?.recipients ?? []) : [];
        const to = (useList ? list : norm(Array.isArray(a.to) ? a.to : [])).slice(0, 10);
        // Genannte Empfänger: Projektmitglieder immer, alle anderen nur mit aktiver Freigabe der Seite oder aus dem Verteiler
        // (Verteiler wie beim Versand an den ganzen Verteiler nur mit „Final setzen / Versand“)
        const blocked = page && !useList ? await unreleasedRecipients(db, page, to, m.can_finalize ? list : []) : [];
        if (!page) errors.push('PDF-Versand verworfen: pageId unbekannt');
        else if (page.status !== 'final') errors.push(`PDF-Versand nur für finale Seiten („${page.title}“ ist ${page.status})`);
        else if (useList && !m.can_finalize) errors.push('Versand an den Verteiler erfordert das Recht „Final setzen / Versand“');
        else if (useList && !to.length) errors.push(`Kein Verteiler am Ordner oder an der Seite „${page.title}“`);
        else if (blocked.length) errors.push(`PDF von „${page.title}“ nicht gesendet: ${blocked.join(', ')} ist ${m.can_finalize ? 'weder Projektmitglied noch im Verteiler' : 'kein Projektmitglied'}, und die Seite ist für diese Adresse nicht freigegeben${!m.can_finalize && blocked.some((x) => list.includes(x)) ? ' (Adressen aus dem Verteiler nur mit Recht „Final setzen / Versand“)' : ''}`);
        else if (!to.length || !a.subject) errors.push('PDF-Versand verworfen: Empfänger oder Betreff fehlt');
        else if (!account) errors.push('PDF-Versand nicht möglich: kein Projektkonto');
        else if (!canMail) errors.push('PDF-Versand nicht erlaubt: Agent darf keine Mails senden');
        else if (mailsSent >= 3) errors.push('PDF-Versand verworfen: mehr als drei Mails im Lauf');
        else {
          try {
            const pdf = await htmlToPdf(db, page.content_html ?? mdToHtml(page.content_md), { title: page.title, project: task.project_name, version: page.version, status: page.status, author: agent.name, date: new Date(), folder: await L.folderName(db, page.folder_id) }, await L.layoutFor(db, page.id));
            const filename = `${String(page.title).replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80)}_v${page.version}.pdf`;
            await mail.sendFromAccount(account, { to, subject: a.subject, text: a.text ?? `Anbei „${page.title}“ als PDF.`, taskId: task.id, userId: agent.id, projectId: task.project_id, attachments: [{ filename, content: pdf, contentType: 'application/pdf' }] });
            await mkdir(L.uploadDir, { recursive: true });
            const storage = path.join(L.uploadDir, `${randomUUID()}.pdf`);
            await writeFile(storage, pdf);
            await db.query(`insert into attachments (project_id, page_id, filename, mime, size, storage_path, uploaded_by) values ($1,$2,$3,'application/pdf',$4,$5,$6)`, [task.project_id, page.id, filename, pdf.length, storage, agent.id]);
            mailsSent++;
            await logSys(`PDF „${page.title}“ gesendet an ${to.join(', ')}`);
            applied.push({ ...a, to });
          } catch (e: any) {
            const msg = `PDF von „${page.title}“ an ${to.join(', ')} nicht gesendet: ${String(e?.message ?? e).slice(0, 200)}`;
            errors.push(msg);
            await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [task.id, agent.id, msg]);
          }
        }
      } else if (a.type === 'mail' && (!Array.isArray(a.to) || !a.to.length || !a.subject || !a.text)) errors.push('Mail verworfen: Empfänger, Betreff oder Text fehlt');
      else if (a.type === 'mail' && mailsSent >= 3) errors.push('Mail verworfen: mehr als drei Mails im Lauf');
      else if (a.type === 'mail') {
        const to = a.to.map((x) => String(x).trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)).slice(0, 5);
        if (!to.length) errors.push(`Mail nicht gesendet: keine gültige Empfängeradresse (${a.to.join(', ')})`);
        else if (!account && !viewAccount) { errors.push('Mail nicht gesendet: kein Mailkonto im Projekt'); await logSys(`Mail an ${to.join(', ')} nicht gesendet: kein Mailkonto im Projekt („${a.subject}“)`); }
        else if (!account && viewAccount) {
          mailsSent++;
          await db.query(`insert into mail_drafts (account_id, view_id, task_id, project_id, user_id, to_addrs, cc_addrs, subject, body, status) values ($1,$2,$3,$4,$5,$6,'[]',$7,$8,'pending_approval')`, [viewAccount.id, viewAccount.view_id, task.id, task.project_id, agent.id, JSON.stringify(to), a.subject, a.text]);
          await notifyDraft(viewAccount, a.subject);
          await logSys(`Mail-Entwurf an ${to.join(', ')} wartet auf Freigabe (nicht gesendet): „${a.subject}“`);
          applied.push({ type: 'mail', to, subject: a.subject, text: `[Entwurf zur Freigabe] ${a.text}` });
        } else if (account) {
          mailsSent++;
          if (canMail) {
            try {
              await mail.sendFromAccount(account, { to, subject: a.subject, text: a.text, taskId: task.id, userId: agent.id, projectId: task.project_id });
              await logSys(`Mail gesendet an ${to.join(', ')}: „${a.subject}“`);
              applied.push({ type: 'mail', to, subject: a.subject, text: a.text });
            } catch (e: any) {
              const msg = `Mail an ${to.join(', ')} nicht gesendet: ${String(e?.message ?? e).slice(0, 200)}`;
              errors.push(msg);
              await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [task.id, agent.id, msg]);
            }
          } else {
            await db.query(`insert into mail_drafts (account_id, task_id, project_id, user_id, to_addrs, cc_addrs, subject, body, status) values ($1,$2,$3,$4,$5,'[]',$6,$7,'pending_approval')`, [account.id, task.id, task.project_id, agent.id, JSON.stringify(to), a.subject, a.text]);
            await logSys(`Mail-Entwurf an ${to.join(', ')} wartet auf Freigabe (nicht gesendet): „${a.subject}“`);
            for (const pl of pls) await notify(db, { userId: pl.user_id ?? (await db.one(`select id from users where email = $1`, [pl.email])).id, projectId: task.project_id, type: 'draft.review', title: `Mail-Entwurf von ${agent.name} zur Freigabe`, body: a.subject, link: `/projekte/${task.project_id}/mail/freigaben` });
            applied.push({ type: 'mail', to, subject: a.subject, text: `[Entwurf zur Freigabe] ${a.text}` });
          }
        }
      } else if (a.type === 'reply_origin') {
        const text = String(a.text ?? '').trim();
        const o = (await originMails(db, task.id))[0];
        if (!text) errors.push('reply_origin ohne Text verworfen');
        else if (!o) errors.push('reply_origin: keine Ursprungsmail am Arbeitspaket');
        else if (o.answered || o.draft_open) errors.push('reply_origin: Ursprungsmail ist schon beantwortet oder eine Antwort wartet auf Freigabe');
        else if (mailsSent >= 3) errors.push('reply_origin verworfen: mehr als drei Mails im Lauf');
        else {
          // Aus dem Konto der Ursprungsmail: Projektkonto dieses Projekts direkt (wenn erlaubt), sonst Entwurf über die Ansicht des Kontos
          const acc = await db.one<AccountRow>(`select * from mail_accounts where id = $1`, [o.account_id]);
          const view = await db.maybeOne(`select v.id from mail_view_matches x join mail_views v on v.id = x.view_id where x.mail_id = $1 and v.project_id = $2 order by v.created_at limit 1`, [o.id, task.project_id]);
          const subject = reSubject(o.subject);
          mailsSent++;
          if (acc.type === 'project' && acc.project_id === task.project_id && m.agent_can_mail) {
            try {
              await mail.sendFromAccount(acc, { to: [o.from_addr], subject, text, taskId: task.id, inReplyTo: o.message_id, references: [o.references_header, o.message_id].filter(Boolean).join(' ') || null, userId: agent.id, projectId: task.project_id });
              await logSys(`Antwort auf die Ursprungsmail gesendet an ${o.from_addr}: „${subject}“`);
              applied.push({ type: 'reply_origin', text } as any);
            } catch (e: any) { errors.push(`Antwort an ${o.from_addr} nicht gesendet: ${String(e?.message ?? e).slice(0, 200)}`); }
          } else if (acc.type === 'personal' && !view) errors.push('reply_origin: persönliches Konto ohne Ansicht im Projekt, der Eigentümer kann nicht freigeben');
          else {
            await db.query(`insert into mail_drafts (account_id, view_id, task_id, project_id, user_id, to_addrs, cc_addrs, subject, body, in_reply_to, status) values ($1,$2,$3,$4,$5,$6,'[]',$7,$8,$9,'pending_approval')`, [acc.id, view?.id ?? null, task.id, task.project_id, agent.id, JSON.stringify([o.from_addr]), subject, text, o.message_id ?? null]);
            await notifyDraft(acc, subject);
            await logSys(`Antwort auf die Ursprungsmail an ${o.from_addr} wartet als Entwurf auf Freigabe (nicht gesendet): „${subject}“`);
            applied.push({ type: 'reply_origin', text: `[Entwurf zur Freigabe] ${text}` } as any);
          }
        }
      } else if (a.type === 'blocked' && a.reason) {
        await db.query(`update tasks set blocked = true, blocked_reason = $2 where id = $1`, [task.id, a.reason]);
        await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [task.id, agent.id, `Blockiert gemeldet: ${a.reason}`]);
        for (const pl of pls) await notify(db, { userId: (await db.one(`select id from users where email = $1`, [pl.email])).id, projectId: task.project_id, type: 'escalation', title: `Blockiert (Agent): ${task.title}`, body: a.reason, link: `/projekte/${task.project_id}/board?task=${task.id}` });
        applied.push(a);
      } else if (a.type === 'escalate' && a.text) {
        await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [task.id, agent.id, `An die Projektleitung: ${a.text}`]);
        // Eskalation kommt auch im Chat an (Direktnachricht an die verantwortliche PL); die Antwort dort landet im Log
        for (const pl of pls) {
          await notify(db, { userId: pl.user_id, projectId: task.project_id, type: 'escalation', title: `${agent.name} braucht eine Entscheidung: ${task.title}`, body: a.text, link: `/projekte/${task.project_id}/board?task=${task.id}` });
          await agentChatMessage(db, agent, { userId: pl.user_id }, `${task.project_key}-${task.number} „${task.title}“: ${a.text}`, task.project_id);
        }
        applied.push(a);
      } else if (a.type === 'chat') {
        // An Projektmitglieder (Menschen) per Direktnachricht, leer = verantwortliche PL, „projekt“ = Projektkanal
        const text = String(a.text ?? '').trim();
        const raw = (Array.isArray(a.to) ? a.to : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
        const toProject = raw.some((x) => x === 'projekt' || x === '#projekt' || x === 'projektkanal');
        const people = members.rows.filter((x: any) => x.kind !== 'agent' && raw.some((r) => r === String(x.email).toLowerCase() || r === String(x.name).toLowerCase()));
        const unknown = raw.filter((r) => !['projekt', '#projekt', 'projektkanal'].includes(r) && !people.some((x: any) => r === String(x.email).toLowerCase() || r === String(x.name).toLowerCase()));
        const targets = raw.length ? people : pls;
        if (!text) errors.push('Chat ohne Text verworfen');
        else if (chats >= 3) errors.push('Chat verworfen: mehr als drei Nachrichten im Lauf');
        else if (unknown.length) errors.push(`Chat verworfen: ${unknown.join(', ')} ist kein Mitglied des Projekts`);
        else {
          chats++;
          const msg = `${task.project_key}-${task.number} „${task.title}“: ${text}`;
          for (const x of targets) await agentChatMessage(db, agent, { userId: x.user_id }, msg, task.project_id);
          if (toProject) await agentChatMessage(db, agent, { projectId: task.project_id }, msg, task.project_id);
          const names = [...targets.map((x: any) => x.name), ...(toProject ? ['Projektkanal'] : [])].join(', ');
          await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [task.id, agent.id, `Per Chat an ${names}: ${cut(text, 1500)}`]);
          applied.push({ type: 'chat', to: [...targets.map((x: any) => x.email), ...(toProject ? ['projekt'] : [])], text } as any);
        }
      } else if (a.type === 'wait' && !a.kind) errors.push('wait ohne kind verworfen');
      else if (a.type === 'wait') {
        const prev: AgentWait | null = task.agent_wait ?? null;
        const keepSince = prev && prev.kind === a.kind && trigger !== 'reply' && trigger !== 'comment' && trigger !== 'mail' ? prev.since : now.toISOString();
        const untilAt = a.kind === 'date' ? parseUntil(a.until, now) : null;
        if (a.kind === 'date' && !untilAt) errors.push(`Termin „${a.until ?? ''}“ nicht lesbar, Prüfung nach ${clampH(a.checkAfterHours, 24)} h`);
        const check = untilAt && untilAt.getTime() > now.getTime() ? untilAt : new Date(now.getTime() + clampH(a.checkAfterHours, 24) * H);
        const w: AgentWait = { kind: a.kind, reason: (String(a.reason ?? '').trim() || 'keine Angabe').slice(0, 300), since: keepSince };
        if (a.kind === 'reply') {
          const base = new Date(keepSince).getTime();
          w.remindAt = prev?.kind === 'reply' && prev.reminded ? prev.remindAt : new Date(base + clampH(a.remindAfterHours, 48) * H).toISOString();
          w.escalateAt = new Date(base + clampH(a.escalateAfterHours, 120) * H).toISOString();
          w.reminded = prev?.kind === 'reply' ? Boolean(prev.reminded) : false;
          w.escalated = prev?.kind === 'reply' ? Boolean(prev.escalated) : false;
        }
        const nextCheck = a.kind === 'reply' ? new Date(Math.min(check.getTime(), ...[w.remindAt, w.escalateAt].filter((x): x is string => Boolean(x)).map((x) => new Date(x).getTime()).filter((x) => x > now.getTime()))) : check;
        await db.query(`update tasks set agent_wait = $2, agent_next_check_at = $3 where id = $1`, [task.id, JSON.stringify(w), nextCheck]);
        applied.push({ ...a, reason: w.reason });
        waited = true;
      } else if (PLAN_TYPES.includes(a.type)) {
        const r = await plan(a);
        if ('error' in r) errors.push(r.error);
        else if (r.applied) applied.push(r.applied);
      } else if (a.type === 'none') applied.push(a);
    }
    if (!waited) await db.query(`update tasks set agent_wait = null, agent_next_check_at = null where id = $1`, [task.id]);
    if (!applied.some((x) => x.type === 'comment') && String(j.note ?? '').trim()) await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [task.id, agent.id, `${cut(String(j.note), 600)}${applied.length && !applied.every((x) => x.type === 'none') ? '' : ' (keine Aktion)'}`]);
    if (applied.some((x) => x.type !== 'none')) await touchTask(db, task.id);
    const run = await db.one(`insert into agent_runs (org_id, agent_user_id, project_id, task_id, trigger, status, reasoning, actions, fingerprint, input_tokens, output_tokens, error, proposed) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [agent.org_id, agent.id, task.project_id, task.id, trigger, errors.length ? 'error' : 'ok', cut(String(j.note ?? j.reasoning ?? ''), 2000), JSON.stringify(applied), await fingerprintOf(db, task.id), inputTokens, outputTokens, errors.length ? errors.join(' | ') : null, JSON.stringify(actions)]);
    await audit(db, { orgId: agent.org_id, projectId: task.project_id, userId: agent.id, action: 'agent.run', objectType: 'task', objectId: task.id, details: { runId: run.id, trigger, actions: applied.map((x) => x.type), profile: c.name, model, inputTokens, outputTokens } });
    return { runId: run.id, taskId: task.id, status: errors.length ? 'error' : 'ok', actions: applied, error: errors.length ? errors.join(' | ') : undefined };
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 300);
    const er = await db.one(`insert into agent_runs (org_id, agent_user_id, project_id, task_id, trigger, status, error, fingerprint) values ($1,$2,$3,$4,$5,'error',$6,$7) returning id`, [agent.org_id, agent.id, task.project_id, task.id, trigger, msg, await fingerprintOf(db, task.id)]);
    await audit(db, { orgId: agent.org_id, projectId: task.project_id, userId: agent.id, action: 'agent.run_failed', objectType: 'task', objectId: task.id, details: { runId: er.id, trigger, error: msg } });
    return { runId: er.id, taskId: task.id, status: 'error', actions: [], error: msg };
  }
}

/**
 * Adressen, an die das PDF einer Seite nicht gehen darf: weder aktive Person im Projekt noch im Verteiler (list) noch mit
 * aktiver Freigabe der Seite (direkt oder über eine Oberseite mit „inkl. Unterseiten“, nicht widerrufen, nicht abgelaufen).
 */
async function unreleasedRecipients(db: Db, page: { id: string; project_id: string }, to: string[], list: string[]): Promise<string[]> {
  if (!to.length) return [];
  const ok = await db.query(
    `with recursive anc as (
       select id, parent_page_id, 0 as depth from doc_pages where id = $1
       union all
       select p.id, p.parent_page_id, a.depth + 1 from doc_pages p join anc a on p.id = a.parent_page_id
     )
     select lower(u.email) as email from project_members m join users u on u.id = m.user_id where m.project_id = $2 and u.active and u.kind = 'person' and lower(u.email) = any($3::text[])
     union
     select lower(s.email) from doc_shares s join anc a on a.id = s.page_id
     where s.revoked_at is null and (s.expires_at is null or s.expires_at > now()) and (a.depth = 0 or s.include_children) and lower(s.email) = any($3::text[])`,
    [page.id, page.project_id, to]);
  const allowed = new Set([...list, ...ok.rows.map((r: any) => r.email)]);
  return to.filter((x) => !allowed.has(x));
}

const PLAN_TYPES: string[] = ['create_aufgabe', 'create_ap', 'assign', 'set_dates', 'create_subproject', 'create_milestone', 'create_event'];
const MAX_CREATE = 15;

/**
 * Planungsaktionen eines Agenten. Rahmen: stellvertretende PL oder „Projektplan ändern“ plant im ganzen Projekt;
 * sonst nur im eigenen Bereich (dieses AP und seine Aufgaben, eigene Zuständigkeit, eigene Teilprojekte). Agenten
 * weist nur eine PL zu; bestehende Termine anderer ändert nur, wer planen darf.
 */
function planner(db: Db, c: { agent: { id: string; name: string; org_id: string }; m: any; task: any; canPlan: boolean; myTps: string[]; now: Date }) {
  const { agent, m, task, canPlan, myTps, now } = c;
  const actor: PlanActor = { id: agent.id, name: agent.name, orgId: agent.org_id, role: m.role, label: `${agent.name} (KI-Agent)`, isAgent: true };
  const code = (n: number) => `${task.project_key}-${n}`;
  const inScope = (t: any) => canPlan || t.id === task.id || t.parent_id === task.id || t.id === task.parent_id || t.eff_responsible === agent.id || Boolean(t.subproject_id && myTps.includes(t.subproject_id));
  const log = (taskId: string, body: string) => db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [taskId, agent.id, body]);
  const subprojectByName = (name: unknown) => db.maybeOne(`select id, name from subprojects where project_id = $1 and lower(name) = lower($2)`, [task.project_id, String(name ?? '').trim()]);
  let created = 0;
  return async (a: any): Promise<{ applied: any } | { error: string }> => {
    const title = String(a.title ?? '').trim().slice(0, 200);
    const start = ymd(a.startDate);
    const due = ymd(a.dueDate);
    if (start === undefined || due === undefined) return { error: `${a.type}: Datum nicht als YYYY-MM-DD (${[a.startDate, a.dueDate].filter(Boolean).join(', ')})` };
    if (start && due && start > due) return { error: `${a.type}: Start ${start} liegt nach dem Termin ${due}` };
    if (a.type.startsWith('create_') && created >= MAX_CREATE) return { error: `${a.type} „${title}“ verworfen: mehr als ${MAX_CREATE} Anlagen je Lauf` };
    if (a.type.startsWith('create_') && !title) return { error: `${a.type}: Titel fehlt` };

    if (a.type === 'create_aufgabe' || a.type === 'create_ap') {
      const who = await resolvePerson(db, task.project_id, actor, a.responsible);
      if ('error' in who) return { error: `${a.type} „${title}“: ${who.error}` };
      let parentId: string | null = null;
      let subprojectId: string | null = null;
      if (a.type === 'create_aufgabe') {
        const parent = await findTaskByRef(db, task.project_id, a.ref || (task.parent_id ? task.parent_number : task.number));
        if (!parent) return { error: `create_aufgabe „${title}“: Arbeitspaket ${a.ref} nicht gefunden` };
        if (parent.parent_id) return { error: `create_aufgabe „${title}“: ${code(parent.number)} ist eine Aufgabe; Aufgaben haben keine eigenen Aufgaben` };
        if (!inScope(parent) || !(await canSeeSubproject(db, agent.id, parent.subproject_id))) return { error: `create_aufgabe „${title}“: ${code(parent.number)} liegt außerhalb deines Bereichs` };
        parentId = parent.id;
        subprojectId = parent.subproject_id;
      } else {
        const sp = a.subproject ? await subprojectByName(a.subproject) : null;
        if (a.subproject && !sp) return { error: `create_ap „${title}“: Teilprojekt „${a.subproject}“ gibt es nicht` };
        subprojectId = sp?.id ?? task.subproject_id ?? null;
        if (!canPlan && !(subprojectId && myTps.includes(subprojectId))) return { error: `create_ap „${title}“: Arbeitspakete legst du nur als stellvertretende PL, mit Recht „Projektplan ändern“ oder in deinen Teilprojekten an` };
        if (!(await canSeeSubproject(db, agent.id, subprojectId))) return { error: `create_ap „${title}“: Teilprojekt ist für dich nicht sichtbar` };
      }
      const dup = await db.maybeOne(`select number from tasks where project_id = $1 and deleted_at is null and archived_at is null and lower(title) = lower($2) and parent_id is not distinct from $3::uuid and ($3::uuid is not null or subproject_id is not distinct from $4::uuid)`, [task.project_id, title, parentId, subprojectId]);
      if (dup) return { error: `${a.type}: „${title}“ gibt es schon (${code(dup.number)})` };
      const t = await createPlannedTask(db, actor, { projectId: task.project_id, projectKey: task.project_key, title, description: a.text, parentId, subprojectId, startDate: start, dueDate: due, responsibleUserId: who.userId, responsibleEmail: who.email, responsibleKind: who.kind, items: a.items, logTaskId: task.id });
      created++;
      return { applied: { type: a.type, ref: code(t.number), title: t.title, responsible: who.name ?? who.email, startDate: start, dueDate: due } };
    }

    if (a.type === 'assign' || a.type === 'set_dates') {
      const t = await findTaskByRef(db, task.project_id, a.ref || (a.type === 'set_dates' ? task.number : ''));
      if (!t) return { error: `${a.type}: ${a.ref || 'Kennung fehlt'} nicht gefunden` };
      if (!inScope(t) || !(await canSeeSubproject(db, agent.id, t.subproject_id))) return { error: `${a.type}: ${code(t.number)} liegt außerhalb deines Bereichs` };
      if (a.type === 'assign') {
        const who = await resolvePerson(db, task.project_id, actor, a.responsible);
        if ('error' in who) return { error: `assign ${code(t.number)}: ${who.error}` };
        if ((t.responsible_user_id ?? null) === who.userId && (t.responsible_email ?? null) === who.email) return { applied: null };
        await db.query(`update tasks set responsible_user_id = $2, responsible_email = $3 where id = $1`, [t.id, who.userId, who.email]);
        await log(t.id, `Zuständig: ${who.name ?? who.email ?? 'wieder geerbt'} (zugewiesen von ${agent.name})`);
        await audit(db, { orgId: agent.org_id, projectId: task.project_id, userId: agent.id, action: 'task.update', objectType: 'task', objectId: t.id, details: { responsibleUserId: who.userId, responsibleEmail: who.email } });
        await afterAssign(db, actor, task.project_id, t.id, t.title, who.userId, who.kind);
        return { applied: { type: 'assign', ref: code(t.number), responsible: who.name ?? who.email } };
      }
      if (!start && !due) return { error: `set_dates ${code(t.number)}: kein Datum angegeben` };
      if (!canPlan && t.created_by !== agent.id && t.due_date) return { error: `set_dates ${code(t.number)}: bestehende Termine anderer ändert nur die PL oder wer „Projektplan ändern“ darf; Konflikt ins Log oder an die PL` };
      const ns = start ?? dateStr(t.start_date);
      const nd = due ?? dateStr(t.due_date);
      if (ns && nd && ns > nd) return { error: `set_dates ${code(t.number)}: Start ${ns} liegt nach dem Termin ${nd}` };
      await db.query(`update tasks set start_date = $2, due_date = $3 where id = $1`, [t.id, ns, nd]);
      await log(t.id, `Termin: ${ns ?? '–'} bis ${nd ?? '–'} (gesetzt von ${agent.name})`);
      await audit(db, { orgId: agent.org_id, projectId: task.project_id, userId: agent.id, action: 'task.update', objectType: 'task', objectId: t.id, details: { startDate: ns, dueDate: nd } });
      return { applied: { type: 'set_dates', ref: code(t.number), startDate: ns, dueDate: nd } };
    }

    if (a.type === 'create_subproject' || a.type === 'create_milestone') {
      if (!canPlan) return { error: `${a.type} „${title}“: nur als stellvertretende PL oder mit Recht „Projektplan ändern“` };
      if (a.type === 'create_subproject') {
        if (await subprojectByName(title)) return { error: `create_subproject: „${title}“ gibt es schon` };
        const who = await resolvePerson(db, task.project_id, actor, a.responsible);
        if ('error' in who) return { error: `create_subproject „${title}“: ${who.error}` };
        if (who.email) return { error: `create_subproject „${title}“: verantwortlich kann nur ein Projektmitglied sein` };
        const pos = await db.one(`select coalesce(max(position), -1) + 1 as p from subprojects where project_id = $1`, [task.project_id]);
        const r = await db.one(`insert into subprojects (project_id, name, responsible_user_id, start_date, end_date, position) values ($1,$2,$3,$4,$5,$6) returning id`, [task.project_id, title, who.userId, start, due, pos.p]);
        await log(task.id, `Teilprojekt angelegt: „${title}“${who.name ? `, verantwortlich ${who.name}` : ''}`);
        await audit(db, { orgId: agent.org_id, projectId: task.project_id, userId: agent.id, action: 'subproject.create', objectType: 'subproject', objectId: r.id, details: { name: title } });
        created++;
        return { applied: { type: 'create_subproject', title, responsible: who.name, startDate: start, dueDate: due } };
      }
      if (!due) return { error: `create_milestone „${title}“: Datum fehlt` };
      const sp = a.subproject ? await subprojectByName(a.subproject) : null;
      if (a.subproject && !sp) return { error: `create_milestone „${title}“: Teilprojekt „${a.subproject}“ gibt es nicht` };
      const r = await db.one(`insert into milestones (project_id, subproject_id, name, date) values ($1,$2,$3,$4) returning id`, [task.project_id, sp?.id ?? null, title, due]);
      await log(task.id, `Meilenstein angelegt: „${title}“ am ${due}`);
      await audit(db, { orgId: agent.org_id, projectId: task.project_id, userId: agent.id, action: 'milestone.create', objectType: 'milestone', objectId: r.id, details: { name: title, date: due } });
      created++;
      return { applied: { type: 'create_milestone', title, dueDate: due, subproject: sp?.name ?? null } };
    }

    if (a.type === 'create_event') {
      const raw = String(a.startsAt ?? '').trim().replace(' ', 'T');
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) return { error: `create_event „${title}“: Beginn als YYYY-MM-DDTHH:MM angeben` };
      const starts = parseUntil(raw, now);
      const ends = a.endsAt ? parseUntil(String(a.endsAt).trim().replace(' ', 'T'), now) : starts ? new Date(starts.getTime() + H) : null;
      if (!starts || !ends || ends <= starts) return { error: `create_event „${title}“: Beginn oder Ende nicht lesbar` };
      if (await db.maybeOne(`select 1 from meetings where project_id = $1 and lower(title) = lower($2) and starts_at = $3`, [task.project_id, title, starts])) return { error: `create_event: „${title}“ steht schon im Kalender` };
      await createPlannedEvent(db, actor, { projectId: task.project_id, title, startsAt: starts, endsAt: ends, location: a.location, description: a.text, taskId: task.id });
      await log(task.id, `Termin vorläufig im Kalender: „${title}“ ${fmtWhen(starts)}${a.location ? `, ${a.location}` : ''} (verbindlich erst nach Bestätigung durch eine Person)`);
      created++;
      return { applied: { type: 'create_event', title, startsAt: starts.toISOString(), endsAt: ends.toISOString(), location: a.location ?? null } };
    }
    return { error: `${a.type}: unbekannte Aktion` };
  };
}

const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }) : '–');
const KIND_DE: Record<string, string> = { reply: 'Rückmeldung', date: 'Termin', task: 'Erledigung durch andere', info: 'Information' };
function waitText(task: any, now: Date): string {
  const w: AgentWait | null = task.agent_wait ?? null;
  if (!w) return '';
  const hours = Math.round((now.getTime() - new Date(w.since).getTime()) / H);
  return `Du wartest seit ${fmt(w.since)} (${hours} h) auf ${KIND_DE[w.kind] ?? w.kind}: ${w.reason}${w.remindAt ? ` · Nachfassen geplant ${fmt(w.remindAt)}${w.reminded ? ' (erledigt)' : ''}` : ''}${w.escalateAt ? ` · Eskalation geplant ${fmt(w.escalateAt)}${w.escalated ? ' (erledigt)' : ''}` : ''}\n`;
}
function triggerText(trigger: string, task: any): string {
  const w: AgentWait | null = task.agent_wait ?? null;
  switch (trigger) {
    case 'assigned': return 'Das Arbeitspaket wurde dir gerade zugewiesen. Verschaffe dir den Stand und beginne.';
    case 'comment': return 'Neuer Log-Eintrag oder Kommentar einer Person am Arbeitspaket.';
    case 'task_changed': return 'Eine Person hat das Arbeitspaket oder seine Tasks geändert (Text, Termin, Status). Lies die Änderung und handle entsprechend.';
    case 'mail': case 'reply': return 'Neue Mail zum Arbeitspaket (möglicherweise die erwartete Rückmeldung). Werte sie aus.';
    case 'check': return `Wiedervorlage: deine Wartefrist ist abgelaufen${w ? ` (gewartet auf ${KIND_DE[w.kind] ?? w.kind})` : ''}. Prüfe, ob das Erwartete eingetreten ist.`;
    case 'reminder_due': return 'Nachfassen fällig: die Rückmeldung ist bisher nicht eingegangen. Fasse jetzt nach (bei Projektmitgliedern per Chat, nur bei Externen per Mail) oder begründe, warum nicht; setze danach erneut wait.';
    case 'escalation_due': return 'Eskalation fällig: trotz Nachfassen keine Rückmeldung. Eskaliere jetzt an die Projektleitung (escalate) oder begründe, warum du weiter wartest.';
    case 'due_soon': return 'Die Fälligkeit des Arbeitspakets ist nah.';
    case 'overdue': return 'Das Arbeitspaket ist überfällig.';
    case 'changed': return 'Seit deinem letzten Lauf hat sich am Arbeitspaket etwas geändert (Log, Mail, Status, Termin oder Tasks). Lies die Änderung und handle entsprechend.';
    case 'periodic': return 'Regelmäßige Durchsicht: seit drei Tagen kein Lauf. Prüfe den Stand; ist nichts zu tun und nichts zu erwarten, tu nichts.';
    case 'rejected': return 'Eine Person hat einen Vorschlag von dir abgelehnt (z. B. einen Mail-Entwurf; Details im Log). Wiederhole ihn nicht unverändert; kläre bei Bedarf per Chat, was anders sein soll.';
    case 'manual': return 'Die Projektleitung hat den Lauf manuell gestartet.';
    default: return trigger;
  }
}

/** Zuständiger Agent eines Arbeitspakets (direkt oder geerbt vom Arbeitspaket bzw. Teilprojekt), sofern aktiv und Mitglied. */
export async function agentForTask(db: Db, taskId: string): Promise<{ id: string; name: string; org_id: string; persona: string | null } | null> {
  return db.maybeOne(
    `select u.id, u.name, u.org_id, u.persona from tasks t ${EFFECTIVE_JOINS} join users u on u.id = (${EFFECTIVE_RESPONSIBLE_SQL})
     where t.id = $1 and u.kind = 'agent' and u.active and exists (select 1 from project_members m where m.project_id = t.project_id and m.user_id = u.id)`, [taskId]);
}

/** Läufe, die einem Agenten heute noch zustehen: Tagesbudget des Mandanten bzw. das kleinere eigene (Agenten der PL); Läufe an Arbeitspaketen, im Chat und an Mails zählen, übersprungene nicht. */
export async function agentBudgetLeft(db: Db, agent: { id: string; org_id: string }, now = new Date()): Promise<number> {
  const settings = await orgAiSettings(db, agent.org_id);
  const own = (await db.maybeOne(`select agent_daily_budget from users where id = $1`, [agent.id]))?.agent_daily_budget;
  const limit = own == null ? settings.agentDailyBudget : Math.min(settings.agentDailyBudget, Number(own));
  const used = await db.one(`select count(*)::int as c from agent_runs where agent_user_id = $1 and status in ('ok','error') and created_at >= $2::date`, [agent.id, now.toISOString().slice(0, 10)]);
  return Math.max(0, limit - used.c);
}

/** Ereignislauf: der zuständige Agent läuft sofort (von Routen über queueAgentRun ausgelöst), solange sein Tagesbudget reicht. */
export async function runForTask(db: Db, mail: MailService, fetchFn: typeof fetch, taskId: string, trigger: string): Promise<AgentRunResult | null> {
  const t = await db.maybeOne(`select t.agent_paused, c.is_done from tasks t join board_columns c on c.id = t.column_id where t.id = $1 and t.deleted_at is null and t.archived_at is null`, [taskId]);
  if (!t || t.agent_paused || t.is_done) return null;
  const agent = await agentForTask(db, taskId);
  if (!agent || (await agentBudgetLeft(db, agent)) <= 0) return null;
  return runAgentOnTask(db, mail, fetchFn, agent, taskId, trigger);
}

/** Kennung des Zustands: ändert sich bei neuen Log-Einträgen anderer, neuen Mails, Status- oder Terminänderung. */
export async function fingerprintOf(db: Db, taskId: string): Promise<string> {
  const r = await db.one(`select t.column_id, t.due_date, t.blocked,
      (select count(*)::int from task_comments c where c.task_id = t.id and c.source <> 'ai') as comments,
      (select count(*)::int from mail_task_links l join mails m on m.id = l.mail_id where l.task_id = t.id and not m.outgoing) as mails,
      (select count(*)::int from checklist_items i where i.task_id = t.id and i.done) as done_items,
      (select string_agg(i.title, '|' order by i.position) from checklist_items i where i.task_id = t.id) as item_titles, t.title, t.description
    from tasks t where t.id = $1`, [taskId]);
  const h = createHash('sha1').update(`${r.title}|${r.description ?? ''}|${r.item_titles ?? ''}`).digest('hex').slice(0, 10);
  return `${r.column_id}|${r.due_date ? String(r.due_date).slice(0, 10) : ''}|${r.blocked}|${r.comments}|${r.mails}|${r.done_items}|${h}`;
}

/** Worker: alle aktiven Agenten über ihre offenen, direkt zugewiesenen Arbeitspakete; Anlass aus Zustandsänderung, Fälligkeit oder Tagesrhythmus; Tagesbudget je Agent. */
export async function runAgents(db: Db, mail: MailService, fetchFn: typeof fetch, now = new Date()): Promise<AgentRunResult[]> {
  const out: AgentRunResult[] = [];
  const agents = await db.query(`select id, name, org_id, persona from users where kind = 'agent' and active`);
  for (const agent of agents.rows as any[]) {
    const cfg = await aiConfigForAgent(db, agent.id);
    if (!cfg) continue;
    let budget = await agentBudgetLeft(db, agent, now);
    // Direkt zugewiesen oder geerbt (Aufgabe vom Arbeitspaket, Arbeitspaket vom Teilprojekt); nur in Projekten, in denen der Agent Mitglied ist
    const tasks = await db.query(
      `select t.id, t.due_date, t.agent_next_check_at, t.agent_wait from tasks t join projects p on p.id = t.project_id join board_columns c on c.id = t.column_id ${EFFECTIVE_JOINS}
       where (${EFFECTIVE_RESPONSIBLE_SQL}) = $1 and t.deleted_at is null and t.archived_at is null and not c.is_done and not t.agent_paused and p.status = 'active'
         and exists (select 1 from project_members pm where pm.project_id = t.project_id and pm.user_id = $1) order by t.due_date nulls last`, [agent.id]);
    for (const t of tasks.rows as any[]) {
      if (budget <= 0) break;
      const last = await db.maybeOne(`select created_at, fingerprint from agent_runs where task_id = $1 and agent_user_id = $2 order by created_at desc limit 1`, [t.id, agent.id]);
      const fp = await fingerprintOf(db, t.id);
      const hours = last ? (now.getTime() - new Date(last.created_at).getTime()) / 3600_000 : Infinity;
      const due = t.due_date ? (new Date(String(t.due_date).slice(0, 10)).getTime() - now.getTime()) / 86400_000 : null;
      let trigger: string | null = null;
      const w: AgentWait | null = t.agent_wait ?? null;
      if (w?.kind === 'reply' && w.escalateAt && !w.escalated && now >= new Date(w.escalateAt)) {
        trigger = 'escalation_due';
        await db.query(`update tasks set agent_wait = $2 where id = $1`, [t.id, JSON.stringify({ ...w, escalated: true })]);
      } else if (w?.kind === 'reply' && w.remindAt && !w.reminded && now >= new Date(w.remindAt)) {
        trigger = 'reminder_due';
        await db.query(`update tasks set agent_wait = $2 where id = $1`, [t.id, JSON.stringify({ ...w, reminded: true })]);
      } else if (t.agent_next_check_at && now >= new Date(t.agent_next_check_at)) trigger = 'check';
      else if (!last) trigger = 'assigned';
      else if (last.fingerprint !== fp && hours >= 0.5) trigger = 'changed';
      else if (due != null && due <= 2 && hours >= 24) trigger = due < 0 ? 'overdue' : 'due_soon';
      else if (hours >= 24 * 3) trigger = 'periodic';
      if (!trigger) continue;
      if (trigger === 'check') await db.query(`update tasks set agent_next_check_at = null where id = $1`, [t.id]);
      budget--;
      out.push(await runAgentOnTask(db, mail, fetchFn, agent, t.id, trigger, cfg, now));
    }
  }
  return out;
}
