import type { User } from '@projekttool/shared';
import type { Db } from '../db.js';
import type { MailService } from '../mail/service.js';
import type { AccountRow } from '../mail/types.js';
import { audit } from '../audit.js';
import { notify } from '../notify.js';
import { canSeeSubproject, getMembership, getViewRights, visibleSubprojectSql } from '../rights.js';
import { reSubject } from '../mail/origin.js';
import { linkMailToTask } from '../mail/link.js';
import { aiConfigFor, complete, parseJson, type AiConfig } from './client.js';
import { effectiveAgentPolicy } from './agentPolicy.js';
import { audienceOf, guardOutbound, recordCheck } from '../outbound.js';
import { externalWindow, inWindow, nextWindowStart } from './web.js';
import { AGENT_SHEET, MAIL_RULES } from './sheet.js';
import { EFFECTIVE_JOINS, EFFECTIVE_RESPONSIBLE_SQL, agentChatMessage, createPlannedEvent, createPlannedTask, findTaskByRef, fmtWhen, resolvePerson, ymd, type PlanActor } from './plan.js';
import { parseUntil, styleText } from './agent.js';
import { queueAgentRun, queueMailAi } from './agentEvents.js';
import { checkHint } from '../outbound.js';
import { USE_LATERAL } from '../mail/accounts.js';
import { handleOpenPoints } from './mailInquiry.js';

/**
 * Mail-KI an einer Ansicht.
 * Es handelt immer ein Agent (keine „Projekt-KI“ im Auftrag einer Person). Was er darf, folgt seiner Rolle (mailModeOf):
 * process: Der Agent ist (stellvertretende) Projektleitung und legt direkt mit seinen Rechten an: Arbeitspaket/Aufgabe mit
 *   Ursprungsmail, Zuweisung (auch an Agenten), Termin, Antwortentwurf, Ablage der Mail (Freigabe agent.mail).
 * triage: Der Agent ist Mitglied und schlägt dieselben Aktionen vor; ausgeführt wird erst, wenn eine Person zustimmt, und dann
 *   mit deren Rechten (Freigabe mail.triage). Auf Anfrage („Vorschläge zur Mail“) antwortet er der Person per Chat.
 * Welcher Agent: der Projektagent (projects.agent_user_id, dritte PL-Rolle) für Projektkonten, wenn agent_mail nicht aus ist
 *   (triage = nur Vorschläge, auch als PL); sonst der Agent an der Ansicht (Ordner „KI Bearbeiten“ oder beliebige Ansicht).
 * Offene Punkte (openPoints) gehen an die Mail-Rückfrage (mailInquiry.ts): Frage an die PL, ins Projekt, beim Absender oder nur Log.
 * Jede Mail wird je Projekt und Art höchstens einmal bearbeitet (eindeutiger Index), Läufe zählen gegen das Tagesbudget.
 * Vor jedem Lauf gelten die KI-Freigaben des Agenten (agent.mail bzw. mail.triage): gesperrt heißt
 * übersprungen mit Begründung, ein erreichtes Tagesbudget lässt den Lauf warten.
 */
export type MailAiAction = { type: 'create_ap' | 'create_aufgabe' | 'link' | 'create_event' | 'reply_draft' | 'move' | 'none'; title?: string | null; text?: string | null; ref?: string | null; subproject?: string | null; responsible?: string | null; startDate?: string | null; dueDate?: string | null; items?: string[] | null; startsAt?: string | null; endsAt?: string | null; location?: string | null; folder?: string | null; reason?: string | null };
export type StoredAction = MailAiAction & { status: 'done' | 'error' | 'pending' | 'approved' | 'rejected'; result?: { ref?: string; taskId?: string; meetingId?: string; draftId?: string; folder?: string; error?: string; /** Fundstellen der Außenprüfung am Antwortentwurf (Hinweis) */ hints?: number; /** vom Agenten gesendet */ sent?: boolean; /** Versand geplant (Arbeitszeitfenster) */ scheduled?: string }; decidedBy?: string | null };

const TYPES = ['create_ap', 'create_aufgabe', 'link', 'create_event', 'reply_draft', 'move', 'none'];
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'openPoints', 'actions'],
  properties: {
    summary: { type: 'string', description: 'Ein Satz: was veranlasst bzw. vorgeschlagen wird' },
    openPoints: { type: 'array', items: { type: 'string' }, description: 'Stichpunkte, was unklar ist oder fehlt, um die Mail zu bearbeiten; leer, wenn alles klar ist' },
    actions: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['type', 'title', 'text', 'ref', 'subproject', 'responsible', 'startDate', 'dueDate', 'items', 'startsAt', 'endsAt', 'location', 'folder', 'reason'],
      properties: {
        type: { type: 'string', enum: TYPES },
        title: { type: 'string', description: 'create_ap/create_aufgabe/create_event: Titel; sonst leer' },
        text: { type: 'string', description: 'create_ap/create_aufgabe/create_event: Beschreibung; link: Log-Notiz; reply_draft: Antworttext; sonst leer' },
        ref: { type: 'string', description: 'create_aufgabe: Kennung des Arbeitspakets; link: Kennung; sonst leer' },
        subproject: { type: 'string', description: 'create_ap: Name des Teilprojekts oder leer' },
        responsible: { type: 'string', description: 'create_ap/create_aufgabe: E-Mail eines Mitglieds oder leer' },
        startDate: { type: 'string', description: 'YYYY-MM-DD oder leer' },
        dueDate: { type: 'string', description: 'YYYY-MM-DD oder leer' },
        items: { type: 'array', items: { type: 'string' }, description: 'create_ap/create_aufgabe: Tasks; sonst leer' },
        startsAt: { type: 'string', description: 'create_event: YYYY-MM-DDTHH:MM; sonst leer' },
        endsAt: { type: 'string', description: 'create_event: YYYY-MM-DDTHH:MM oder leer (eine Stunde)' },
        location: { type: 'string', description: 'create_event: Ort oder leer' },
        folder: { type: 'string', description: 'move: Archiv, In Arbeit oder ein Ordner aus der Liste; sonst leer' },
        reason: { type: 'string', description: 'none: Grund; sonst leer' }
      } } }
  }
};

const cut = (s: string | null | undefined, n: number) => { const t = (s ?? '').trim(); return t.length > n ? t.slice(0, n) + ' …' : t; };
const d10 = (v: any) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : '');

/** Neue Mail in Ansichten mit Mail-KI: Läufe anlegen und starten (vom Sync aufgerufen; autoLinked = Antwort, die schon einem Arbeitspaket zugeordnet ist). */
export async function enqueueForNewMail(db: Db, mailId: string, viewIds: string[], opts: { outgoing: boolean; autoLinked: boolean }): Promise<void> {
  if (opts.outgoing || !viewIds.length) return;
  // Agent je Ansicht: der Projektagent für Projektkonten (agent_mail nicht aus), sonst der Agent an der Ansicht; ohne Agent passiert nichts
  const views = await db.query(
    `select v.id, v.project_id, v.ai_process, p.org_id, p.agent_mail,
       case when p.agent_user_id is not null and p.agent_mail in ('process','triage') and u.use = 'project' then p.agent_user_id else v.agent_user_id end as agent_id,
       (p.agent_user_id is not null and p.agent_mail in ('process','triage') and u.use = 'project') as by_project_agent
     from mail_views v join projects p on p.id = v.project_id join mail_account_uses u on u.id = v.use_id
     where v.id = any($1::uuid[]) and p.status = 'active'
       and (v.agent_user_id is not null or (p.agent_user_id is not null and p.agent_mail in ('process','triage') and u.use = 'project'))
     order by (p.agent_user_id is not null and p.agent_mail in ('process','triage') and u.use = 'project') desc, v.ai_process desc`, [viewIds]);
  const done = new Set<string>();
  for (const v of views.rows) {
    if (done.has(v.project_id)) continue;
    const mode = await mailModeOf(db, v.project_id, v.agent_id, v.by_project_agent ? v.agent_mail : null);
    if (!mode) continue;
    if (mode === 'triage' && opts.autoLinked) continue;
    const r = await db.maybeOne(`insert into mail_ai_runs (org_id, project_id, view_id, mail_id, mode, actor_user_id, agent_user_id) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing returning id`,
      [v.org_id, v.project_id, v.id, mailId, mode, mode === 'process' ? v.agent_id : null, v.agent_id]);
    done.add(v.project_id);
    if (r) queueMailAi(r.id);
  }
}

/**
 * Wie ein Agent Mails bearbeitet: als (stellvertretende) Projektleitung legt er direkt an (process), als Mitglied schlägt er vor
 * (triage); der Projektagent mit agent_mail = triage schlägt nur vor. null = kein aktiver Agent im Projekt.
 */
export async function mailModeOf(db: Db, projectId: string, agentId: string | null, projectAgentMail: string | null): Promise<'process' | 'triage' | null> {
  if (!agentId) return null;
  const m = await db.maybeOne(`select pm.role from project_members pm join users u on u.id = pm.user_id where pm.project_id = $1 and pm.user_id = $2 and u.kind = 'agent' and u.active`, [projectId, agentId]);
  if (!m) return null;
  return m.role === 'pl' && projectAgentMail !== 'triage' ? 'process' : 'triage';
}

/** Agent, der im Projekt zu Mails dieses Kontos vorschlägt und per Chat antwortet: Projektagent, sonst der Agent an einer Ansicht des Kontos. */
export async function suggestAgent(db: Db, projectId: string, accountId: string): Promise<{ id: string; name: string; org_id: string; role: string } | null> {
  return db.maybeOne(
    `select u.id, u.name, u.org_id, pm.role from users u join project_members pm on pm.user_id = u.id and pm.project_id = $1
     where u.kind = 'agent' and u.active and (u.id = (select agent_user_id from projects where id = $1) or u.id in (select agent_user_id from mail_views where project_id = $1 and account_id = $2 and agent_user_id is not null))
     order by (u.id = (select agent_user_id from projects where id = $1)) desc limit 1`, [projectId, accountId]);
}

/** Kurzform einer Aktion für Chat und Meldung. */
export function actionLabel(a: MailAiAction): string {
  switch (a.type) {
    case 'create_ap': return `Arbeitspaket „${a.title ?? ''}“${a.responsible ? ` · ${a.responsible}` : ''}${a.dueDate ? ` · fällig ${a.dueDate}` : ''}`;
    case 'create_aufgabe': return `Aufgabe „${a.title ?? ''}“ in ${a.ref ?? '?'}${a.dueDate ? ` · fällig ${a.dueDate}` : ''}`;
    case 'link': return `Zu ${a.ref ?? '?'}${a.text ? `: ${cut(a.text, 120)}` : ''}`;
    case 'create_event': return `Termin „${a.title ?? ''}“ ${(a.startsAt ?? '').replace('T', ' ')}${a.location ? ` · ${a.location}` : ''}`;
    case 'reply_draft': return `Antwort${(a as StoredAction).result?.sent || (a as StoredAction).result?.scheduled ? '' : 'entwurf'}: ${cut(String(a.text ?? '').replace(/\s+/g, ' '), 140)}`;
    case 'move': return `Ablage: ${a.folder ?? 'Archiv'}`;
    default: return `Nichts zu tun${a.reason ? `: ${a.reason}` : ''}`;
  }
}

/** Liegengebliebene Läufe (Neustart, Tagesbudget) nachholen; hängende Läufe nach 15 Minuten erneut einreihen. */
export async function runQueuedMailAi(db: Db, mail: MailService, fetchFn: typeof fetch): Promise<void> {
  await db.query(`update mail_ai_runs set status = 'queued' where status = 'running' and started_at < now() - interval '15 minutes'`);
  const rows = await db.query(`select id from mail_ai_runs where status = 'queued' and created_at < now() - interval '1 minute' order by created_at limit 10`);
  for (const r of rows.rows) await runMailAi(db, mail, fetchFn, r.id);
}

async function userRow(db: Db, id: string | null): Promise<User | null> {
  if (!id) return null;
  const u = await db.maybeOne(`select * from users where id = $1 and active`, [id]);
  return u ? ({ id: u.id, orgId: u.org_id, email: u.email, name: u.name, globalRole: u.global_role, active: u.active, kind: u.kind } as User) : null;
}

export async function runMailAi(db: Db, mailSvc: MailService, fetchFn: typeof fetch, runId: string): Promise<void> {
  const run = await db.maybeOne(`update mail_ai_runs set status = 'running', started_at = now() where id = $1 and status = 'queued' returning *`, [runId]);
  if (!run) return;
  const finish = (status: string, patch: { summary?: string | null; actions?: StoredAction[]; error?: string | null; inputTokens?: number; outputTokens?: number; openPoints?: string[] } = {}) =>
    db.query(`update mail_ai_runs set status = $2, summary = coalesce($3, summary), actions = coalesce($4::jsonb, actions), error = $5, input_tokens = input_tokens + $6, output_tokens = output_tokens + $7, open_points = coalesce($8::jsonb, open_points), finished_at = now() where id = $1`,
      [run.id, status, patch.summary ?? null, patch.actions ? JSON.stringify(patch.actions) : null, patch.error ?? null, patch.inputTokens ?? 0, patch.outputTokens ?? 0, patch.openPoints ? JSON.stringify(patch.openPoints) : null]);
  const requeue = (error: string) => db.query(`update mail_ai_runs set status = 'queued', error = $2 where id = $1`, [run.id, error]);
  try {
    const project = await db.maybeOne(`select * from projects where id = $1 and status = 'active'`, [run.project_id]);
    const m = await db.maybeOne(`select m.*, ux.use, ux.use_user_id, a.address as account_address from mails m join mail_accounts a on a.id = m.account_id ${USE_LATERAL('a', '$2::uuid')} where m.id = $1`, [run.mail_id, run.project_id]);
    const view = run.view_id ? await db.maybeOne(`select * from mail_views where id = $1`, [run.view_id]) : null;
    if (!project || !m || !view) return void (await finish('skipped', { error: 'Projekt, Mail oder Ansicht nicht mehr vorhanden' }));

    let header: string; let agent: any = null;
    let gate: Awaited<ReturnType<typeof aiConfigFor>>;
    // Nur Agenten: als (stellvertretende) PL legt der Agent direkt an (Freigabe agent.mail), als Mitglied schlägt er vor (mail.triage)
    const asAgent = run.mode === 'process';
    agent = await db.maybeOne(`select u.id, u.name, u.org_id, u.persona, pm.role from users u join project_members pm on pm.user_id = u.id and pm.project_id = $2 where u.id = $1 and u.kind = 'agent' and u.active`, [run.agent_user_id, project.id]);
    if (!agent) return void (await finish('skipped', { error: 'Agent nicht aktiv oder kein Mitglied' }));
    if (asAgent) {
      if (agent.role !== 'pl') return void (await finish('skipped', { error: `${agent.name} ist nicht mehr (stellvertretende) Projektleitung und schlägt nur noch vor` }));
      gate = await aiConfigFor(db, { userId: agent.id, projectId: project.id, feature: 'agent.mail' });
      if (!gate.cfg) return void (await (gate.decision.stage === 'budget' ? requeue(`wartet: ${gate.decision.reason}`) : finish('skipped', { error: gate.decision.publicReason })));
      header = `# Du\nDu bist „${agent.name}“, KI-Agent und ${project.agent_user_id === agent.id ? 'Projektagent (stellvertretende Projektleitung)' : 'stellvertretende Projektleitung'} von ${project.key} „${project.name}“. Neue Mail in einer Ansicht des Projekts; was du listest, wird sofort angelegt. Was unklar ist, nennst du in openPoints; das System fragt damit nach. ${styleText(agent.persona)}`;
    } else {
      gate = await aiConfigFor(db, { userId: agent.id, projectId: project.id, feature: 'mail.triage' });
      if (!gate.cfg) return void (await (gate.decision.stage === 'budget' ? requeue(`wartet: ${gate.decision.reason}`) : finish('skipped', { error: gate.decision.publicReason })));
      header = `# Du\nDu bist „${agent.name}“, KI-Agent, und betreust die Mail-Ansicht „${view.name}“ im Projekt ${project.key} „${project.name}“. Du schlägst vor; ausgeführt wird erst, wenn eine Person zustimmt. ${styleText(agent.persona)}`;
    }

    const cfg = gate.cfg;
    const now = new Date();
    const actorForVis = run.mode === 'process' ? run.actor_user_id : agent.id;
    const plIds = async () => (await db.query(`select m.user_id from project_members m join users u on u.id = m.user_id where m.project_id = $1 and m.role = 'pl' and u.kind <> 'agent' and u.active`, [project.id])).rows.map((x: any) => x.user_id as string);
    const subprojects = await db.query(`select name, start_date, end_date from subprojects s where project_id = $1 and (not restricted or responsible_user_id = $2) order by position`, [project.id, actorForVis]);
    const tasks = await db.query(
      `select t.number, t.title, t.due_date, t.parent_id, pt.number as parent_number, c.name as column_name, eu.name as resp, s.name as sp from tasks t join board_columns c on c.id = t.column_id ${EFFECTIVE_JOINS} left join users eu on eu.id = (${EFFECTIVE_RESPONSIBLE_SQL})
       where t.project_id = $1 and t.deleted_at is null and t.archived_at is null and not c.is_done and ${visibleSubprojectSql(2)} order by t.updated_at desc nulls last limit 60`, [project.id, actorForVis]);
    const events = await db.query(`select title, starts_at from meetings where project_id = $1 and starts_at >= $2 and starts_at < $3 order by starts_at limit 20`, [project.id, new Date(now.getTime() - 86400_000), new Date(now.getTime() + 60 * 86400_000)]);
    const members = await db.query(`select u.name, u.email, u.kind, u.persona, m.role, m.is_deputy from project_members m join users u on u.id = m.user_id where m.project_id = $1 and u.active order by u.kind, u.name`, [project.id]);
    const account = await db.one<AccountRow>(`select * from mail_accounts where id = $1`, [m.account_id]);
    const folders = await mailSvc.providerFor(account).listFolders(account).catch(() => []);
    const system = `${AGENT_SHEET}\n\n${MAIL_RULES}\n\n${header}`;
    const prompt = `Heute: ${now.toISOString().slice(0, 10)} (${now.toLocaleDateString('de-DE', { weekday: 'long', timeZone: 'Europe/Berlin' })})
Mail von ${m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr} an ${(m.to_json ?? []).join(', ')}${(m.cc_json ?? []).length ? `, Cc ${m.cc_json.join(', ')}` : ''}, ${fmtWhen(new Date(m.date))}
Betreff: ${m.subject ?? ''}
${cut(m.text_body ?? m.snippet, 6000) || '(kein Text)'}

Teilprojekte: ${subprojects.rows.map((x: any) => `„${x.name}“${x.start_date || x.end_date ? ` (${d10(x.start_date)} – ${d10(x.end_date)})` : ''}`).join(', ') || '–'}
Offene Arbeitspakete und Aufgaben (zuletzt geändert zuerst):
${tasks.rows.map((x: any) => `- ${project.key}-${x.number} „${x.title}“${x.parent_id ? ` (Aufgabe in ${project.key}-${x.parent_number})` : ''} · ${x.column_name}${x.sp ? ` · ${x.sp}` : ''}${x.resp ? ` · ${x.resp}` : ''}${x.due_date ? ` · fällig ${d10(x.due_date)}` : ''}`).join('\n') || '–'}
Kalender: ${events.rows.map((x: any) => `${x.title} ${fmtWhen(new Date(x.starts_at))}`).join(', ') || '–'}
Mitglieder: ${members.rows.map((x: any) => `${x.name} <${x.email}>${x.role === 'pl' ? (x.is_deputy ? ' (PL-Stellvertretung)' : ' (PL)') : ''}${x.kind === 'agent' ? ` (KI-Agent${x.persona ? `: ${cut(x.persona, 80)}` : ''})` : ''}`).join(', ')}
Ordner des Kontos: ${['Archiv', 'In Arbeit', ...folders.filter((f: any) => !f.specialUse || f.specialUse === 'inbox').map((f: any) => f.path)].filter((x, i, a) => a.indexOf(x) === i).join(', ')}`;
    const r = await complete(cfg, fetchFn, { system, prompt, maxTokens: cfg.enableThinking === true ? 6000 : 2000, schema: SCHEMA });
    const j = parseJson<{ summary?: string; openPoints?: string[]; actions?: MailAiAction[] }>(r.text);
    const proposed = (Array.isArray(j.actions) ? j.actions : []).filter((a) => a && TYPES.includes(a.type)).slice(0, 8);
    const summary = cut(String(j.summary ?? ''), 600);
    const openPoints = (Array.isArray(j.openPoints) ? j.openPoints : []).map((x) => cut(String(x ?? ''), 200)).filter(Boolean).slice(0, 6);
    const openText = openPoints.length ? ` · Offen: ${openPoints.join('; ')}` : '';
    let stored: StoredAction[];
    let inquiry: Awaited<ReturnType<typeof handleOpenPoints>> = { action: 'none' };
    if (run.mode === 'process') {
      const actor = (await userRow(db, run.actor_user_id))!;
      stored = await applyActions(db, mailSvc, { run, project, mail: m, view, actor, cfg, fetchFn, now }, proposed);
      const taskId = stored.find((x) => x.status === 'done' && x.result?.taskId)?.result?.taskId ?? null;
      // Offene Punkte: der Agent fragt nach (Mail-Rückfrage)
      inquiry = await handleOpenPoints(db, { project, mail: m, taskId, asker: agent, actorId: null, openPoints });
      // Info an die PL als Direktnachricht des Agenten: was angelegt wurde, was nicht ging, offene Punkte, Entwürfe zur Freigabe oder gesendete Antworten
      const recipients = await plIds();
      const lines = stored.filter((x) => x.type !== 'none').map((x, i) => `${i + 1}) ${actionLabel(x)}${x.status === 'error' ? ` – nicht ausgeführt: ${x.result?.error ?? 'Fehler'}` : x.type === 'reply_draft' ? (x.result?.sent ? ' – gesendet' : x.result?.scheduled ? ` – Versand geplant ${x.result.scheduled}` : ' – Entwurf wartet auf Freigabe (Mail › Freigaben)') : ''}`);
      const body = `Mail „${cut(m.subject, 80)}“ (von ${m.from_name ?? m.from_addr}) bearbeitet: ${summary}${lines.length ? `\n${lines.join('\n')}` : ''}${(inquiry.action === 'log' || inquiry.action === 'none') && openPoints.length ? `\nOffen: ${openPoints.join('; ')}` : ''}\nMail: /projekte/${project.id}/mail/m/${m.id}`;
      for (const u of recipients) await agentChatMessage(db, agent, { userId: u }, body, project.id);
      await db.query(`insert into agent_runs (org_id, agent_user_id, project_id, task_id, trigger, status, reasoning, actions, input_tokens, output_tokens) values ($1,$2,$3,$4,'mail_process','ok',$5,$6,$7,$8)`,
        [project.org_id, agent.id, project.id, taskId, `Mail bearbeitet: ${stored.filter((x) => x.status === 'done' && x.type !== 'none').length} Aktionen${openPoints.length ? `, ${openPoints.length} offene Punkte` : ''}`, JSON.stringify(stored.map((x) => ({ type: x.type, status: x.status }))), r.inputTokens, r.outputTokens]);
    } else {
      stored = proposed.map((a) => ({ ...clean(a), status: 'pending' as const }));
      const owners = m.use === 'personal' && m.use_user_id ? [m.use_user_id] : await plIds();
      const n = stored.filter((x) => x.type !== 'none').length;
      if (run.actor_user_id) {
        // Auf Anfrage einer Person („Vorschläge zur Mail“): die Antwort kommt als Direktnachricht des Agenten
        const lines = stored.filter((x) => x.type !== 'none').map((x, i) => `${i + 1}) ${actionLabel(x)}`);
        const body = n
          ? `Zu „${cut(m.subject, 80)}“ (von ${m.from_name ?? m.from_addr}) schlage ich vor:\n${lines.join('\n')}${openPoints.length ? `\nOffen: ${openPoints.join('; ')}` : ''}\nAnnehmen oder verwerfen an der Mail: /projekte/${project.id}/mail/m/${m.id}`
          : `Zu „${cut(m.subject, 80)}“ (von ${m.from_name ?? m.from_addr}) schlage ich nichts vor: ${summary || 'nichts zu tun'}${openPoints.length ? `\nOffen: ${openPoints.join('; ')}` : ''}`;
        await agentChatMessage(db, agent, { userId: run.actor_user_id }, body, project.id);
      } else if (n || openPoints.length) {
        // Vorschläge haben noch kein Arbeitspaket: offene Punkte stehen in der Meldung, die Frage folgt erst mit der Annahme
        for (const u of owners) await notify(db, { userId: u, projectId: project.id, type: 'mail.ai', title: `${agent.name}: ${n} Vorschl${n === 1 ? 'ag' : 'äge'} zu „${cut(m.subject, 60)}“`, body: `${summary}${openText}`, link: `/projekte/${project.id}/mail/m/${m.id}`, dedupeKey: null });
      }
      // Für Budget und Übersicht der Agentenläufe: ohne Inhalt aus der Mail (die Läufe sehen alle Mitglieder, die Mail ggf. nicht)
      await db.query(`insert into agent_runs (org_id, agent_user_id, project_id, task_id, trigger, status, reasoning, actions, input_tokens, output_tokens) values ($1,$2,$3,null,'mail_triage','ok',$4,$5,$6,$7)`,
        [project.org_id, agent.id, project.id, `Mail-Vorschläge: ${n}`, JSON.stringify(stored.map((x) => ({ type: x.type }))), r.inputTokens, r.outputTokens]);
    }
    const failed = stored.filter((x) => x.status === 'error');
    await finish(failed.length ? 'error' : 'ok', { summary, actions: stored, openPoints, error: failed.length ? failed.map((x) => `${x.type}: ${x.result?.error}`).join(' | ') : null, inputTokens: r.inputTokens, outputTokens: r.outputTokens });
    await audit(db, { orgId: project.org_id, projectId: project.id, userId: agent.id, action: run.mode === 'process' ? 'mail.ai_process' : 'mail.ai_triage', objectType: 'mail', objectId: m.id, details: { runId: run.id, actions: stored.map((x) => `${x.type}:${x.status}`), openPoints: openPoints.length, inquiry: inquiry.action, profile: cfg.name, model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens } });
  } catch (e: any) {
    await finish('error', { error: String(e?.message ?? e).slice(0, 300) });
  }
}

interface Ctx { run: any; project: any; mail: any; view: any; actor: User; /** nur im Lauf des Agenten: für Außenprüfung und autonomen Versand */ cfg?: AiConfig; fetchFn?: typeof fetch; now?: Date }

const clean = (a: MailAiAction): MailAiAction => Object.fromEntries(Object.entries(a).filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))) as MailAiAction;

/** Aktionen ausführen (Agent als PL direkt oder freigegebener Vorschlag), mit den Rechten von ctx.actor. */
export async function applyActions(db: Db, svc: MailService, ctx: Ctx, actions: MailAiAction[]): Promise<StoredAction[]> {
  const out: StoredAction[] = [];
  const state = { taskId: null as string | null };
  for (const a of actions) {
    try {
      const result = await applyOne(db, svc, ctx, a, state);
      out.push({ ...clean(a), status: 'done', result });
    } catch (e: any) {
      out.push({ ...clean(a), status: 'error', result: { error: String(e?.message ?? e).slice(0, 300) } });
    }
  }
  return out;
}

class ActionError extends Error {}
const fail = (msg: string): never => { throw new ActionError(msg); };

export async function applyOne(db: Db, svc: MailService, ctx: Ctx, a: MailAiAction, state: { taskId: string | null }): Promise<StoredAction['result']> {
  const { project, mail, view, actor } = ctx;
  const membership = await getMembership(db, project.id, actor.id);
  if (!membership || membership.role === 'reader') fail('Keine Schreibrechte im Projekt');
  const rights = await getViewRights(db, view.id, actor, membership);
  const asAgent = actor.kind === 'agent';
  const pa: PlanActor = { id: actor.id, name: actor.name, orgId: project.org_id, role: membership!.role, label: asAgent ? `${actor.name} (${project.agent_user_id === actor.id ? 'Projektagent' : 'KI-Agent'})` : actor.name, isAgent: asAgent };
  const by = asAgent ? `${project.agent_user_id === actor.id ? 'Projektagent' : 'Agent'} ${actor.name}` : `Vorschlag von ${ctx.run.agent_name ?? 'Agent'}, angenommen von ${actor.name}`;
  // Inhalt ins Projekt: im Ordner-Modus hat der Auftraggeber zugestimmt (Kopie), sonst nur verknüpft
  const copied = ctx.run.mode === 'process';
  const linkMail = (taskId: string, origin: boolean) => linkMailToTask(db, { mailId: mail.id, taskId, copied, linkedBy: actor.id, origin, actorId: actor.id, logged: true });
  // Vorschläge zu Mails aus einem persönlichen Konto nimmt nur der Eigentümer an (Inhalt würde sonst ins Projekt gelangen)
  if (ctx.run.mode === 'triage' && mail.use === 'personal' && mail.use_user_id !== actor.id && a.type !== 'none') fail('Vorschläge zu Mails aus einem persönlichen Konto nimmt nur der Eigentümer an');
  const title = String(a.title ?? '').trim().slice(0, 200);
  const start = ymd(a.startDate); const due = ymd(a.dueDate);
  if (start === undefined || due === undefined) fail('Datum nicht als YYYY-MM-DD');
  switch (a.type) {
    case 'create_ap':
    case 'create_aufgabe': {
      if (!rights.canCreateTask) fail('Recht „Arbeitspaket erzeugen“ an der Ansicht fehlt');
      if (!title) fail('Titel fehlt');
      const who = await resolvePerson(db, project.id, pa, a.responsible);
      if ('error' in who) fail(who.error);
      const person = who as Exclude<typeof who, { error: string }>;
      let parentId: string | null = null; let subprojectId: string | null = null;
      if (a.type === 'create_aufgabe') {
        const parent = await findTaskByRef(db, project.id, a.ref);
        if (!parent || parent.parent_id) fail(`Arbeitspaket ${a.ref ?? ''} nicht gefunden`);
        if (!(await canSeeSubproject(db, actor.id, parent.subproject_id))) fail('Teilprojekt ist eingeschränkt sichtbar');
        parentId = parent.id; subprojectId = parent.subproject_id;
      } else if (a.subproject) {
        const sp = await db.maybeOne(`select id from subprojects where project_id = $1 and lower(name) = lower($2)`, [project.id, String(a.subproject).trim()]);
        if (!sp) fail(`Teilprojekt „${a.subproject}“ gibt es nicht`);
        if (!(await canSeeSubproject(db, actor.id, sp.id))) fail('Teilprojekt ist eingeschränkt sichtbar');
        subprojectId = sp.id;
      }
      const dup = await db.maybeOne(`select t.number from tasks t join board_columns c on c.id = t.column_id where t.project_id = $1 and t.deleted_at is null and t.archived_at is null and not c.is_done and lower(t.title) = lower($2) and t.parent_id is not distinct from $3::uuid`, [project.id, title, parentId]);
      if (dup) fail(`„${title}“ gibt es schon (${project.key}-${dup.number})`);
      const t = await createPlannedTask(db, pa, { projectId: project.id, projectKey: project.key, title, description: a.text, parentId, subprojectId, startDate: start, dueDate: due, responsibleUserId: person.userId, responsibleEmail: person.email, responsibleKind: person.kind, items: a.items });
      await linkMail(t.id, true);
      await db.query(`insert into task_comments (task_id, user_id, body, source, mail_id) values ($1,$2,$3,'ai',$4)`, [t.id, actor.id, `Angelegt aus Mail „${mail.subject ?? ''}“ von ${mail.from_name ?? mail.from_addr} (${by})`, mail.id]);
      state.taskId ??= t.id;
      return { ref: `${project.key}-${t.number}`, taskId: t.id };
    }
    case 'link': {
      if (!rights.canCreateTask) fail('Recht „Arbeitspaket erzeugen“ an der Ansicht fehlt');
      const t = await findTaskByRef(db, project.id, a.ref);
      if (!t) fail(`${a.ref ?? 'Kennung'} nicht gefunden`);
      if (!(await canSeeSubproject(db, actor.id, t.subproject_id))) fail('Teilprojekt ist eingeschränkt sichtbar');
      await linkMail(t.id, false);
      await db.query(`insert into task_comments (task_id, user_id, body, source, mail_id) values ($1,$2,$3,'ai',$4)`, [t.id, actor.id, `Mail „${mail.subject ?? ''}“ von ${mail.from_name ?? mail.from_addr}: ${cut(a.text, 1000) || 'zugeordnet'} (${by})`, mail.id]);
      queueAgentRun(t.id, 'mail');
      state.taskId ??= t.id;
      return { ref: `${project.key}-${t.number}`, taskId: t.id };
    }
    case 'create_event': {
      if (!title) fail('Titel fehlt');
      const raw = String(a.startsAt ?? '').trim().replace(' ', 'T');
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) fail('Beginn als YYYY-MM-DDTHH:MM angeben');
      const now = new Date();
      const starts = parseUntil(raw, now);
      const ends = a.endsAt ? parseUntil(String(a.endsAt).trim().replace(' ', 'T'), now) : starts ? new Date(starts.getTime() + 3600_000) : null;
      if (!starts || !ends || ends <= starts) fail('Beginn oder Ende nicht lesbar');
      if (await db.maybeOne(`select 1 from meetings where project_id = $1 and lower(title) = lower($2) and starts_at = $3`, [project.id, title, starts])) fail(`„${title}“ steht schon im Kalender`);
      // Agent als PL: vorläufig; Vorschlag des Agenten, den eine Person annimmt: bestätigt
      const ev = await createPlannedEvent(db, pa, { projectId: project.id, title, startsAt: starts!, endsAt: ends!, location: a.location, description: a.text, taskId: state.taskId, confirmedBy: ctx.run.mode === 'triage' ? actor.id : null });
      return { meetingId: ev.id };
    }
    case 'reply_draft': {
      if (!rights.canDraft && !rights.canSend) fail('Kein Entwurfsrecht an der Ansicht');
      const text = String(a.text ?? '').trim();
      if (!text) fail('Antworttext fehlt');
      const subject = reSubject(mail.subject);
      // Autonomer Versand: Agent als stellvertretende PL mit Senderecht, „darf Mails senden“ und Policy „Selbstständig“; Außenprüfung wie bei Agenten-Mails
      // (Neuformulierung nach Stufe, Prüfung); bestanden und kein erster Kontakt → senden bzw. im Arbeitszeitfenster planen, sonst Entwurf zur Freigabe
      const autonomous = asAgent && ctx.run.mode === 'process' && Boolean(ctx.cfg && ctx.fetchFn) && rights.canSend && membership!.agentCanMail && (await effectiveAgentPolicy(db, { agentId: actor.id, projectId: project.id })).mode === 'auto';
      if (autonomous) {
        const aud = await audienceOf(db, { projectId: project.id, taskId: state.taskId, recipients: [mail.from_addr] });
        const g = aud.audience === 'internal' ? null : await guardOutbound(db, ctx.cfg!, ctx.fetchFn!, { projectId: project.id, taskId: state.taskId, aud, subject, text, compose: true, keepSubject: true });
        const sendable = !g || (g.result === 'pass' && aud.audience !== 'unknown_external');
        const now = ctx.now ?? new Date();
        const rec = (draftId: string | null) => (g ? recordCheck(db, { orgId: project.org_id, projectId: project.id, taskId: state.taskId, channel: 'mail', aud, result: g.result, findings: g.findings, withheld: g.withheld, mailDraftId: draftId, userId: actor.id }) : Promise.resolve(null));
        const ins = (status: string, sendAt: Date | null) => db.one(`insert into mail_drafts (account_id, view_id, task_id, project_id, user_id, to_addrs, cc_addrs, subject, body, in_reply_to, status, send_at) values ($1,$2,$3,$4,$5,$6,'[]',$7,$8,$9,$10,$11) returning id`,
          [mail.account_id, view.id, state.taskId, project.id, actor.id, JSON.stringify([mail.from_addr]), subject, g?.text ?? text, mail.message_id ?? null, status, sendAt]);
        if (sendable && g) {
          const win = await externalWindow(db, project.org_id);
          if (!inWindow(win, now)) {
            const at = nextWindowStart(win, now);
            const d = await ins('scheduled', at);
            await rec(d.id);
            return { draftId: d.id, scheduled: fmtWhen(at) };
          }
        }
        if (sendable) {
          const account = await db.one<AccountRow>(`select * from mail_accounts where id = $1`, [mail.account_id]);
          await svc.sendFromAccount(account, { to: [mail.from_addr], subject, text: g?.text ?? text, taskId: state.taskId, inReplyTo: mail.message_id ?? null, userId: actor.id, projectId: project.id });
          await rec(null);
          await audit(db, { orgId: project.org_id, projectId: project.id, userId: actor.id, action: 'mail.send', objectType: 'mail', objectId: mail.id, details: { to: mail.from_addr, subject, by, autonomous: true } });
          return { sent: true, ...(g?.findings.length ? { hints: g.findings.length } : {}) };
        }
        const d = await ins('pending_approval', null);
        await rec(d.id);
        return { draftId: d.id, ...(g?.findings.length ? { hints: g.findings.length } : {}) };
      }
      const d = await db.one(`insert into mail_drafts (account_id, view_id, task_id, project_id, user_id, to_addrs, cc_addrs, subject, body, in_reply_to, status) values ($1,$2,$3,$4,$5,$6,'[]',$7,$8,$9,'draft') returning id`,
        [mail.account_id, view.id, state.taskId, project.id, actor.id, JSON.stringify([mail.from_addr]), reSubject(mail.subject), text, mail.message_id ?? null]);
      // Außenprüfung nur als Hinweis: die Person sieht die Fundstellen am Entwurf und sendet selbst
      const hint = await checkHint(db, { orgId: project.org_id, projectId: project.id, taskId: state.taskId, recipients: [mail.from_addr], subject: reSubject(mail.subject), text, mailDraftId: d.id, userId: actor.id });
      return { draftId: d.id, ...(hint?.findings.length ? { hints: hint.findings.length } : {}) };
    }
    case 'move': {
      if (!rights.canDraft && !rights.canSend) fail('Verschieben erfordert Entwurfs- oder Senderecht an der Ansicht');
      const folder = await moveMailTo(db, svc, mail, String(a.folder ?? '').trim() || 'Archiv');
      await audit(db, { orgId: project.org_id, projectId: project.id, userId: actor.id, action: 'mail.move', objectType: 'mail', objectId: mail.id, details: { from: mail.folder, to: folder, by } });
      mail.folder = folder;
      return { folder };
    }
    case 'none':
      return {};
  }
  return fail(`${(a as any).type}: unbekannt`);
}

/** Mail ablegen: „Archiv“ = Archivordner des Kontos, „In Arbeit“ wird bei Bedarf angelegt, sonst ein vorhandener Ordner. */
export async function moveMailTo(db: Db, svc: MailService, mail: any, target: string): Promise<string> {
  const account = await db.one<AccountRow>(`select * from mail_accounts where id = $1`, [mail.account_id]);
  const p = svc.providerFor(account);
  const list = await p.listFolders(account);
  let path: string | null = null;
  if (/^(archiv|archive)$/i.test(target)) path = list.find((f) => f.specialUse === 'archive')?.path ?? (await p.createFolder(account, 'Archive')).path;
  else {
    const hit = list.find((f) => f.path.toLowerCase() === target.toLowerCase() || f.name.toLowerCase() === target.toLowerCase());
    path = hit?.path ?? (/^in arbeit$/i.test(target) ? (await p.createFolder(account, 'In Arbeit')).path : null);
  }
  if (!path) return fail(`Ordner „${target}“ gibt es nicht`);
  if (String(mail.folder).toLowerCase() === path.toLowerCase()) return path;
  const moved = await p.move(account, { folder: mail.folder, uid: mail.uid }, path);
  await db.query(`update mails set folder = $2, uid = coalesce($3, uid) where id = $1`, [mail.id, path, moved.uid]);
  return path;
}

/** Vorschläge eines Agenten annehmen oder verwerfen (einzeln oder alle offenen); Ausführung mit den Rechten der entscheidenden Person. */
export async function decideProposals(db: Db, svc: MailService, runId: string, user: User, index: number | 'all', approve: boolean): Promise<StoredAction[]> {
  const run = await db.maybeOne(`select r.*, u.name as agent_name from mail_ai_runs r left join users u on u.id = r.agent_user_id where r.id = $1 and r.mode = 'triage'`, [runId]);
  if (!run) fail('Vorschläge nicht gefunden');
  const project = await db.one(`select * from projects where id = $1`, [run.project_id]);
  const mail = await db.one(`select m.*, ux.use, ux.use_user_id from mails m join mail_accounts a on a.id = m.account_id ${USE_LATERAL('a', '$2::uuid')} where m.id = $1`, [run.mail_id, run.project_id]);
  const view = run.view_id ? await db.maybeOne(`select * from mail_views where id = $1`, [run.view_id]) : null;
  if (!view) fail('Ansicht gibt es nicht mehr');
  const actions: StoredAction[] = run.actions ?? [];
  const state = { taskId: actions.find((x) => x.status === 'approved' && x.result?.taskId)?.result?.taskId ?? null };
  for (const [i, a] of actions.entries()) {
    // Offene und fehlgeschlagene Vorschläge (z. B. fehlendes Recht der ersten Person) lassen sich entscheiden
    if ((a.status !== 'pending' && a.status !== 'error') || (index !== 'all' && index !== i)) continue;
    if (!approve) { actions[i] = { ...a, status: 'rejected', decidedBy: user.id }; continue; }
    try { actions[i] = { ...a, status: 'approved', decidedBy: user.id, result: await applyOne(db, svc, { run, project, mail, view, actor: user }, a, state) }; }
    catch (e: any) { actions[i] = { ...a, status: 'error', decidedBy: user.id, result: { error: String(e?.message ?? e).slice(0, 300) } }; }
  }
  await db.query(`update mail_ai_runs set actions = $2 where id = $1`, [run.id, JSON.stringify(actions)]);
  await audit(db, { orgId: project.org_id, projectId: project.id, userId: user.id, action: approve ? 'mail.ai_approve' : 'mail.ai_reject', objectType: 'mail', objectId: mail.id, details: { runId: run.id, index } });
  return actions;
}
