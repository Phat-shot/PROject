import type { Db } from '../db.js';
import type { MailService } from '../mail/service.js';
import type { AccountRow } from '../mail/types.js';
import { audit } from '../audit.js';
import { notify, notifyMany, usersWithRight } from '../notify.js';
import { touchTask } from '../tasks/service.js';
import { aiConfigForAgent, complete, orgAiSettings, parseJson, type AiConfig } from './client.js';
import { htmlToMd, mdToHtml } from '../docs/html.js';
import { htmlToPdf } from '../docs/pdfHtml.js';
import * as L from '../docs/layout.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { publicBase } from '../docs/share.js';
import { AGENT_SHEET, TASK_RULES } from './sheet.js';

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
  | { type: 'none'; reason?: string };

export interface AgentWait { kind: 'reply' | 'date' | 'task' | 'info'; reason: string; since: string; remindAt?: string | null; escalateAt?: string | null; reminded?: boolean; escalated?: boolean }
const H = 3600_000;
const DOC_TRANSITIONS: Record<string, string[]> = { draft: ['review', 'final'], review: ['draft', 'final'], final: ['draft'] };
const clampH = (v: unknown, def: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(24 * 14, Math.max(0.1, n)) : def; };
/** Termin aus until: ISO-Datum/-Zeit, YYYY-MM-DD oder HH:MM (heute, sonst morgen); Zeiten ohne Zone gelten als Europe/Berlin. */
function parseUntil(v: unknown, now: Date): Date | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const berlinOffsetMin = (d: Date) => { const z = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', timeZoneName: 'shortOffset' }).formatToParts(d).find((x) => x.type === 'timeZoneName')?.value ?? 'GMT+1'; const m = z.match(/GMT([+-])(\d+)(?::(\d+))?/); return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 60; };
  const hm = s.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const local = new Date(now.getTime() + berlinOffsetMin(now) * 60_000);
    const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), Number(hm[1]), Number(hm[2])) - berlinOffsetMin(now) * 60_000);
    return d.getTime() <= now.getTime() ? new Date(d.getTime() + 86400_000) : d;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(new Date(s + 'T09:00:00Z').getTime() - berlinOffsetMin(now) * 60_000);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !/[Zz]|[+-]\d{2}:?\d{2}$/.test(s)) { const d = new Date(s + 'Z'); return isNaN(d.getTime()) ? null : new Date(d.getTime() - berlinOffsetMin(now) * 60_000); }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['note', 'actions'],
  properties: {
    note: { type: 'string', description: 'Kurze Notiz für das Protokoll: was mit den Aktionen unten veranlasst wird und warum. Nur Aktionen in der Liste werden ausgeführt.' },
    actions: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['type', 'text', 'column', 'itemId', 'to', 'subject', 'reason', 'kind', 'checkAfterHours', 'until', 'remindAfterHours', 'escalateAfterHours', 'pageId', 'title', 'folder', 'status'],
      properties: {
        type: { type: 'string', enum: ['comment', 'set_status', 'check_item', 'add_item', 'update_item', 'mail', 'read_page', 'doc_create', 'doc_update', 'doc_append', 'doc_status', 'doc_move', 'folder_create', 'doc_send_pdf', 'blocked', 'escalate', 'wait', 'none'] },
        text: { type: ['string', 'null'], description: 'comment: Log-Text; mail/doc_send_pdf: Mailtext; escalate: Text an die PL; add_item/update_item: Task-Text; doc_create/doc_update/doc_append: Seiteninhalt in Markdown (doc_update ersetzt den ganzen Inhalt); sonst null' },
        column: { type: ['string', 'null'], description: 'set_status: Zielstatus (exakt aus der Liste); sonst null' },
        itemId: { type: ['string', 'null'], description: 'check_item/update_item: itemId aus der Task-Liste; sonst null' },
        pageId: { type: ['string', 'null'], description: 'read_page/doc_update/doc_append/doc_status/doc_move/doc_send_pdf: pageId aus der Seitenliste; sonst null' },
        status: { type: ['string', 'null'], description: 'doc_status: draft, review oder final; sonst null' },
        title: { type: ['string', 'null'], description: 'doc_create: Seitentitel; doc_update: neuer Titel (optional); sonst null' },
        folder: { type: ['string', 'null'], description: 'doc_create/doc_move: Ordnername aus der Ordnerliste; folder_create: Name des neuen Ordners; sonst null' },
        to: { type: ['array', 'null'], items: { type: 'string' }, description: 'mail: Empfängeradressen; doc_send_pdf: Empfänger oder null für den Verteiler des Ordners (nur finale Seiten); sonst null' },
        subject: { type: ['string', 'null'], description: 'mail: Betreff; sonst null' },
        reason: { type: ['string', 'null'], description: 'wait: worauf genau gewartet wird (Pflicht); blocked: Grund; none: Grund; sonst null' },
        kind: { type: ['string', 'null'], description: 'wait: genau einer der Werte reply, date, task, info; sonst null' },
        checkAfterHours: { type: ['number', 'null'], description: 'wait: Stunden bis zur nächsten Prüfung; sonst null' },
        until: { type: ['string', 'null'], description: 'wait mit kind date: Zeitpunkt als YYYY-MM-DDTHH:MM (Europe/Berlin), YYYY-MM-DD oder HH:MM (heute, sonst morgen); sonst null' },
        remindAfterHours: { type: ['number', 'null'], description: 'wait mit kind reply: Stunden bis zum Nachfassen; sonst null' },
        escalateAfterHours: { type: ['number', 'null'], description: 'wait mit kind reply: Stunden bis zur Eskalation an die PL; sonst null' }
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
  const mails = await db.query(`select m.subject, m.from_addr, m.date, m.snippet, m.text_body, m.outgoing from mail_task_links l join mails m on m.id = l.mail_id where l.task_id = $1 order by m.date desc limit 6`, [task.id]);
  const members = await db.query(`select u.name, u.email, m.role, m.is_deputy, u.kind from project_members m join users u on u.id = m.user_id where m.project_id = $1`, [task.project_id]);
  const folders = await db.query(`select id, name from doc_folders where project_id = $1 order by position`, [task.project_id]);
  const pages = await db.query(`select p.id, p.title, p.status, p.updated_at, f.name as folder from doc_pages p left join doc_folders f on f.id = p.folder_id where p.project_id = $1 and p.deleted_at is null order by p.updated_at desc limit 40`, [task.project_id]);
  const pls = members.rows.filter((x: any) => x.role === 'pl' && !x.is_deputy);
  const today = now.toISOString().slice(0, 10);
  const account = await db.maybeOne<AccountRow>(`select * from mail_accounts where project_id = $1 and type = 'project' order by created_at limit 1`, [task.project_id]);
  const canMail = Boolean(m.agent_can_mail) && Boolean(account);
  // Fester Teil zuerst (KI-Sheet und Regeln, für alle Läufe gleich: Prefix-Cache), danach Name, Projekt und Schreibstil
  const system = `${AGENT_SHEET}\n\n${TASK_RULES}\n\n# Du\nDu bist „${agent.name}“, KI-Agent und Mitglied des Projekts ${task.project_key} „${task.project_name}“. Dir ist ${task.parent_id ? 'diese Aufgabe' : 'dieses Arbeitspaket'} zugewiesen; du treibst es voran wie eine zuständige Person. Mails nach außen haben Anrede und Unterschrift „${agent.name} (KI-Agent, Projekt ${task.project_key})“. ${styleText(agent.persona)}`;
  const prompt = `Heute: ${today}
${task.parent_id ? `Aufgabe ${task.project_key}-${task.number} „${task.title}“ im Arbeitspaket ${task.project_key}-${task.parent_number} „${task.parent_title}“` : `Arbeitspaket ${task.project_key}-${task.number} „${task.title}“`} · Status ${task.column_name}${task.due_date ? ` · fällig ${String(task.due_date).slice(0, 10)}` : ''}${task.subproject_name ? ` · Teilprojekt ${task.subproject_name}` : ''}${task.blocked ? ` · BLOCKIERT: ${task.blocked_reason ?? ''}` : ''}
Beschreibung: ${cut(task.description, 2000) || '–'}
Mögliche Status: ${columns.rows.map((x: any) => x.name + (x.is_done ? ' (erledigt)' : '')).join(', ')}
${subtasks.rows.length ? `Aufgaben (eigene Zuständigkeit und eigenes Log):\n${subtasks.rows.map((x: any) => `- ${task.project_key}-${x.number} „${x.title}“ · ${x.column_name}${x.is_done ? ' (erledigt)' : ''}${x.responsible_name ? ` · ${x.responsible_name}` : ''}`).join('\n')}\n` : ''}Tasks:
${items.rows.map((i: any) => `- [${i.done ? 'x' : ' '}] ${i.title} (itemId ${i.id})${i.responsible_email ? ` · extern ${i.responsible_email}` : ''}`).join('\n') || '–'}
Log (neueste zuerst):
${comments.rows.map((x: any) => `- ${new Date(x.created_at).toLocaleDateString('de-DE')} ${x.name ?? 'System'}${x.source === 'ai' ? ' (KI)' : ''}: ${cut(x.body, 400)}`).join('\n') || '–'}
Mails zum Arbeitspaket:
${mails.rows.map((x: any) => `- ${new Date(x.date).toLocaleDateString('de-DE')} ${x.outgoing ? 'AN' : 'VON'} ${x.from_addr}: ${x.subject} – ${cut(x.text_body ?? x.snippet, 500)}`).join('\n') || '–'}
Doku-Ordner: ${folders.rows.map((f: any) => f.name).join(', ') || '–'}
Doku-Seiten (neueste zuerst):
${pages.rows.map((p: any) => `- „${p.title}“ (pageId ${p.id}, ${p.folder ?? 'ohne Ordner'}, ${p.status}, ${new Date(p.updated_at).toLocaleDateString('de-DE')})`).join('\n') || '–'}
Projektmitglieder: ${members.rows.map((x: any) => `${x.name} <${x.email}>${x.role === 'pl' ? (x.is_deputy ? ' (PL-Stellvertretung)' : ' (PL)') : ''}${x.kind === 'agent' ? ' (Agent)' : ''}`).join(', ')}
Deine Rechte: Mails ${canMail ? 'direkt senden (bis zu drei je Lauf, auch mit PDF einer Doku-Seite)' : 'nur als Entwurf zur Freigabe'}${account ? '' : ' (kein Projektkonto)'}; Status setzen; Tasks abhaken, ergänzen, umformulieren; Doku wie ein Mitglied: Seiten lesen (read_page), anlegen (doc_create), Inhalt ersetzen (doc_update), ergänzen (doc_append), Status setzen (doc_status: draft, review${m.can_finalize ? ', final' : '; final nur mit Recht „Final setzen“, das du nicht hast'}), verschieben (doc_move), Ordner anlegen (folder_create); PDF einer Seite per Mail senden (doc_send_pdf${m.can_finalize ? ', auch an den Verteiler des Ordners' : ''}); Log schreiben; Blockade melden; an PL eskalieren.
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
      actions = Array.isArray(j.actions) ? j.actions.slice(0, 8) : [];
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
    let waited = false;
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
        const raw: string[] = useList ? (page.distribution_list?.length ? page.distribution_list : page.settings?.recipients ?? []) : Array.isArray(a.to) ? a.to : [];
        const to = raw.map((x) => String(x).trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)).slice(0, 10);
        if (!page) errors.push('PDF-Versand verworfen: pageId unbekannt');
        else if (useList && page.status !== 'final') errors.push(`Versand an den Verteiler nur für finale Seiten („${page.title}“ ist ${page.status})`);
        else if (useList && !m.can_finalize) errors.push('Versand an den Verteiler erfordert das Recht „Final setzen / Versand“');
        else if (useList && !to.length) errors.push(`Kein Verteiler am Ordner oder an der Seite „${page.title}“`);
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
        else if (!account) errors.push('Mail nicht gesendet: kein Projektkonto angebunden');
        else {
          mailsSent++;
          if (canMail) {
            try {
              await mail.sendFromAccount(account, { to, subject: a.subject, text: a.text, taskId: task.id, userId: agent.id, projectId: task.project_id });
              applied.push({ type: 'mail', to, subject: a.subject, text: a.text });
            } catch (e: any) {
              const msg = `Mail an ${to.join(', ')} nicht gesendet: ${String(e?.message ?? e).slice(0, 200)}`;
              errors.push(msg);
              await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [task.id, agent.id, msg]);
            }
          } else {
            await db.query(`insert into mail_drafts (account_id, task_id, project_id, user_id, to_addrs, cc_addrs, subject, body, status) values ($1,$2,$3,$4,$5,'[]',$6,$7,'pending_approval')`, [account.id, task.id, task.project_id, agent.id, JSON.stringify(to), a.subject, a.text]);
            for (const pl of pls) await notify(db, { userId: pl.user_id ?? (await db.one(`select id from users where email = $1`, [pl.email])).id, projectId: task.project_id, type: 'draft.review', title: `Mail-Entwurf von ${agent.name} zur Freigabe`, body: a.subject, link: `/projekte/${task.project_id}/mail/freigabe` });
            applied.push({ type: 'mail', to, subject: a.subject, text: `[Entwurf zur Freigabe] ${a.text}` });
          }
        }
      } else if (a.type === 'blocked' && a.reason) {
        await db.query(`update tasks set blocked = true, blocked_reason = $2 where id = $1`, [task.id, a.reason]);
        await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [task.id, agent.id, `Blockiert gemeldet: ${a.reason}`]);
        for (const pl of pls) await notify(db, { userId: (await db.one(`select id from users where email = $1`, [pl.email])).id, projectId: task.project_id, type: 'escalation', title: `Blockiert (Agent): ${task.title}`, body: a.reason, link: `/projekte/${task.project_id}/board?task=${task.id}` });
        applied.push(a);
      } else if (a.type === 'escalate' && a.text) {
        await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [task.id, agent.id, `An die Projektleitung: ${a.text}`]);
        for (const pl of pls) await notify(db, { userId: (await db.one(`select id from users where email = $1`, [pl.email])).id, projectId: task.project_id, type: 'escalation', title: `${agent.name} braucht eine Entscheidung: ${task.title}`, body: a.text, link: `/projekte/${task.project_id}/board?task=${task.id}` });
        applied.push(a);
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
    case 'reminder_due': return 'Nachfassen fällig: die Rückmeldung ist bisher nicht eingegangen. Fasse jetzt nach (Erinnerung per Mail oder Log) oder begründe, warum nicht; setze danach erneut wait.';
    case 'escalation_due': return 'Eskalation fällig: trotz Nachfassen keine Rückmeldung. Eskaliere jetzt an die Projektleitung (escalate) oder begründe, warum du weiter wartest.';
    case 'due_soon': return 'Die Fälligkeit des Arbeitspakets ist nah.';
    case 'overdue': return 'Das Arbeitspaket ist überfällig.';
    case 'manual': return 'Die Projektleitung hat den Lauf manuell gestartet.';
    default: return trigger;
  }
}

/** Ereignislauf: der dem Arbeitspaket zugewiesene Agent läuft sofort (von Routen über queueAgentRun ausgelöst). */
export async function runForTask(db: Db, mail: MailService, fetchFn: typeof fetch, taskId: string, trigger: string): Promise<AgentRunResult | null> {
  const t = await db.maybeOne(`select t.responsible_user_id, t.agent_paused, c.is_done from tasks t join board_columns c on c.id = t.column_id where t.id = $1 and t.deleted_at is null and t.archived_at is null`, [taskId]);
  if (!t || t.agent_paused || t.is_done || !t.responsible_user_id) return null;
  const agent = await db.maybeOne(`select id, name, org_id, persona from users where id = $1 and kind = 'agent' and active`, [t.responsible_user_id]);
  if (!agent) return null;
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
    const settings = await orgAiSettings(db, agent.org_id);
    const used = await db.one(`select count(*)::int as c from agent_runs where agent_user_id = $1 and created_at >= $2::date`, [agent.id, now.toISOString().slice(0, 10)]);
    let budget = Math.max(0, settings.agentDailyBudget - used.c);
    const tasks = await db.query(
      `select t.id, t.due_date, t.agent_next_check_at, t.agent_wait from tasks t join projects p on p.id = t.project_id join board_columns c on c.id = t.column_id
       where t.responsible_user_id = $1 and t.deleted_at is null and t.archived_at is null and not c.is_done and not t.agent_paused and p.status = 'active' order by t.due_date nulls last`, [agent.id]);
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
