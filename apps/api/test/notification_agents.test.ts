import test from 'node:test';
import assert from 'node:assert/strict';
import { composeEcho, testApp } from './helpers.js';
import { flushAgentRuns } from '../src/ai/agentEvents.js';
import { localParts } from '../src/localTime.js';

/** Lokales LLM: Läufe am AP liefern die Aktionen aus `next`, Chat-Läufe eine kurze Antwort. */
let next: any[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (String(input) !== 'http://llm.local:8000/v1/chat/completions') return new Response('{}', { status: 404 });
  const echo = composeEcho(body);
  if (echo) return echo;
  const chat = Boolean(body.response_format?.json_schema?.schema?.properties?.reply);
  const content = !body.response_format ? 'bereit' : JSON.stringify(chat ? { reply: 'Gern.', notes: [] } : { note: 'erledigt', actions: next });
  return new Response(JSON.stringify({ model: 'qwen', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
};
delete process.env.ANTHROPIC_API_KEY;
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());

const A = (x: Record<string, unknown>) => ({ type: 'none', text: null, column: null, itemId: null, to: null, subject: null, reason: null, kind: null, checkAfterHours: null, until: null, remindAfterHours: null, escalateAfterHours: null, pageId: null, title: null, folder: null, status: null, ref: null, responsible: null, startDate: null, dueDate: null, subproject: null, items: null, startsAt: null, endsAt: null, location: null, ...x });
const web = () => t.ids.projects.web;
const U = () => t.ids.users;
const progress = (userId: string, taskId: string) => t.db.query(`select * from notifications where user_id = $1 and ref_id = $2 and type = 'task.progress' order by created_at`, [userId, taskId]).then((r) => r.rows);
let morton: any;
let ap: any;

test('Zwischenstände: Berichtswunsch am AP (für mich und für das AP), every je Person, Inhalt aus den ausgeführten Aktionen', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const p = (await t.api(admin).post('/ai/profiles', { name: 'Qwen', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'qwen' })).json().profile;
  await t.api(admin).put('/ai/settings', { defaultProfileId: p.id, agentDailyBudget: 50 });
  morton = (await t.api(admin).post('/agents', { name: 'Morton' })).json().agent;
  await t.api(pl).put(`/projects/${web()}/members/${morton.id}`, { role: 'member' });
  ap = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Elektriker recherchieren', responsibleUserId: morton.id })).json().task;
  await flushAgentRuns();
  const run = async (...actions: any[]) => { next = actions; const r = await t.api(pl).post(`/tasks/${ap.id}/agent-run`); assert.equal(r.statusCode, 200, r.body); };

  // Ohne Wunsch (Standard: Auftraggeber, den es noch nicht gibt) bekommt niemand Zwischenstände
  await run(A({ type: 'comment', text: 'Drei Betriebe angefragt' }));
  assert.equal((await t.db.query(`select 1 from notifications where type = 'task.progress'`)).rows.length, 0);
  // Max: jeder Zwischenstand, sofort per Mail
  const wish = await t.api(max).put(`/me/notification-rules?taskId=${ap.id}`, { rules: [{ event: 'progress', channels: { mail: 'now' }, timing: { every: 'each' } }] });
  assert.equal(wish.statusCode, 200, wish.body);
  await run(A({ type: 'comment', text: 'Angebot von Elektro Süd liegt vor' }));
  let mx = await progress(U().max, ap.id);
  assert.equal(mx.length, 1);
  assert.deepEqual([mx[0].event, mx[0].mail], ['progress', 'now']);
  assert.match(mx[0].body, /Log: Angebot von Elektro Süd liegt vor/);
  assert.match(mx[0].title, /^Zwischenstand WEB-\d+: Elektriker recherchieren$/);
  // Die PL stellt am AP ein: an die PL, nur Meilensteine; Max behält „jeder Zwischenstand“ (spezifischster Wunsch)
  assert.equal((await t.api(pl).put(`/tasks/${ap.id}/notification-rules`, { rules: [{ event: 'progress', recipients: ['pl'], timing: { every: 'milestones' } }] })).statusCode, 200);
  await run(A({ type: 'add_item', text: 'Vergleich erstellen' }));
  assert.equal((await progress(U().max, ap.id)).length, 2);
  assert.equal((await progress(U().pl, ap.id)).length, 0, 'kein Meilenstein');
  await run(A({ type: 'set_status', column: 'In Arbeit' }));
  assert.equal((await progress(U().pl, ap.id)).length, 1, 'Statuswechsel ist ein Meilenstein');
  assert.equal((await progress(U().max, ap.id)).length, 3);
  // Max nur noch den Abschluss
  await t.api(max).put(`/me/notification-rules?taskId=${ap.id}`, { rules: [{ event: 'progress', channels: { mail: 'digest' }, timing: { every: 'done' } }] });
  await run(A({ type: 'set_status', column: 'In Prüfung' }));
  assert.equal((await progress(U().max, ap.id)).length, 3, 'kein Abschluss');
  assert.equal((await progress(U().pl, ap.id)).length, 2);
  await run(A({ type: 'set_status', column: 'Erledigt' }));
  mx = await progress(U().max, ap.id);
  assert.equal(mx.length, 4);
  assert.equal(mx[3].mail, 'digest');
  // Wunsch entfernt: nichts mehr (die PL bekommt weiter ihre Meilensteine)
  await t.api(max).put(`/me/notification-rules?taskId=${ap.id}`, { rules: [{ event: 'progress' }] });
  await run(A({ type: 'set_status', column: 'In Arbeit' }));
  assert.equal((await progress(U().max, ap.id)).length, 4);
  assert.equal((await progress(U().pl, ap.id)).length, 4);
  // Einmal am Tag: zwei Läufe mit Inhalt am selben Tag ergeben eine Meldung (Dedupe je AP und Tag)
  await t.api(max).put(`/me/notification-rules?taskId=${ap.id}`, { rules: [{ event: 'progress', channels: { mail: 'digest' }, timing: { every: 'daily' } }] });
  await run(A({ type: 'comment', text: 'Rückruf bei Elektro Nord' }));
  await run(A({ type: 'comment', text: 'Angebot von Elektro Nord liegt vor' }));
  mx = await progress(U().max, ap.id);
  assert.equal(mx.length, 5);
  assert.equal(mx[4].dedupe_key, `progress:${ap.id}:${localParts(new Date()).date}`);
  assert.equal((await progress(U().pl, ap.id)).length, 4, 'Kommentare sind keine Meilensteine');
  await t.api(max).put(`/me/notification-rules?taskId=${ap.id}`, { rules: [{ event: 'progress' }] });
  // Nichts Inhaltliches (nur none) → kein Zwischenstand
  await run(A({ type: 'none', reason: 'nichts zu tun' }));
  assert.equal((await progress(U().pl, ap.id)).length, 4);
  // Chat „thread“ (Standard für Zwischenstände) ohne Auftragsthread: Systembeitrag in der Direktnachricht des Agenten
  const sys = await t.db.query(`select m.body from chat_messages m join chat_channel_members x on x.channel_id = m.channel_id and x.user_id = $2 where m.user_id = $1 and m.kind = 'system' and m.meta->>'event' = 'progress'`, [morton.id, U().pl]);
  assert.equal(sys.rows.length, 4);
  await t.api(pl).put(`/tasks/${ap.id}/notification-rules`, { rules: [{ event: 'progress' }] });
});

test('Entscheidung des Agenten: Empfänger nach Regel N, Direktnachricht genau an diese, ohne doppelten Systembeitrag', async () => {
  const pl = await t.login('pl@demo.local');
  const dmFrom = async (userId: string) => (await t.db.query(
    `select m.body, m.kind from chat_messages m join chat_channels c on c.id = m.channel_id and c.kind = 'dm' join chat_channel_members x on x.channel_id = c.id and x.user_id = $2 where m.user_id = $1 order by m.created_at`, [morton.id, userId])).rows;
  next = [A({ type: 'escalate', text: 'Budget für Elektro Süd freigeben?' })];
  await t.api(pl).post(`/tasks/${ap.id}/agent-run`);
  const n1 = (await t.db.query(`select * from notifications where type = 'escalation' and ref_id = $1 and body like 'Budget%'`, [ap.id])).rows;
  assert.deepEqual(n1.map((n: any) => [n.user_id, n.event, n.mail]), [[U().pl, 'decision', 'now']], 'Standard: verantwortliche PL');
  const budget = (await dmFrom(U().pl)).filter((m: any) => m.body.includes('Budget für Elektro Süd'));
  assert.deepEqual(budget.map((m: any) => m.kind), ['user'], 'Direktnachricht des Agenten, kein zusätzlicher Systembeitrag');
  // Projekt: Entscheidungen an PL und Stellvertretung
  await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: 'decision', recipients: ['pl', 'deputy_pl'] }] });
  next = [A({ type: 'escalate', text: 'Termin mit Elektro Süd zusagen?' })];
  await t.api(pl).post(`/tasks/${ap.id}/agent-run`);
  const n2 = (await t.db.query(`select user_id from notifications where type = 'escalation' and ref_id = $1 and body like 'Termin%'`, [ap.id])).rows.map((r: any) => r.user_id).sort();
  assert.deepEqual(n2, [U().pl, U().anna].sort());
  assert.equal((await dmFrom(U().anna)).filter((m: any) => m.body.includes('Termin mit Elektro Süd')).length, 1, 'Direktnachricht an die Stellvertretung');
  await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: 'decision' }] });
});

test('Chat „thread“ ohne eigenen Thread: Systembeitrag in der Direktnachricht des auslösenden Agenten; Systembeiträge lösen keinen Chat-Lauf aus', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const sysDm = async () => (await t.db.query(
    `select m.* from chat_messages m join chat_channels c on c.id = m.channel_id and c.kind = 'dm' join chat_channel_members x on x.channel_id = c.id and x.user_id = $2 where m.user_id = $1 and m.kind = 'system' and m.meta->>'event' = 'assigned' order by m.created_at`, [morton.id, U().max])).rows;
  // Standard (Zuweisung: Chat aus): keine Systemnachricht
  const ap2 = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Verteiler planen', responsibleUserId: morton.id })).json().task;
  await flushAgentRuns();
  next = [A({ type: 'create_aufgabe', title: 'Steckdosen zählen', responsible: 'max@demo.local', dueDate: '2026-11-20' })];
  assert.equal((await t.api(pl).post(`/tasks/${ap2.id}/agent-run`)).statusCode, 200);
  assert.equal((await sysDm()).length, 0);
  assert.equal((await t.db.query(`select 1 from notifications where user_id = $1 and type = 'task.assigned' and title like '%Steckdosen zählen'`, [U().max])).rows.length, 1);
  // Max möchte Meldungen als Chat-Beitrag: die Zuweisung durch den Agenten kommt in dessen Direktnachricht
  assert.equal((await t.api(max).put('/me/notification-rules', { rules: [{ event: '*', channels: { chat: 'thread' } }] })).statusCode, 200);
  next = [A({ type: 'create_aufgabe', title: 'Zähler ablesen', responsible: 'max@demo.local', dueDate: '2026-11-21' })];
  await t.api(pl).post(`/tasks/${ap2.id}/agent-run`);
  const sys = await sysDm();
  assert.equal(sys.length, 1);
  assert.match(sys[0].body, /Dir zugewiesen: Zähler ablesen/);
  assert.equal(sys[0].meta.event, 'assigned');
  await t.api(max).put('/me/notification-rules', { rules: [{ event: '*' }] });

  // Systembeitrag des Agenten im Projektkanal: eine Antwort im Thread holt den Agenten nicht ins Gespräch
  await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: 'assigned', channels: { chat: 'project' } }] });
  next = [A({ type: 'create_aufgabe', title: 'Kabel bestellen', responsible: 'max@demo.local', dueDate: '2026-11-22' })];
  await t.api(pl).post(`/tasks/${ap2.id}/agent-run`);
  const channel = (await t.api(max).get(`/projects/${web()}/chat`)).json();
  const root = channel.messages.find((m: any) => m.kind === 'system' && m.body.includes('Kabel bestellen'));
  assert.ok(root, 'Systembeitrag im Projektkanal');
  assert.equal(root.userId, morton.id);
  const runsBefore = (await t.db.one(`select count(*)::int as c from agent_runs where channel_id = $1`, [channel.channel.id])).c;
  assert.equal((await t.api(max).post(`/chat/channels/${channel.channel.id}/messages`, { body: 'Mache ich morgen', threadId: root.id })).statusCode, 200);
  await flushAgentRuns();
  assert.equal((await t.db.one(`select count(*)::int as c from agent_runs where channel_id = $1`, [channel.channel.id])).c, runsBefore, 'kein Chat-Lauf');
  // Gegenprobe: eine eigene Nachricht des Agenten im Thread holt ihn ins Gespräch
  await t.db.query(`insert into chat_messages (channel_id, user_id, thread_id, body) values ($1,$2,$3,'Bitte Bescheid geben')`, [channel.channel.id, morton.id, root.id]);
  await t.api(max).post(`/chat/channels/${channel.channel.id}/messages`, { body: 'Erledigt', threadId: root.id });
  await flushAgentRuns();
  assert.equal((await t.db.one(`select count(*)::int as c from agent_runs where channel_id = $1`, [channel.channel.id])).c, runsBefore + 1);
  await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: 'assigned' }] });
});

test('Seite „In Prüfung“ aus einem AP im eingeschränkten Teilprojekt: Freigabeberechtigte ohne Sicht auf das TP bekommen die Meldung (die Seite gehört dem Projekt)', async () => {
  const pl = await t.login('pl@demo.local');
  assert.equal((await t.api(pl).put(`/projects/${web()}/members/${U().max}`, { role: 'member', canEditPlan: true, canFinalize: true })).statusCode, 200);
  const sp = await t.api(pl).post(`/projects/${web()}/subprojects`, { name: 'Geheim', restricted: true, accessUserIds: [morton.id] });
  assert.equal(sp.statusCode, 200, sp.body);
  const secret = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Vertrauliche Seite prüfen lassen', subprojectId: sp.json().subproject.id, responsibleUserId: morton.id })).json().task;
  await flushAgentRuns();
  const page = await t.db.one(`select id, title from doc_pages where project_id = $1 and status = 'draft' and deleted_at is null order by created_at limit 1`, [web()]);
  next = [A({ type: 'doc_status', pageId: page.id, status: 'review' })];
  assert.equal((await t.api(pl).post(`/tasks/${secret.id}/agent-run`)).statusCode, 200);
  assert.equal((await t.db.one(`select status from doc_pages where id = $1`, [page.id])).status, 'review');
  const review = (userId: string) => t.db.query(`select * from notifications where user_id = $1 and type = 'page.review' and ref_id = $2`, [userId, page.id]).then((r) => r.rows);
  assert.equal((await review(U().max)).length, 1, 'Max darf final setzen, sieht das TP aber nicht');
  assert.equal((await review(U().pl)).length, 1);
  assert.equal((await review(U().leser)).length, 0, 'ohne Recht nichts');
  await t.api(pl).put(`/projects/${web()}/members/${U().max}`, { role: 'member', canEditPlan: true });
});
