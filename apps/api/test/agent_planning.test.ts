import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { composeEcho, testApp } from './helpers.js';
import { runAgents } from '../src/ai/agent.js';
import { flushAgentRuns, queueAgentRun } from '../src/ai/agentEvents.js';

/** Lokales LLM: liefert die Aktionen aus `next`, merkt sich jede Anfrage. */
const calls: any[] = [];
let next: any[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (String(input) !== 'http://llm.local:8000/v1/chat/completions') return new Response('{}', { status: 404 });
  const echo = composeEcho(body);
  if (echo) return echo;
  calls.push(body);
  const content = body.response_format ? JSON.stringify({ note: 'geplant', actions: next }) : 'bereit';
  return new Response(JSON.stringify({ model: 'qwen', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
};
delete process.env.ANTHROPIC_API_KEY;
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());

const A = (x: Record<string, unknown>) => ({ type: 'none', text: null, column: null, itemId: null, to: null, subject: null, reason: null, kind: null, checkAfterHours: null, until: null, remindAfterHours: null, escalateAfterHours: null, pageId: null, title: null, folder: null, status: null, ref: null, responsible: null, startDate: null, dueDate: null, subproject: null, items: null, startsAt: null, endsAt: null, location: null, ...x });
const web = () => t.ids.projects.web;
let morton: any;
let elektrik = '';

test('Teilprojekt-Verantwortung: Agent läuft bei geerbter Zuständigkeit; Agenten setzt nur die PL ein', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const p = (await t.api(admin).post('/ai/profiles', { name: 'Qwen', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'qwen' })).json().profile;
  await t.api(admin).put('/ai/settings', { agentDailyBudget: 50 });
  morton = (await t.api(admin).post('/agents', { name: 'Morton' })).json().agent;
  await t.api(pl).put(`/projects/${web()}/members/${morton.id}`, { role: 'member' });

  // Max darf planen, aber keinen Agenten als Teilprojekt-Verantwortung einsetzen
  assert.equal((await t.api(max).post(`/projects/${web()}/subprojects`, { name: 'Elektrik', responsibleUserId: morton.id })).statusCode, 403);
  const sp = await t.api(pl).post(`/projects/${web()}/subprojects`, { name: 'Elektrik', responsibleUserId: morton.id, startDate: '2026-11-01', endDate: '2026-11-30' });
  assert.equal(sp.statusCode, 200, sp.body);
  elektrik = sp.json().subproject.id;
  const ap = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Teilprojekt durchplanen', subprojectId: elektrik, description: 'Bitte mit Aufgaben durchplanen, Fragen an die PL.' })).json().task;
  assert.equal(ap.responsible.userId, morton.id);
  assert.equal(ap.responsible.inherited, true);

  next = [A({ type: 'none', reason: 'erst lesen' })];
  calls.length = 0;
  const runs = await runAgents(t.db, t.mail, fakeFetch);
  const mine = runs.filter((r) => r.taskId === ap.id);
  assert.equal(mine.length, 1, 'geerbtes Arbeitspaket bekommt einen Lauf');
  const prompt = calls.find((c) => c.messages[1].content.includes('Teilprojekt durchplanen'));
  assert.match(prompt.messages[1].content, /Deine Zuständigkeit: geerbt vom Teilprojekt „Elektrik“/);
  // Anthropic Structured Outputs begrenzt Union-Typen (Typ-Listen, anyOf): das Schema kommt ohne aus
  const unions = (o: any): number => !o || typeof o !== 'object' ? 0 : (Array.isArray(o.type) || o.anyOf ? 1 : 0) + Object.values(o).reduce((n: number, v) => n + unions(v), 0);
  assert.equal(unions(prompt.response_format.json_schema.schema), 0);
  assert.match(prompt.messages[1].content, /Arbeitspakete legst|create_ap\) in deinen Teilprojekten/);
  // Manueller Lauf über die Route findet den geerbten Agenten
  assert.equal((await t.api(pl).post(`/tasks/${ap.id}/agent-run?wait=1`)).statusCode, 200);
});

test('Planungsaktionen als Mitglied: Aufgaben, AP im eigenen Teilprojekt, Termine, Kalender; Grenzen werden gemeldet', async () => {
  const pl = await t.login('pl@demo.local');
  const ap = await t.db.one(`select id, number from tasks where title = 'Teilprojekt durchplanen'`);
  const other = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Fremdes AP', dueDate: '2026-12-01' })).json().task;
  const agent2 = (await t.api(await t.login('admin@demo.local')).post('/agents', { name: 'Lotte' })).json().agent;
  await t.api(pl).put(`/projects/${web()}/members/${agent2.id}`, { role: 'member' });
  next = [
    A({ type: 'create_aufgabe', title: 'Leitungen planen', text: 'Plan der Leitungswege', startDate: '2026-11-02', dueDate: '2026-11-06', responsible: 'anna@demo.local', items: ['Grundriss', 'Stromkreise'] }),
    A({ type: 'create_aufgabe', title: 'Material bestellen', dueDate: '2026-11-10' }),
    A({ type: 'create_aufgabe', title: 'Leitungen planen' }),
    A({ type: 'create_ap', title: 'Abnahme Elektrik', dueDate: '2026-11-28' }),
    A({ type: 'create_event', title: 'Besichtigung Elektriker', startsAt: '2026-11-03T10:00', location: 'Gästezimmer' }),
    A({ type: 'set_dates', ref: `WEB-${other.number}`, dueDate: '2026-12-24' }),
    A({ type: 'assign', ref: 'Material bestellen', responsible: 'Lotte' }),
    A({ type: 'create_subproject', title: 'Maler' }),
    A({ type: 'create_aufgabe', title: 'Kaputt', dueDate: 'irgendwann' })
  ];
  const r = await t.api(pl).post(`/tasks/${ap.id}/agent-run?wait=1`);
  assert.equal(r.statusCode, 200, r.body);
  const kids = await t.db.query(`select t.title, t.start_date, t.due_date, u.email, (select count(*)::int from checklist_items i where i.task_id = t.id) as items from tasks t left join users u on u.id = t.responsible_user_id where t.parent_id = $1 order by t.title`, [ap.id]);
  assert.deepEqual(kids.rows.map((x: any) => x.title), ['Leitungen planen', 'Material bestellen'], 'Dublette und ungültiges Datum verworfen');
  assert.equal(kids.rows[0].email, 'anna@demo.local');
  assert.equal(kids.rows[0].items, 2);
  assert.equal(String(kids.rows[0].due_date instanceof Date ? kids.rows[0].due_date.toISOString() : kids.rows[0].due_date).slice(0, 10), '2026-11-06');
  assert.ok(await t.db.maybeOne(`select 1 from tasks where title = 'Abnahme Elektrik' and subproject_id = $1 and parent_id is null`, [elektrik]), 'AP im eigenen Teilprojekt');
  const ev = await t.db.one(`select m.id, m.starts_at, m.created_by from meetings m where m.title = 'Besichtigung Elektriker'`);
  assert.equal(ev.created_by, morton.id);
  assert.equal(new Date(ev.starts_at).toISOString(), '2026-11-03T09:00:00.000Z', 'Uhrzeit gilt in Europe/Berlin');
  assert.ok(await t.db.maybeOne(`select 1 from meeting_tasks where meeting_id = $1 and task_id = $2`, [ev.id, ap.id]));
  assert.equal(String((await t.db.one(`select due_date from tasks where id = $1`, [other.id])).due_date instanceof Date ? (await t.db.one(`select due_date from tasks where id = $1`, [other.id])).due_date.toISOString().slice(0, 10) : ''), '2026-12-01', 'fremder Termin unverändert');
  assert.equal(await t.db.maybeOne(`select 1 from subprojects where name = 'Maler'`), null);
  const run = await t.db.one(`select error from agent_runs where task_id = $1 order by created_at desc limit 1`, [ap.id]);
  assert.match(run.error, /gibt es schon/);
  assert.match(run.error, /Agenten weist nur die Projektleitung zu/);
  assert.match(run.error, /YYYY-MM-DD/);
  assert.doesNotMatch(run.error, /außerhalb deines Bereichs|create_subproject/, 'Rollengrenzen sind keine Fehler mehr');
  // Rollengrenzen (fremder Termin, Teilprojekt) liegen der PL als Freigabe vor; ihr Klick führt mit ihrem Planrecht aus
  const held = (await t.db.query(`select id, action_class, payload from ai_proposals where task_id = $1 and kind = 'agent_action' and status = 'pending' order by seq`, [ap.id])).rows;
  const heldDates = held.find((x: any) => x.payload.action.type === 'set_dates');
  const heldSp = held.find((x: any) => x.payload.action.type === 'create_subproject');
  assert.equal(heldDates?.action_class, 'foreign'); assert.equal(heldSp?.action_class, 'plan');
  assert.equal((await t.api(pl).post(`/ai/proposals/${heldDates.id}/approve`, {})).statusCode, 200);
  assert.equal(String((await t.db.one(`select due_date from tasks where id = $1`, [other.id])).due_date.toISOString().slice(0, 10)), '2026-12-24', 'nach Bestätigung der PL ausgeführt');
  assert.equal((await t.api(pl).post(`/ai/proposals/${heldSp.id}/reject`, { note: 'Kein Malerteilprojekt' })).statusCode, 200);
  assert.equal(await t.db.maybeOne(`select 1 from subprojects where name = 'Maler'`), null);
  const log = (await t.db.query(`select body from task_comments where task_id = $1 order by created_at`, [ap.id])).rows.map((x: any) => x.body).join('\n');
  assert.match(log, /Aufgabe angelegt: WEB-\d+ „Leitungen planen“, Termin 2026-11-06/);
  assert.match(log, /Termin vorläufig im Kalender: „Besichtigung Elektriker“ .*verbindlich erst nach Bestätigung/);
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'task.assigned' and title like '%Leitungen planen%'`, [t.ids.users.anna]));
});

test('Stellvertretende PL: Agent plant im ganzen Projekt, weist Agenten zu, ändert Termine; nie verantwortliche PL', async () => {
  const pl = await t.login('pl@demo.local');
  const m = await t.api(pl).put(`/projects/${web()}/members/${morton.id}`, { role: 'pl', isDeputy: false });
  assert.equal(m.json().membership.role, 'pl');
  assert.equal(m.json().membership.isDeputy, true);
  const ap = await t.db.one(`select id from tasks where title = 'Teilprojekt durchplanen'`);
  const other = await t.db.one(`select number from tasks where title = 'Fremdes AP'`);
  next = [
    A({ type: 'create_subproject', title: 'Maler', responsible: 'max@demo.local', startDate: '2026-12-01', dueDate: '2026-12-15' }),
    A({ type: 'create_milestone', title: 'Zimmer fertig', dueDate: '2026-12-20', subproject: 'Maler' }),
    A({ type: 'assign', ref: 'Material bestellen', responsible: 'Lotte' }),
    A({ type: 'set_dates', ref: `WEB-${other.number}`, dueDate: '2026-12-24' }),
    A({ type: 'create_ap', title: 'Wände streichen', subproject: 'Maler', responsible: 'max@demo.local' })
  ];
  const before = calls.length;
  const r = await t.api(pl).post(`/tasks/${ap.id}/agent-run?wait=1`);
  assert.equal(r.statusCode, 200, r.body);
  assert.match(calls[before].messages[0].content, /stellvertretende Projektleitung im Projekt WEB/);
  assert.ok(await t.db.maybeOne(`select 1 from subprojects s join users u on u.id = s.responsible_user_id where s.name = 'Maler' and u.email = 'max@demo.local'`));
  assert.ok(await t.db.maybeOne(`select 1 from milestones where name = 'Zimmer fertig'`));
  const lotte = await t.db.one(`select u.name from tasks t join users u on u.id = t.responsible_user_id where t.title = 'Material bestellen'`);
  assert.equal(lotte.name, 'Lotte');
  const due = (await t.db.one(`select due_date from tasks where number = $1 and project_id = $2`, [other.number, web()])).due_date;
  assert.equal(due instanceof Date ? due.toISOString().slice(0, 10) : String(due).slice(0, 10), '2026-12-24');
  assert.ok(await t.db.maybeOne(`select 1 from tasks t join subprojects s on s.id = t.subproject_id where t.title = 'Wände streichen' and s.name = 'Maler'`));
  assert.equal(r.json().error, undefined, r.body);
  // Unveränderte Agenten-Verantwortung blockiert andere Teilprojekt-Änderungen durch Planer ohne PL-Rolle nicht
  const max = await t.login('max@demo.local');
  assert.equal((await t.api(max).patch(`/projects/${web()}/subprojects/${elektrik}`, { name: 'Elektrik EG', responsibleUserId: morton.id })).statusCode, 200);
});

test('Verantwortliche PL tritt zurück: Nachfolge nur durch Personen, nie durch einen Agenten', async () => {
  const admin = await t.login('admin@demo.local');
  const anna = await t.login('anna@demo.local');
  const erp = t.ids.projects.erp;
  const bot = (await t.api(admin).post('/agents', { name: 'Bot' })).json().agent;
  await t.api(anna).put(`/projects/${erp}/members/${bot.id}`, { role: 'pl' });
  const r = await t.api(anna).put(`/projects/${erp}/members/${t.ids.users.anna}`, { role: 'member' });
  assert.equal(r.statusCode, 400, 'nur ein Agent als weitere PL');
  const lead = await t.db.one(`select user_id from project_members where project_id = $1 and role = 'pl' and not is_deputy`, [erp]);
  assert.equal(lead.user_id, t.ids.users.anna);
});

test('Fragen per Chat: Eskalation und chat-Aktion kommen als Direktnachricht an, Antworten stehen im nächsten Lauf', async () => {
  const pl = await t.login('pl@demo.local');
  const ap = await t.db.one(`select id, number from tasks where title = 'Teilprojekt durchplanen'`);
  next = [
    A({ type: 'escalate', text: 'Welches Budget gilt?' }),
    A({ type: 'chat', to: ['anna@demo.local', 'projekt'], text: 'Wer kennt einen Elektriker?' }),
    A({ type: 'chat', to: ['niemand@extern.de'], text: 'x' })
  ];
  const r = await t.api(pl).post(`/tasks/${ap.id}/agent-run?wait=1`);
  assert.equal(r.statusCode, 200, r.body);
  const dmOf = async (userId: string) => (await t.db.query(`select m.body from chat_messages m join chat_channels c on c.id = m.channel_id and c.kind = 'dm' join chat_channel_members a on a.channel_id = c.id and a.user_id = $1 join chat_channel_members b on b.channel_id = c.id and b.user_id = $2 where m.user_id = $1 order by m.created_at`, [morton.id, userId])).rows.map((x: any) => x.body);
  assert.ok((await dmOf(t.ids.users.pl)).some((b: string) => /Welches Budget gilt\?/.test(b)), 'Eskalation per Chat an die PL');
  assert.ok((await dmOf(t.ids.users.anna)).some((b: string) => /Elektriker/.test(b)));
  assert.ok(await t.db.maybeOne(`select 1 from chat_messages m join chat_channels c on c.id = m.channel_id where c.project_id = $1 and m.user_id = $2 and m.body like '%Elektriker%'`, [web(), morton.id]), 'Projektkanal');
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'chat.dm' and title like '%Morton%'`, [t.ids.users.anna]));
  assert.match((await t.db.one(`select error from agent_runs where task_id = $1 order by created_at desc limit 1`, [ap.id])).error, /niemand@extern.de ist kein Mitglied/);
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and body like 'Per Chat an Anna Berger, Projektkanal:%'`, [ap.id]));
  // Antwort der PL im Chat: steht im Kontext des nächsten Laufs
  const dm = (await t.api(pl).post('/chat/dm', { userId: morton.id })).json().channelId;
  next = [A({ type: 'none', reason: 'x' })];
  await t.api(pl).post(`/chat/channels/${dm}/messages`, { body: 'Budget sind 4.000 €.' });
  await flushAgentRuns();
  // Rückmeldung auf die Frage zum Arbeitspaket steht im Log (Quelle Chat)
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and source = 'chat' and user_id = $2 and body = 'Rückmeldung per Chat an Morton: Budget sind 4.000 €.'`, [ap.id, t.ids.users.pl]));
  // … und der Agent antwortet trotzdem im Chat (die Nachricht wird nicht verschluckt); der Chat-Lauf weiß, dass sie schon im Log steht
  assert.ok(await t.db.maybeOne(`select 1 from chat_messages where channel_id = $1 and user_id = $2 and created_at >= (select max(created_at) from chat_messages where channel_id = $1 and user_id = $3)`, [dm, morton.id, t.ids.users.pl]), 'Chat-Antwort');
  const chatPrompt = calls.filter((c) => c.response_format && String(c.messages[0].content).includes('Man erreicht dich im Chat')).pop();
  assert.match(chatPrompt.messages[1].content, new RegExp(`steht bereits als Rückmeldung im Log von WEB-${ap.number}`));
  const before = calls.length;
  await t.api(pl).post(`/tasks/${ap.id}/agent-run?wait=1`);
  const prompt = calls.slice(before).find((c) => c.response_format && !String(c.messages[0].content).includes('Man erreicht dich im Chat'));
  assert.match(prompt.messages[1].content, /Chat \(deine Direktnachrichten[\s\S]*Petra Lenz: Budget sind 4\.000 €/);
  // Erste Antwort älter als zwei Stunden: neue Nachricht ist wieder normaler Chat, nicht Rückmeldung zum AP
  await t.db.query(`update chat_messages set created_at = created_at - interval '3 hours' where channel_id = $1`, [dm]);
  await t.api(pl).post(`/chat/channels/${dm}/messages`, { body: 'Wie läuft es sonst?' });
  await flushAgentRuns();
  assert.equal(await t.db.maybeOne(`select 1 from task_comments where body like '%Wie läuft es sonst?%'`), null);
});

test('Termine: KI trägt nur vorläufig ein, eine Person bestätigt; Ansprechpartner und Belegt-Zeiten im Prompt; Versandstatus schreibt das System', async () => {
  const pl = await t.login('pl@demo.local');
  const leser = await t.login('leser@demo.local');
  const ap = await t.db.one(`select id, number from tasks where title = 'Teilprojekt durchplanen'`);
  const ev = (await t.api(pl).get(`/projects/${web()}/meetings`)).json().meetings.find((m: any) => m.title === 'Besichtigung Elektriker');
  assert.equal(ev.tentative, true, 'von der KI angelegt: vorläufig');
  const inv = await t.api(pl).post(`/meetings/${ev.id}/invite`);
  assert.equal(inv.statusCode, 400);
  assert.match(inv.body, /vorläufig/);
  assert.match((await t.api(pl).get(`/meetings/${ev.id}/ics`)).body, /STATUS:TENTATIVE/);
  assert.equal((await t.api(leser).post(`/meetings/${ev.id}/confirm`)).statusCode, 403);
  next = [A({ type: 'none', reason: 'x' })];
  const c = await t.api(pl).post(`/meetings/${ev.id}/confirm`);
  assert.equal(c.statusCode, 200, c.body);
  assert.equal(c.json().meeting.tentative, false);
  assert.ok(c.json().meeting.confirmedAt);
  await flushAgentRuns();
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and body like 'Termin bestätigt: „Besichtigung Elektriker“%'`, [ap.id]));
  assert.ok(await t.db.maybeOne(`select 1 from agent_runs where task_id = $1 and trigger = 'answer'`, [ap.id]), 'Agent erfährt die Bestätigung (Antwort auf seine Bestätigungsfrage)');
  assert.equal((await t.db.one(`select status, answer_source from questions where meeting_id = $1`, [ev.id])).status, 'answered', 'Bestätigungsfrage ist beantwortet');

  // Prompt: Ansprechpartner (Teilprojekt-Verantwortung ist der Agent selbst → PL) und deren Belegt-Zeiten aus anderen Projekten ohne Titel
  const soon = new Date(Date.now() + 7 * 86400_000);
  await t.db.query(`insert into meetings (project_id, title, starts_at, ends_at, attendees, created_by) values ($1,'Lenkungskreis geheim',$2,$3,$4,$5)`, [t.ids.projects.erp, soon, new Date(soon.getTime() + 3600_000), JSON.stringify([{ email: 'pl@demo.local', name: 'Petra Lenz', userId: t.ids.users.pl }]), t.ids.users.anna]);
  // Mail ohne Senderecht: Entwurf, das System schreibt „nicht gesendet“ ins Log; mit Senderecht: „gesendet“
  await t.db.query(`update project_members set agent_can_mail = false where project_id = $1 and user_id = $2`, [web(), morton.id]);
  next = [A({ type: 'mail', to: ['elektro@extern.de'], subject: 'Angebot Elektrik', text: 'Bitte um Angebot.' })];
  const before = calls.length;
  await t.api(pl).post(`/tasks/${ap.id}/agent-run?wait=1`);
  const prompt = String(calls.slice(before).find((x) => x.response_format).messages[1].content);
  assert.match(prompt, /Ansprechpartner für Rückfragen und Terminzusagen: Petra Lenz <pl@demo.local> \(Projektleitung\)/);
  assert.match(prompt, /Belegt \(Petra Lenz: Termine, Belegungen, Abwesenheiten, ohne Details\): /);
  assert.ok(!prompt.includes('Lenkungskreis geheim'), 'keine fremden Titel');
  await t.db.query(`update project_members set agent_can_mail = true where project_id = $1 and user_id = $2`, [web(), morton.id]);
  // Der erste Kontakt (Adresse ohne Bezug zum AP) bleibt ein Entwurf, bis die PL ihn sendet; danach hat die Adresse Bezug (Mail am AP)
  const first = await t.db.one(`select id from mail_drafts where task_id = $1 and subject = 'Angebot Elektrik'`, [ap.id]);
  assert.equal((await t.api(pl).post(`/mail/drafts/${first.id}/send`)).statusCode, 200);
  next = [A({ type: 'mail', to: ['elektro@extern.de'], subject: 'Angebot Elektrik 2', text: 'Bitte um Angebot.' })];
  await t.api(pl).post(`/tasks/${ap.id}/agent-run?wait=1`);
  const log = (await t.db.query(`select body from task_comments where task_id = $1 order by created_at`, [ap.id])).rows.map((x: any) => x.body).join('\n');
  assert.match(log, /Mail-Entwurf an elektro@extern\.de wartet auf Freigabe \(nicht gesendet\): „Angebot Elektrik“/);
  assert.match(log, /Mail gesendet an elektro@extern\.de: „Angebot Elektrik 2“/);
});

test('Termine verschieben, absagen und einladen; Frage mit Frist an ein Mitglied außerhalb der Kette', async () => {
  const pl = await t.login('pl@demo.local');
  const ap = await t.db.one(`select id, number from tasks where title = 'Teilprojekt durchplanen'`);
  // vorläufigen Termin ohne Uhrzeit anlegen (deutsche Spanne), dann verschieben und absagen
  next = [A({ type: 'create_event', title: 'Vor-Ort-Termin AirGPU', startsAt: '6.–8.11.', location: 'Rechenzentrum' })];
  await t.api(pl).post(`/tasks/${ap.id}/agent-run?wait=1`);
  let ev = await t.db.one(`select * from meetings where title = 'Vor-Ort-Termin AirGPU'`);
  assert.equal(ev.tentative, true);
  assert.equal(new Date(ev.ends_at).getTime() > new Date(ev.starts_at).getTime() + 2 * 86400_000, true, 'über drei Tage');
  next = [A({ type: 'update_event', meetingId: ev.id, startsAt: '2026-11-09T10:00', endsAt: '2026-11-09T12:00' })];
  await t.api(pl).post(`/tasks/${ap.id}/agent-run?wait=1`);
  ev = await t.db.one(`select * from meetings where id = $1`, [ev.id]);
  assert.equal(new Date(ev.starts_at).toISOString(), '2026-11-09T09:00:00.000Z');
  next = [A({ type: 'cancel_event', meetingId: ev.id, reason: 'Kunde sagt ab' })];
  await t.api(pl).post(`/tasks/${ap.id}/agent-run?wait=1`);
  assert.equal(await t.db.maybeOne(`select 1 from meetings where id = $1`, [ev.id]), null);
  const log = (await t.db.query(`select body from task_comments where task_id = $1 order by created_at`, [ap.id])).rows.map((x: any) => x.body).join('\n');
  assert.match(log, /Termin geändert: „Vor-Ort-Termin AirGPU“/);
  assert.match(log, /Termin abgesagt: „Vor-Ort-Termin AirGPU“ .* Kunde sagt ab/);
  // Einladung zu einem bestätigten Termin
  const confirmed = await t.db.one(`select id from meetings where title = 'Besichtigung Elektriker'`);
  next = [A({ type: 'send_invite', meetingId: confirmed.id, text: 'Bitte vormerken.' })];
  await t.api(pl).post(`/tasks/${ap.id}/agent-run?wait=1`);
  assert.ok((await t.db.one(`select invite_sent_at from meetings where id = $1`, [confirmed.id])).invite_sent_at, 'Einladung gesendet');
  // Frage mit Frist an ein Projektmitglied, das nicht in der Kette steht
  next = [A({ type: 'ask', text: 'Max, bestätigt der Kunde den Termin bis Freitag?', kind: 'question', to: 'max@demo.local' })];
  await t.api(pl).post(`/tasks/${ap.id}/agent-run?wait=1`);
  const q = await t.db.one(`select addressee_id, remind_at from questions where task_id = $1 and body like 'Max, bestätigt%'`, [ap.id]);
  assert.equal(q.addressee_id, t.ids.users.max); assert.ok(q.remind_at, 'mit Frist und Nachfassen');
});

test('Ereignisläufe halten das Tagesbudget ein', async () => {
  const admin = await t.login('admin@demo.local');
  const ap = await t.db.one(`select id from tasks where title = 'Teilprojekt durchplanen'`);
  const used = (await t.db.one(`select count(*)::int as c from agent_runs where agent_user_id = $1 and created_at >= current_date`, [morton.id])).c;
  await t.api(admin).put('/ai/settings', { agentDailyBudget: used });
  next = [A({ type: 'none', reason: 'x' })];
  queueAgentRun(ap.id, 'comment');
  await flushAgentRuns();
  assert.equal((await t.db.one(`select count(*)::int as c from agent_runs where agent_user_id = $1 and created_at >= current_date`, [morton.id])).c, used, 'kein Lauf über dem Budget');
  await t.api(admin).put('/ai/settings', { agentDailyBudget: 50 });
});

test('Anlass im Prompt: Änderung seit dem letzten Lauf und regelmäßige Durchsicht haben eigene Texte', async () => {
  const ap = await t.db.one(`select id from tasks where title = 'Teilprojekt durchplanen'`);
  next = [A({ type: 'none', reason: 'x' })];
  const promptOf = (from: number) => String(calls.slice(from).find((c) => c.response_format && String(c.messages[1].content).includes('„Teilprojekt durchplanen“ · Status'))?.messages[1].content ?? '');
  const lastTrigger = async () => (await t.db.one(`select trigger from agent_runs where task_id = $1 order by created_at desc limit 1`, [ap.id])).trigger;
  // Kommentar ohne Sofortlauf (z. B. während einer Pause): der Worker erkennt die Änderung am Fingerabdruck
  await t.db.query(`insert into task_comments (task_id, user_id, body) values ($1,$2,'Elektriker kommt am Dienstag.')`, [ap.id, t.ids.users.pl]);
  let before = calls.length;
  await runAgents(t.db, t.mail, fakeFetch, new Date(Date.now() + 3600_000));
  assert.equal(await lastTrigger(), 'changed');
  assert.match(promptOf(before), /Anlass dieses Laufs: Seit deinem letzten Lauf hat sich am Arbeitspaket etwas geändert/);
  // Drei Tage ohne Lauf und ohne Änderung: regelmäßige Durchsicht
  before = calls.length;
  await runAgents(t.db, t.mail, fakeFetch, new Date(Date.now() + 73 * 3600_000));
  assert.equal(await lastTrigger(), 'periodic');
  assert.match(promptOf(before), /Anlass dieses Laufs: Regelmäßige Durchsicht: seit drei Tagen kein Lauf/);
});

test('Kleine Modelle: Beschreibung pflegen, Frage an Externe geht an die Kette, Termin ohne Titel, vorhandenes Teilprojekt, Jahr aus der Vergangenheit', async () => {
  const pl = await t.login('pl@demo.local');
  const ap = await t.db.one(`select id, title, subproject_id from tasks where title = 'Teilprojekt durchplanen'`);
  const sp = await t.db.one(`select name from subprojects where id = $1`, [ap.subproject_id]);
  next = [
    A({ type: 'describe', text: 'Ziel: Plan für das Teilprojekt. Stand: Termine offen.' }),
    A({ type: 'ask', text: 'Passt der 24.10.?', kind: 'question', to: 'kunde@extern.de' }),
    A({ type: 'create_event', startsAt: '2024-10-28T10:00' }),
    A({ type: 'create_subproject', title: sp.name })
  ];
  const run = (await t.api(pl).post(`/tasks/${ap.id}/agent-run?wait=1`)).json();
  assert.equal(run.error, undefined, run.error);
  assert.equal((await t.db.one(`select description from tasks where id = $1`, [ap.id])).description, 'Ziel: Plan für das Teilprojekt. Stand: Termine offen.');
  const q = await t.db.one(`select addressee_id, body from questions where task_id = $1 and body like 'Passt der 24.10.?%'`, [ap.id]);
  assert.ok(q.addressee_id, 'an die Kette statt verworfen');
  assert.match(q.body, /Eigentlich an kunde@extern\.de gedacht/);
  const ev = await t.db.one(`select starts_at from meetings where title = $1`, [ap.title]);
  assert.equal(new Date(ev.starts_at).getUTCFullYear(), 2026);
});

test('resolve mit erfundener questionId: genau eine offene Frage wird erledigt, ohne offene Frage kein Fehler; Titel mit eigener Kennung bereinigt', async () => {
  const pl = await t.login('pl@demo.local');
  const ap = await t.db.one(`select id from tasks where title = 'Teilprojekt durchplanen'`);
  await t.db.query(`update questions set status = 'answered' where task_id = $1 and status = 'open'`, [ap.id]);
  next = [A({ type: 'ask', text: 'Kommt der Kunde am Montag?', kind: 'question' })];
  await t.api(pl).post(`/tasks/${ap.id}/agent-run?wait=1`);
  next = [A({ type: 'resolve', questionId: 'frage-1', text: 'per Mail bestätigt' })];
  let run = (await t.api(pl).post(`/tasks/${ap.id}/agent-run?wait=1`)).json();
  assert.equal(run.error, undefined, run.error);
  assert.equal((await t.db.one(`select count(*)::int as c from questions where task_id = $1 and status = 'open'`, [ap.id])).c, 0);
  next = [A({ type: 'resolve', questionId: 'frage-2', text: 'x' })];
  run = (await t.api(pl).post(`/tasks/${ap.id}/agent-run?wait=1`)).json();
  assert.equal(run.error, undefined, 'nichts offen: kein Fehler');
  // Migration 066: „WEB-0: …“ verliert die eigene Kennung, fremde Kürzel bleiben
  await t.db.query(`update tasks set title = 'WEB-0: Termin Hardwareauslagerung' where id = $1`, [ap.id]);
  const other = await t.db.one(`select id from tasks where id <> $1 and project_id = (select project_id from tasks where id = $1) limit 1`, [ap.id]);
  await t.db.query(`update tasks set title = 'AGP-3: fremd' where id = $1`, [other.id]);
  await t.db.query(readFileSync(new URL('../migrations/066_clean_titles.sql', import.meta.url), 'utf8'));
  assert.equal((await t.db.one(`select title from tasks where id = $1`, [ap.id])).title, 'Termin Hardwareauslagerung');
  assert.equal((await t.db.one(`select title from tasks where id = $1`, [other.id])).title, 'AGP-3: fremd');
});
