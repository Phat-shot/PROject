import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db.js';
import { audit } from '../audit.js';
import { notifyMany } from '../notify.js';
import { aiConfigFor, completeJson, type AiConfig } from '../ai/client.js';
import { keyFigures, keyFiguresLine } from '../ai/agentChat.js';
import { styleText } from '../ai/agent.js';
import { createPlannedEvent, createPlannedTask, fmtWhen, type PlanActor } from '../ai/plan.js';
import { visibleSubprojectSql } from '../rights.js';

/**
 * Telefon (sipgate Flow): sipgate übernimmt Telefonie, Spracherkennung und Sprachausgabe und schickt je Anruf Ereignisse
 * (session_start, user_speak, …); die Antwort sind Aktionen (speak, hangup, …). Der Zustand eines Anrufs steht in calls.
 * Je Rufnummer: Projekt, Agent und ein schnelles KI-Profil. Der Agent nimmt Nachrichten auf, gibt internen Anrufern
 * (Telefonnummer am Benutzer) den Stand ihrer Projekte und schlägt Termine vor (vorläufig, eine Person bestätigt).
 */

/** Rufnummer als Ziffern mit Ländervorwahl (Deutschland, wenn nur mit 0 beginnend): „+49 211 123“, „0049…“, „0211…“ → „49211123“. */
export function normNumber(raw: unknown): string {
  let s = String(raw ?? '').trim().replace(/[\s\-/().]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('00')) s = s.slice(2);
  else if (s.startsWith('0')) s = `49${s.slice(1)}`;
  return s.replace(/\D/g, '');
}

const safeEq = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** Ereignis von sipgate Flow prüfen: Header x-api-token (Token) oder x-sipgate-signature (HMAC-SHA256 über den Rohtext). */
export function verifyFlowRequest(secret: string, headers: Record<string, unknown>, rawBody: string): boolean {
  if (!secret) return false;
  const token = headers['x-api-token'];
  if (typeof token === 'string' && token) return safeEq(token, secret);
  const sig = headers['x-sipgate-signature'];
  if (typeof sig === 'string' && sig) return safeEq(sig, `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  return false;
}

export interface FlowSession { id: string; account_id?: string; phone_number?: string; direction?: 'inbound' | 'outbound'; from_phone_number?: string; to_phone_number?: string }
export interface FlowEvent { type: string; session: FlowSession; text?: string; barged_in?: boolean }
export type FlowAction = { session_id: string; type: string; [k: string]: unknown };

/** Stimme und Sprache: Deutsch (Spracherkennung und -ausgabe) */
const TTS = { provider: 'azure', language: 'de-DE', voice: 'de-DE-KatjaNeural' };
const speak = (sid: string, text: string, timeout = 8): FlowAction => ({ session_id: sid, type: 'speak', text: text.slice(0, 1200), tts: TTS, user_input_timeout_seconds: timeout });
const hangup = (sid: string): FlowAction => ({ session_id: sid, type: 'hangup' });

interface Turn { role: 'caller' | 'agent'; text: string; at: string }
interface CallNotes { name?: string; callback?: string; concern?: string; project?: string; event?: { title: string; startsAt: string; endsAt?: string } | null; hangupAfterSpeech?: boolean; timeouts?: number; status?: boolean }

async function loadCall(db: Db, sessionId: string) {
  return db.maybeOne(`select c.*, l.greeting, l.ai_profile_id, l.label as line_label from calls c left join phone_lines l on l.id = c.line_id where c.provider = 'flow' and c.external_id = $1`, [sessionId]);
}

/** Projekte, zu denen ein interner Anrufer am Telefon Auskunft bekommt: das der Rufnummer bzw. gemeinsame Projekte mit dem Agenten, in denen er Mitglied ist. */
async function callerProjects(db: Db, call: any): Promise<{ id: string; key: string; name: string }[]> {
  if (!call.caller_user_id || !call.agent_user_id) return [];
  return (await db.query(
    `select p.id, p.key, p.name from projects p
       join project_members a on a.project_id = p.id and a.user_id = $1
       join project_members s on s.project_id = p.id and s.user_id = $2 and (s.role = 'pl' or s.can_use_ai)
     where p.org_id = $3 and p.status = 'active' and ($4::uuid is null or p.id = $4) order by p.key`,
    [call.agent_user_id, call.caller_user_id, call.org_id, call.project_id])).rows;
}

/** Ein Ereignis verarbeiten; Rückgabe: Aktionen für sipgate (leer: nichts tun). */
export async function handleFlowEvent(db: Db, fetchFn: typeof fetch, orgId: string, ev: FlowEvent, now = new Date()): Promise<FlowAction[]> {
  const sid = String(ev?.session?.id ?? '');
  if (!sid) return [];
  switch (ev.type) {
    case 'session_start': return sessionStart(db, orgId, ev, now);
    case 'user_speak': return userSpeak(db, fetchFn, orgId, ev, now);
    case 'user_input_timeout': {
      const call = await loadCall(db, sid);
      if (!call || call.org_id !== orgId) return [];
      const n: CallNotes = call.notes ?? {};
      const timeouts = (n.timeouts ?? 0) + 1;
      if (timeouts >= 2) {
        await db.query(`update calls set notes = notes || $2 where id = $1`, [call.id, JSON.stringify({ timeouts, hangupAfterSpeech: true })]);
        return [speak(sid, 'Ich höre Sie leider nicht. Auf Wiederhören.')];
      }
      await db.query(`update calls set notes = notes || $2 where id = $1`, [call.id, JSON.stringify({ timeouts })]);
      return [speak(sid, 'Sind Sie noch da?')];
    }
    case 'assistant_speech_ended': {
      const call = await loadCall(db, sid);
      return call && call.org_id === orgId && call.notes?.hangupAfterSpeech ? [hangup(sid)] : [];
    }
    case 'session_end': {
      const call = await loadCall(db, sid);
      if (call && call.org_id === orgId) await finishCall(db, call, now);
      return [];
    }
    default: return [];
  }
}

async function sessionStart(db: Db, orgId: string, ev: FlowEvent, now: Date): Promise<FlowAction[]> {
  const s = ev.session;
  const direction = s.direction === 'outbound' ? 'out' : 'in';
  const from = normNumber(s.from_phone_number);
  const to = normNumber(s.to_phone_number);
  const ours = direction === 'in' ? to : from;
  const line = await db.maybeOne(`select l.*, p.name as project_name, p.status as project_status, u.name as agent_name, u.active as agent_active from phone_lines l left join projects p on p.id = l.project_id left join users u on u.id = l.agent_user_id where l.org_id = $1 and l.number = $2 and l.active`, [orgId, ours]);
  const caller = direction === 'in' && from ? await db.maybeOne(`select id, name from users where org_id = $1 and active and kind <> 'agent' and phone = $2 limit 1`, [orgId, from]) : null;
  const existing = await loadCall(db, s.id);
  if (!existing) {
    await db.query(`insert into calls (org_id, line_id, provider, external_id, direction, from_number, to_number, caller_user_id, project_id, agent_user_id, started_at, answered_at) values ($1,$2,'flow',$3,$4,$5,$6,$7,$8,$9,$10,$10) on conflict (provider, external_id) do nothing`,
      [orgId, line?.id ?? null, s.id, direction, from || null, to || null, caller?.id ?? null, line?.project_id ?? null, line?.agent_user_id ?? null, now]);
  }
  const org = await db.one(`select name from orgs where id = $1`, [orgId]);
  if (!line || !line.agent_user_id || !line.agent_active) {
    await db.query(`update calls set notes = notes || '{"hangupAfterSpeech": true}', error = $2 where provider = 'flow' and external_id = $1`, [s.id, !line ? `Rufnummer ${ours} nicht eingerichtet` : 'Kein aktiver Agent an der Rufnummer']);
    return [{ session_id: s.id, type: 'configure_transcription', languages: ['de-DE'] }, speak(s.id, `Guten Tag, Sie haben ${org.name} erreicht. Unter dieser Nummer ist gerade niemand erreichbar. Bitte versuchen Sie es später noch einmal.`)];
  }
  const greeting = line.greeting?.trim()
    || (caller
      ? `Hallo ${String(caller.name).split(' ')[0]}, hier ist ${line.agent_name}, der KI-Assistent. Was kann ich für dich tun?`
      : `Guten Tag, Sie sprechen mit ${line.agent_name}, dem KI-Assistenten von ${org.name}${line.project_name ? ` für das Projekt ${line.project_name}` : ''}. Ich nehme Ihr Anliegen auf und gebe es weiter. Was kann ich für Sie tun?`);
  await db.query(`update calls set transcript = transcript || $2::jsonb where provider = 'flow' and external_id = $1`, [s.id, JSON.stringify([{ role: 'agent', text: greeting, at: now.toISOString() }])]);
  return [{ session_id: s.id, type: 'configure_transcription', languages: ['de-DE'] }, speak(s.id, greeting)];
}

const SCHEMA = {
  type: 'object',
  properties: {
    say: { type: 'string', description: 'Nächster Satz am Telefon, gesprochen, kurz (höchstens zwei Sätze)' },
    end: { type: 'boolean', description: 'true: Gespräch ist abgeschlossen, nach dem Satz auflegen' },
    name: { type: 'string', description: 'Name des Anrufers, sonst leer' },
    callback: { type: 'string', description: 'Rückrufnummer, wenn genannt, sonst leer' },
    concern: { type: 'string', description: 'Anliegen als Nachricht an das Team in ein bis drei Sätzen, sonst leer (bei reiner Statusfrage leer)' },
    project: { type: 'string', description: 'Projektkürzel, wenn eindeutig (nur aus der Liste), sonst leer' },
    eventTitle: { type: 'string', description: 'Titel eines vorgeschlagenen Termins, sonst leer' },
    eventStart: { type: 'string', description: 'Beginn als YYYY-MM-DDTHH:MM (Europe/Berlin), sonst leer' },
    eventEnd: { type: 'string', description: 'Ende als YYYY-MM-DDTHH:MM, sonst leer' }
  },
  required: ['say', 'end', 'name', 'callback', 'concern', 'project', 'eventTitle', 'eventStart', 'eventEnd'],
  additionalProperties: false
};

async function userSpeak(db: Db, fetchFn: typeof fetch, orgId: string, ev: FlowEvent, now: Date): Promise<FlowAction[]> {
  const sid = ev.session.id;
  const call = await loadCall(db, sid);
  if (!call || call.org_id !== orgId) return [];
  const text = String(ev.text ?? '').trim();
  if (!text) return [];
  const turns: Turn[] = [...(call.transcript ?? []), { role: 'caller', text: text.slice(0, 2000), at: now.toISOString() }];
  await db.query(`update calls set transcript = $2, notes = notes || '{"timeouts": 0}' where id = $1`, [call.id, JSON.stringify(turns)]);
  if (call.notes?.hangupAfterSpeech || !call.agent_user_id) return [speak(sid, 'Auf Wiederhören.')];
  const agent = await db.one(`select id, name, org_id, persona from users where id = $1`, [call.agent_user_id]);
  const cfg = await phoneConfig(db, call);
  if (!cfg) {
    await db.query(`update calls set error = $2, notes = notes || '{"hangupAfterSpeech": true}' where id = $1`, [call.id, 'KI für die Rufnummer nicht verfügbar (Profil, Freigabe oder Notaus)']);
    return [speak(sid, 'Ich kann Ihr Anliegen gerade leider nicht aufnehmen. Bitte versuchen Sie es später noch einmal oder schreiben Sie uns eine Mail. Auf Wiederhören.')];
  }
  const org = await db.one(`select name from orgs where id = $1`, [orgId]);
  const project = call.project_id ? await db.maybeOne(`select id, key, name from projects where id = $1`, [call.project_id]) : null;
  const caller = call.caller_user_id ? await db.maybeOne(`select id, name from users where id = $1`, [call.caller_user_id]) : null;
  // Interne Anrufer: Kennzahlen und offene Arbeitspakete der freigegebenen Projekte; Externe: nur Projektname
  let context = '';
  let known: { id: string; key: string; name: string }[] = [];
  if (caller) {
    known = await callerProjects(db, call);
    for (const p of known) context += `${keyFiguresLine(p.key, await keyFigures(db, { projectIds: [p.id], viewerId: caller.id, now }))}\n`;
    if (known.length) {
      const open = await db.query(
        `select p.key, t.number, t.title, t.due_date, t.blocked, c.name as col, coalesce(u.name, t.responsible_email) as resp from tasks t join projects p on p.id = t.project_id join board_columns c on c.id = t.column_id left join users u on u.id = t.responsible_user_id
         where t.project_id = any($1::uuid[]) and t.deleted_at is null and t.archived_at is null and not c.is_done and ${visibleSubprojectSql(2)} order by t.due_date nulls last limit 15`,
        [known.map((p) => p.id), caller.id]);
      context += `Offene Arbeitspakete (Auszug):\n${open.rows.map((t: any) => `- ${t.key}-${t.number} „${t.title}“ · ${t.col}${t.due_date ? ` · fällig ${String(t.due_date instanceof Date ? t.due_date.toISOString() : t.due_date).slice(0, 10)}` : ''}${t.blocked ? ' · blockiert' : ''}${t.resp ? ` · ${t.resp}` : ''}`).join('\n') || '– keine –'}\n`;
    }
  }
  const system = `# Du\nDu bist „${agent.name}“, KI-Assistent von ${org.name}, am Telefon. ${styleText(agent.persona)}
# Telefon
- Du sprichst, du schreibst nicht: kurze, natürliche Sätze, keine Listen, keine Kennungen buchstabieren, Zahlen und Daten ausgesprochen.
- Du bist eine KI; sag das, wenn man fragt. Erfinde nichts, versprich keine Zusagen, Preise oder Termine als fest.
- ${caller ? `Der Anrufer ist ${caller.name} (intern). Fragen zum Stand beantwortest du nur aus den Daten unten.` : 'Der Anrufer ist extern oder unbekannt: gib keine Projektinhalte, Namen von Beteiligten oder Stände heraus. Nimm das Anliegen auf: Name, Anliegen, Rückrufnummer (die Nummer des Anrufs ist bekannt, frag, ob sie passt).'}
- Termine: Schlägt der Anrufer einen Termin vor oder wünscht einen, nimm ihn als Vorschlag auf (eventTitle, eventStart, eventEnd) und sag, dass eine Person ihn bestätigt.
- Ist alles aufgenommen oder verabschiedet sich der Anrufer, fasse kurz zusammen, verabschiede dich und setze end auf true.
- Antworte nur mit JSON nach dem Schema.`;
  const prompt = `Jetzt: ${fmtWhen(now)}
Rufnummer: ${call.line_label || call.to_number || '–'}${project ? ` · Projekt ${project.key} „${project.name}“` : ' · ohne festes Projekt'}
Anrufer-Nummer: ${call.from_number ?? 'unterdrückt'}
${known.length ? `Projekte des Anrufers mit dir: ${known.map((p) => `${p.key} „${p.name}“`).join(', ')}\n` : ''}${context}Bisher aufgenommen: ${JSON.stringify({ name: call.notes?.name ?? '', callback: call.notes?.callback ?? '', concern: call.notes?.concern ?? '', event: call.notes?.event ?? null })}
Gespräch:
${turns.slice(-16).map((t) => `${t.role === 'caller' ? 'Anrufer' : 'Du'}: ${t.text}`).join('\n')}`;
  try {
    const r = await completeJson<{ say?: string; end?: boolean; name?: string; callback?: string; concern?: string; project?: string; eventTitle?: string; eventStart?: string; eventEnd?: string }>(cfg, fetchFn, { meta: { feature: 'agent.phone', projectId: project?.id ?? null }, system, prompt, maxTokens: 400, schema: SCHEMA });
    const j = r.json;
    const say = String(j.say ?? '').trim() || 'Entschuldigung, können Sie das wiederholen?';
    const prev: CallNotes = call.notes ?? {};
    const keep = (v: unknown, old?: string) => (String(v ?? '').trim() ? String(v).trim().slice(0, 1000) : old);
    const projKey = String(j.project ?? '').trim().toUpperCase();
    const notes: CallNotes = {
      name: keep(j.name, prev.name), callback: keep(j.callback, prev.callback), concern: keep(j.concern, prev.concern),
      project: known.some((p) => p.key === projKey) || (!project && projKey) ? projKey : prev.project,
      event: String(j.eventTitle ?? '').trim() && String(j.eventStart ?? '').trim() ? { title: String(j.eventTitle).trim().slice(0, 200), startsAt: String(j.eventStart).trim(), endsAt: String(j.eventEnd ?? '').trim() || undefined } : prev.event ?? null,
      hangupAfterSpeech: Boolean(j.end)
    };
    await db.query(`update calls set notes = notes || $2, transcript = transcript || $3::jsonb where id = $1`, [call.id, JSON.stringify(notes), JSON.stringify([{ role: 'agent', text: say, at: new Date().toISOString() }])]);
    return [speak(sid, say)];
  } catch (e: any) {
    await db.query(`update calls set error = $2 where id = $1`, [call.id, String(e?.message ?? e).slice(0, 300)]);
    return [speak(sid, 'Entschuldigung, ich habe gerade eine Störung. Ich habe Ihre Nummer notiert, wir rufen zurück. Auf Wiederhören.')];
  }
}

/** KI-Konfiguration für den Anruf: Freigabe des Agenten im Projekt bzw. ohne Projekt; das Profil der Rufnummer (schnelles Modell) geht vor. */
async function phoneConfig(db: Db, call: any): Promise<AiConfig | null> {
  const { cfg, decision } = await aiConfigFor(db, { userId: call.agent_user_id, projectId: call.project_id ?? null, feature: 'agent.chat', profileId: call.ai_profile_id ?? null });
  return decision.allowed ? cfg : null;
}

const parseLocal = (v: string): Date | null => {
  const m = String(v ?? '').match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  if (!m) return null;
  // Europe/Berlin: Versatz zum Zeitpunkt bestimmen
  const guess = new Date(`${m[1]}T${m[2]}:00Z`);
  const local = new Date(guess.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const utc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  const d = new Date(guess.getTime() - (local.getTime() - utc.getTime()));
  return isNaN(d.getTime()) ? null : d;
};

/** Gesprächsende: Anliegen als Arbeitspaket im Projekt (Log mit Verlauf), vorläufiger Termin, Meldung an die PL; ohne Projekt Meldung an die Org-Admins. */
export async function finishCall(db: Db, call: any, now = new Date()) {
  const fresh = await db.one(`update calls set status = 'ended', ended_at = coalesce(ended_at, $2) where id = $1 returning *`, [call.id, now]);
  if (call.status === 'ended' || !call.agent_user_id) return;
  const n: CallNotes = fresh.notes ?? {};
  const turns: Turn[] = fresh.transcript ?? [];
  if (!turns.some((t) => t.role === 'caller')) return;
  const who = n.name || (call.caller_user_id ? (await db.maybeOne(`select name from users where id = $1`, [call.caller_user_id]))?.name : null) || (fresh.from_number ? `+${fresh.from_number}` : 'unbekannt');
  const transcript = turns.map((t) => `${t.role === 'caller' ? 'Anrufer' : 'KI'}: ${t.text}`).join('\n');
  const summary = n.concern ? `${n.concern}${n.callback ? ` · Rückruf: ${n.callback}` : fresh.from_number ? ` · Nummer: +${fresh.from_number}` : ''}` : null;
  const projectId = fresh.project_id ?? (n.project ? (await db.maybeOne(`select id from projects where org_id = $1 and upper(key) = $2`, [call.org_id, n.project]))?.id ?? null : null);
  const agent = await db.one(`select id, name, org_id from users where id = $1`, [call.agent_user_id]);
  if (!summary && !n.event) { await db.query(`update calls set summary = $2 where id = $1`, [call.id, 'Auskunft ohne Nachricht']); return; }
  if (!projectId) {
    const admins = (await db.query(`select id from users where org_id = $1 and global_role = 'org_admin' and active and kind <> 'agent'`, [call.org_id])).rows.map((r: any) => r.id);
    await notifyMany(db, admins, { projectId: null, type: 'call.message', title: `Anruf von ${who}`, body: summary ?? n.event?.title ?? '', link: '/verwaltung/telefonie', ref: null, actorId: agent.id });
    await db.query(`update calls set summary = $2 where id = $1`, [call.id, summary]);
    return;
  }
  const project = await db.one(`select id, key, org_id from projects where id = $1`, [projectId]);
  const m = await db.maybeOne(`select role from project_members where project_id = $1 and user_id = $2`, [projectId, agent.id]);
  const actor: PlanActor = { id: agent.id, name: agent.name, orgId: agent.org_id, role: m?.role ?? 'member', label: `${agent.name} (KI-Agent, Telefon)`, isAgent: true };
  const t = await createPlannedTask(db, actor, { projectId, projectKey: project.key, title: `Anruf von ${who}${n.concern ? `: ${n.concern.split(/[.!?]/)[0].slice(0, 80)}` : ''}`, description: `${summary ?? ''}\n\nAnruf am ${fmtWhen(new Date(fresh.started_at))}${fresh.from_number ? ` von +${fresh.from_number}` : ''}.` });
  await db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [t.id, agent.id, `Gesprächsverlauf (Telefon):\n${transcript.slice(0, 7000)}`]);
  let meetingId: string | null = null;
  const starts = n.event ? parseLocal(n.event.startsAt) : null;
  if (n.event && starts) {
    const ends = (n.event.endsAt && parseLocal(n.event.endsAt)) || new Date(starts.getTime() + 3600_000);
    meetingId = (await createPlannedEvent(db, actor, { projectId, title: n.event.title, startsAt: starts, endsAt: ends > starts ? ends : new Date(starts.getTime() + 3600_000), description: `Vorschlag am Telefon von ${who}`, taskId: t.id })).id;
  }
  const pls = (await db.query(`select m.user_id from project_members m join users u on u.id = m.user_id where m.project_id = $1 and m.role = 'pl' and u.kind <> 'agent' and u.active`, [projectId])).rows.map((r: any) => r.user_id);
  await notifyMany(db, pls, { projectId, type: 'call.message', title: `Anruf von ${who}`, body: `${summary ?? ''}${meetingId && starts ? `${summary ? ' · ' : ''}Terminvorschlag ${fmtWhen(starts)} (vorläufig)` : ''}`, link: `/projekte/${projectId}/board?task=${t.id}`, ref: { type: 'task', id: t.id }, actorId: agent.id });
  await db.query(`update calls set summary = $2, task_id = $3, meeting_id = $4, project_id = $5 where id = $1`, [call.id, summary, t.id, meetingId, projectId]);
  await audit(db, { orgId: call.org_id, projectId, userId: agent.id, action: 'call.message', objectType: 'call', objectId: call.id, details: { taskId: t.id, meetingId, from: fresh.from_number } });
}
