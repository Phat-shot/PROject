import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { runAgents } from '../src/ai/agent.js';
import { flushAgentRuns, queueAgentRun } from '../src/ai/agentEvents.js';

/** Lokales LLM: liefert die Aktionen aus `next`, merkt sich jede Anfrage. */
const calls: any[] = [];
let next: any[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (String(input) !== 'http://llm.local:8000/v1/chat/completions') return new Response('{}', { status: 404 });
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
  await t.api(admin).put('/ai/settings', { defaultProfileId: p.id, agentDailyBudget: 50 });
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
  assert.equal((await t.api(pl).post(`/tasks/${ap.id}/agent-run`)).statusCode, 200);
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
    A({ type: 'create_aufgabe', title: 'Kaputt', dueDate: '24.12.2026' })
  ];
  const r = await t.api(pl).post(`/tasks/${ap.id}/agent-run`);
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
  assert.match(run.error, /außerhalb deines Bereichs/);
  assert.match(run.error, /Agenten weist nur die Projektleitung zu/);
  assert.match(run.error, /create_subproject „Maler“: nur als stellvertretende PL/);
  assert.match(run.error, /YYYY-MM-DD/);
  const log = (await t.db.query(`select body from task_comments where task_id = $1 order by created_at`, [ap.id])).rows.map((x: any) => x.body).join('\n');
  assert.match(log, /Aufgabe angelegt: WEB-\d+ „Leitungen planen“, Termin 2026-11-06/);
  assert.match(log, /Termin im Kalender: „Besichtigung Elektriker“/);
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
  const r = await t.api(pl).post(`/tasks/${ap.id}/agent-run`);
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
  const r = await t.api(pl).post(`/tasks/${ap.id}/agent-run`);
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
  await t.api(pl).post(`/chat/channels/${dm}/messages`, { body: 'Budget sind 4.000 €.' });
  next = [A({ type: 'none', reason: 'x' })];
  const before = calls.length;
  await t.api(pl).post(`/tasks/${ap.id}/agent-run`);
  const prompt = calls.slice(before).find((c) => c.response_format && !String(c.messages[0].content).includes('Man erreicht dich im Chat'));
  assert.match(prompt.messages[1].content, /Chat \(deine Direktnachrichten[\s\S]*Petra Lenz: Budget sind 4\.000 €/);
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
