import type { User } from '@projekttool/shared';
import type { Db } from '../db.js';
import type { MailService } from '../mail/service.js';
import type { AccountRow } from '../mail/types.js';
import { audit } from '../audit.js';
import { notify } from '../notify.js';
import { canSeeSubproject, getMembership, getViewRights, visibleSubprojectSql } from '../rights.js';
import { reSubject } from '../mail/origin.js';
import { linkMailToTask } from '../mail/link.js';
import { aiConfigFor, complete, parseJson } from './client.js';
import { AGENT_SHEET, MAIL_RULES } from './sheet.js';
import { EFFECTIVE_JOINS, EFFECTIVE_RESPONSIBLE_SQL, createPlannedEvent, createPlannedTask, findTaskByRef, fmtWhen, resolvePerson, ymd, type PlanActor } from './plan.js';
import { parseUntil, styleText } from './agent.js';
import { queueAgentRun, queueMailAi } from './agentEvents.js';
import { checkHint } from '../outbound.js';

/**
 * Mail-KI an einer Ansicht.
 * process: Die Projekt-KI bearbeitet jede neue Mail der Ansicht (typisch Ordner „KI Bearbeiten“) direkt, im Auftrag und
 *   mit den Rechten der Person, die das eingeschaltet hat (bzw. die „KI bearbeiten“ geklickt hat): Arbeitspaket/Aufgabe mit
 *   Ursprungsmail, Zuweisung (auch an Agenten), Termin, Antwortentwurf, Ablage der Mail.
 * triage: Ein Agent betreut die Ansicht und schlägt für neue Mails dieselben Aktionen vor; ausgeführt wird erst, wenn eine
 *   Person zustimmt, und dann mit deren Rechten.
 * Jede Mail wird je Projekt und Art höchstens einmal bearbeitet (eindeutiger Index), Läufe zählen gegen das Tagesbudget.
 * Vor jedem Lauf gelten die KI-Freigaben (mail.process für den Auftraggeber, mail.triage für den Agenten): gesperrt heißt
 * übersprungen mit Begründung, ein erreichtes Tagesbudget lässt den Lauf warten.
 */
export type MailAiAction = { type: 'create_ap' | 'create_aufgabe' | 'link' | 'create_event' | 'reply_draft' | 'move' | 'none'; title?: string | null; text?: string | null; ref?: string | null; subproject?: string | null; responsible?: string | null; startDate?: string | null; dueDate?: string | null; items?: string[] | null; startsAt?: string | null; endsAt?: string | null; location?: string | null; folder?: string | null; reason?: string | null };
export type StoredAction = MailAiAction & { status: 'done' | 'error' | 'pending' | 'approved' | 'rejected'; result?: { ref?: string; taskId?: string; meetingId?: string; draftId?: string; folder?: string; error?: string; /** Fundstellen der Außenprüfung am Antwortentwurf (Hinweis) */ hints?: number }; decidedBy?: string | null };

const TYPES = ['create_ap', 'create_aufgabe', 'link', 'create_event', 'reply_draft', 'move', 'none'];
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'actions'],
  properties: {
    summary: { type: 'string', description: 'Ein Satz: was veranlasst bzw. vorgeschlagen wird' },
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
  const views = await db.query(`select v.id, v.project_id, v.ai_process, v.ai_process_by, v.agent_user_id, p.org_id from mail_views v join projects p on p.id = v.project_id where v.id = any($1::uuid[]) and p.status = 'active' and (v.ai_process or v.agent_user_id is not null) order by v.ai_process desc`, [viewIds]);
  const done = new Set<string>();
  for (const v of views.rows) {
    if (done.has(v.project_id)) continue;
    if (!v.ai_process && opts.autoLinked) continue;
    const mode = v.ai_process ? 'process' : 'triage';
    const r = await db.maybeOne(`insert into mail_ai_runs (org_id, project_id, view_id, mail_id, mode, actor_user_id, agent_user_id) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing returning id`,
      [v.org_id, v.project_id, v.id, mailId, mode, mode === 'process' ? v.ai_process_by : null, mode === 'triage' ? v.agent_user_id : null]);
    done.add(v.project_id);
    if (r) queueMailAi(r.id);
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
  const finish = (status: string, patch: { summary?: string | null; actions?: StoredAction[]; error?: string | null; inputTokens?: number; outputTokens?: number } = {}) =>
    db.query(`update mail_ai_runs set status = $2, summary = coalesce($3, summary), actions = coalesce($4::jsonb, actions), error = $5, input_tokens = input_tokens + $6, output_tokens = output_tokens + $7, finished_at = now() where id = $1`,
      [run.id, status, patch.summary ?? null, patch.actions ? JSON.stringify(patch.actions) : null, patch.error ?? null, patch.inputTokens ?? 0, patch.outputTokens ?? 0]);
  const requeue = (error: string) => db.query(`update mail_ai_runs set status = 'queued', error = $2 where id = $1`, [run.id, error]);
  try {
    const project = await db.maybeOne(`select * from projects where id = $1 and status = 'active'`, [run.project_id]);
    const m = await db.maybeOne(`select m.*, a.type as account_type, a.owner_user_id, a.address as account_address from mails m join mail_accounts a on a.id = m.account_id where m.id = $1`, [run.mail_id]);
    const view = run.view_id ? await db.maybeOne(`select * from mail_views where id = $1`, [run.view_id]) : null;
    if (!project || !m || !view) return void (await finish('skipped', { error: 'Projekt, Mail oder Ansicht nicht mehr vorhanden' }));

    let header: string; let agent: any = null;
    let gate: Awaited<ReturnType<typeof aiConfigFor>>;
    if (run.mode === 'process') {
      const actor = await userRow(db, run.actor_user_id);
      if (!actor) return void (await finish('skipped', { error: 'Auftraggeber ist nicht mehr aktiv' }));
      gate = await aiConfigFor(db, { userId: actor.id, projectId: project.id, feature: 'mail.process', viewId: view.id });
      // Die Läufe sehen alle mit Zugriff auf die Ansicht: Begründung ohne Namen und Notiz persönlicher Regeln
      if (!gate.cfg) return void (await (gate.decision.stage === 'budget' ? requeue(`wartet: ${gate.decision.reason}`) : finish('skipped', { error: gate.decision.publicReason })));
      header = `# Du\nDu bist die Projekt-KI von ${project.key} „${project.name}“. ${actor.name} hat diese Mail zur Bearbeitung abgelegt; was du listest, wird sofort in seinem Auftrag angelegt.`;
    } else {
      agent = await db.maybeOne(`select u.id, u.name, u.org_id, u.persona from users u join project_members pm on pm.user_id = u.id and pm.project_id = $2 where u.id = $1 and u.kind = 'agent' and u.active`, [run.agent_user_id, project.id]);
      if (!agent) return void (await finish('skipped', { error: 'Agent nicht aktiv oder kein Mitglied' }));
      gate = await aiConfigFor(db, { userId: agent.id, projectId: project.id, feature: 'mail.triage' });
      if (!gate.cfg) return void (await (gate.decision.stage === 'budget' ? requeue(`wartet: ${gate.decision.reason}`) : finish('skipped', { error: gate.decision.publicReason })));
      header = `# Du\nDu bist „${agent.name}“, KI-Agent, und betreust die Mail-Ansicht „${view.name}“ im Projekt ${project.key} „${project.name}“. Du schlägst vor; ausgeführt wird erst, wenn eine Person zustimmt. ${styleText(agent.persona)}`;
    }

    const cfg = gate.cfg;
    const now = new Date();
    const actorForVis = run.mode === 'process' ? run.actor_user_id : agent.id;
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
    const j = parseJson<{ summary?: string; actions?: MailAiAction[] }>(r.text);
    const proposed = (Array.isArray(j.actions) ? j.actions : []).filter((a) => a && TYPES.includes(a.type)).slice(0, 8);
    const summary = cut(String(j.summary ?? ''), 600);
    let stored: StoredAction[];
    if (run.mode === 'process') {
      const actor = (await userRow(db, run.actor_user_id))!;
      stored = await applyActions(db, mailSvc, { run, project, mail: m, view, actor }, proposed);
      await notify(db, { userId: actor.id, projectId: project.id, type: 'mail.ai', title: `KI hat Mail bearbeitet: ${cut(m.subject, 80)}`, body: summary, link: `/projekte/${project.id}/mail/m/${m.id}`, dedupeKey: null });
    } else {
      stored = proposed.map((a) => ({ ...clean(a), status: 'pending' as const }));
      const owners = account.type === 'personal' && account.owner_user_id ? [account.owner_user_id] : (await db.query(`select m.user_id from project_members m join users u on u.id = m.user_id where m.project_id = $1 and m.role = 'pl' and u.kind <> 'agent'`, [project.id])).rows.map((x: any) => x.user_id);
      const n = stored.filter((x) => x.type !== 'none').length;
      if (n) for (const u of owners) await notify(db, { userId: u, projectId: project.id, type: 'mail.ai', title: `${agent.name}: ${n} Vorschl${n === 1 ? 'ag' : 'äge'} zu „${cut(m.subject, 60)}“`, body: summary, link: `/projekte/${project.id}/mail/m/${m.id}`, dedupeKey: null });
      // Für Budget und Übersicht der Agentenläufe: ohne Inhalt aus der Mail (die Läufe sehen alle Mitglieder, die Mail ggf. nicht)
      await db.query(`insert into agent_runs (org_id, agent_user_id, project_id, task_id, trigger, status, reasoning, actions, input_tokens, output_tokens) values ($1,$2,$3,null,'mail_triage','ok',$4,$5,$6,$7)`,
        [project.org_id, agent.id, project.id, `Mail-Vorschläge: ${n}`, JSON.stringify(stored.map((x) => ({ type: x.type }))), r.inputTokens, r.outputTokens]);
    }
    const failed = stored.filter((x) => x.status === 'error');
    await finish(failed.length ? 'error' : 'ok', { summary, actions: stored, error: failed.length ? failed.map((x) => `${x.type}: ${x.result?.error}`).join(' | ') : null, inputTokens: r.inputTokens, outputTokens: r.outputTokens });
    await audit(db, { orgId: project.org_id, projectId: project.id, userId: run.mode === 'process' ? run.actor_user_id : agent.id, action: run.mode === 'process' ? 'mail.ai_process' : 'mail.ai_triage', objectType: 'mail', objectId: m.id, details: { runId: run.id, actions: stored.map((x) => `${x.type}:${x.status}`), profile: cfg.name, model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens } });
  } catch (e: any) {
    await finish('error', { error: String(e?.message ?? e).slice(0, 300) });
  }
}

interface Ctx { run: any; project: any; mail: any; view: any; actor: User }

const clean = (a: MailAiAction): MailAiAction => Object.fromEntries(Object.entries(a).filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))) as MailAiAction;

/** Aktionen ausführen (Projekt-KI direkt oder freigegebener Vorschlag), mit den Rechten von ctx.actor. */
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
  const pa: PlanActor = { id: actor.id, name: actor.name, orgId: project.org_id, role: membership!.role, label: ctx.run.mode === 'process' ? `Projekt-KI (für ${actor.name})` : actor.name, isAgent: false };
  const by = ctx.run.mode === 'process' ? 'Projekt-KI' : `Vorschlag von ${ctx.run.agent_name ?? 'Agent'}, angenommen von ${actor.name}`;
  // Inhalt ins Projekt: im Ordner-Modus hat der Auftraggeber zugestimmt (Kopie), sonst nur verknüpft
  const copied = ctx.run.mode === 'process';
  const linkMail = (taskId: string, origin: boolean) => linkMailToTask(db, { mailId: mail.id, taskId, copied, linkedBy: actor.id, origin, actorId: actor.id, logged: true });
  // Vorschläge zu Mails aus einem persönlichen Konto nimmt nur der Eigentümer an (Inhalt würde sonst ins Projekt gelangen)
  if (ctx.run.mode === 'triage' && mail.account_type === 'personal' && mail.owner_user_id !== actor.id && a.type !== 'none') fail('Vorschläge zu Mails aus einem persönlichen Konto nimmt nur der Eigentümer an');
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
      // Projekt-KI: vorläufig; Vorschlag des Agenten, den eine Person annimmt: bestätigt
      const ev = await createPlannedEvent(db, pa, { projectId: project.id, title, startsAt: starts!, endsAt: ends!, location: a.location, description: a.text, taskId: state.taskId, confirmedBy: ctx.run.mode === 'triage' ? actor.id : null });
      return { meetingId: ev.id };
    }
    case 'reply_draft': {
      if (!rights.canDraft && !rights.canSend) fail('Kein Entwurfsrecht an der Ansicht');
      const text = String(a.text ?? '').trim();
      if (!text) fail('Antworttext fehlt');
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
  const mail = await db.one(`select m.*, a.type as account_type, a.owner_user_id from mails m join mail_accounts a on a.id = m.account_id where m.id = $1`, [run.mail_id]);
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
