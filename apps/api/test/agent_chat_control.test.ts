import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { flushAgentRuns } from '../src/ai/agentEvents.js';
import { claimCheck } from '../src/ai/agentChat.js';

/** Lokales LLM: Chat-Läufe liefern reply und `nextCommands`, Arbeitspaket-Läufe keine Aktion. */
const prompts: string[] = [];
let nextCommands: any[] = [];
let nextReply = 'Mache ich.';
const C = (x: Record<string, unknown>) => ({ type: 'note', ref: '', text: '', title: '', parent: '', subproject: '', dueDate: '', deliverables: [], every: '', level: '', mode: '', reason: '', mail: false, ...x });
const fakeFetch: typeof fetch = async (input, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (String(input) !== 'http://llm.local:8000/v1/chat/completions') return new Response('{}', { status: 404 });
  const system = body.messages?.[0]?.content ?? '';
  let content = 'bereit';
  if (body.response_format && system.includes('Man erreicht dich im Chat')) {
    prompts.push(String(body.messages?.[1]?.content ?? ''));
    content = JSON.stringify({ reply: nextReply, notes: [], answers: [], commands: nextCommands });
    nextCommands = []; nextReply = 'Mache ich.';
  } else if (body.response_format) content = JSON.stringify({ note: 'nichts zu tun', actions: [{ type: 'none', reason: 'Test' }] });
  return new Response(JSON.stringify({ model: 'qwen', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { status: 200 });
};
delete process.env.ANTHROPIC_API_KEY;
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());

const web = () => t.ids.projects.web;
let agent: any; let dmPl = ''; let dmMax = '';
const say = async (who: any, cid: string, body: string) => { const r = await t.api(who).post(`/chat/channels/${cid}/messages`, { body }); assert.equal(r.statusCode, 200, r.body); await flushAgentRuns(); return r.json().message?.id ?? r.json().id; };
const lastCard = (cid: string) => t.db.maybeOne(`select * from chat_messages where channel_id = $1 and kind = 'system' and meta->>'card' = 'results' order by created_at desc limit 1`, [cid]);

test('Vorbereitung: Agent als Mitglied, DMs; Kontext nennt Absenderrolle, Rechte, Policy und Fähigkeiten', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const p = (await t.api(admin).post('/ai/profiles', { name: 'Qwen', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'qwen' })).json().profile;
  await t.api(admin).put('/ai/settings', { agentDailyBudget: 50 });
  agent = (await t.api(admin).post('/agents', { name: 'Morton' })).json().agent;
  await t.api(pl).put(`/projects/${web()}/members/${agent.id}`, { role: 'member' });
  dmPl = (await t.api(pl).post('/chat/dm', { userId: agent.id })).json().channelId;
  dmMax = (await t.api(max).post('/chat/dm', { userId: agent.id })).json().channelId;
  await say(pl, dmPl, 'Hallo Morton, wie ist der Stand?');
  const ctx = prompts.at(-1) ?? '';
  assert.match(ctx, /Absender: Petra Lenz – Projektleitung; darf: Aufträge \(order, überall im Projekt\)/);
  assert.match(ctx, /Agenten-Policy im Projekt WEB: Selbstständigkeit: Selbstständig/);
  assert.match(ctx, /Fähigkeiten: Mails direkt \(Außenprüfung, erster Kontakt als Entwurf\); Online-Recherche nicht freigegeben/);
  assert.match(ctx, /Weitere offene Arbeitspakete im Thema/);
  // Gruß ohne Inhalt: kein Projektbezug (Konzept KI-Agent 6); eine Frage mit Inhalt bekommt das einzige gemeinsame Projekt
  await say(max, dmMax, 'Hi Morton');
  assert.match(prompts.at(-1) ?? '', /Thema: kein Projektbezug in der Nachricht/);
  await say(max, dmMax, 'Wie ist der Stand?');
  assert.match(prompts.at(-1) ?? '', /Absender: Max Keller – Mitglied; darf: keine Aufträge \(Policy chatOrders = pl/);
});

test('Auftrag der PL per Chat: AP mit Auftraggeber, Agent zuständig, Log, Berichtswunsch, Karte mit Rückgängig, Lauf mit Anlass order; Kette beginnt beim Auftraggeber', async () => {
  const pl = await t.login('pl@demo.local');
  nextCommands = [C({ type: 'order', title: 'Backup-Elektriker Edertal: Entscheidungsvorlage', text: '3 Elektriker aus dem Edertal recherchieren, vergleichen, Entscheidungsvorlage.', deliverables: ['3 Betriebe recherchieren', 'Vergleich', 'Entscheidungsvorlage'], every: 'each', mail: true })];
  nextReply = 'Ich lege das Arbeitspaket an und melde jeden Zwischenstand.';
  const mid = await say(pl, dmPl, 'Bitte 3 Elektriker aus dem Edertal recherchieren und eine Entscheidungsvorlage machen, jeden Zwischenstand per Mail.');
  const task = await t.db.one(`select * from tasks where title = 'Backup-Elektriker Edertal: Entscheidungsvorlage'`);
  assert.equal(task.requested_by, t.ids.users.pl);
  assert.equal(task.origin_message_id, mid);
  assert.equal(task.responsible_user_id, agent.id, 'Agent zuständig');
  assert.match(task.description, /^3 Elektriker aus dem Edertal recherchieren, vergleichen, Entscheidungsvorlage\.\n\n\*\*Auftrag von Petra Lenz im Wortlaut:\*\*\n> Bitte 3 Elektriker/, 'Fassung des Modells und Wortlaut');
  assert.equal((await t.db.one(`select count(*)::int as c from checklist_items where task_id = $1`, [task.id])).c, 3);
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and user_id = $2 and source = 'chat' and body like 'Auftrag von Petra Lenz per Chat:%'`, [task.id, t.ids.users.pl]));
  assert.ok(await t.db.maybeOne(`select 1 from agent_runs where task_id = $1 and trigger = 'order'`, [task.id]), 'Lauf mit Anlass order');
  const rule = await t.db.maybeOne(`select * from notification_rules where task_id = $1 and user_id = $2 and event = 'progress'`, [task.id, t.ids.users.pl]);
  assert.ok(rule, 'Berichtswunsch'); assert.equal(rule.timing.every, 'each'); assert.equal(rule.channels.mail, 'now');
  const card = await lastCard(dmPl);
  assert.ok(card, 'Systemkarte');
  assert.match(card.body, /✓ Angelegt: WEB-\d+ „Backup-Elektriker Edertal: Entscheidungsvorlage“ · zuständig Morton · Auftraggeber Petra Lenz/);
  assert.equal(card.meta.taskId, task.id); assert.ok(card.meta.undoUntil);
  const detail = (await t.api(pl).get(`/tasks/${task.id}`)).json().task;
  assert.equal(detail.requestedBy.userId, t.ids.users.pl);
  // Kette: Auftraggeber zuerst (Fragen des Agenten gehen an ihn)
  const { contactChain } = await import('../src/tasks/service.js');
  const chain = await contactChain(t.db, task, { exclude: [agent.id] });
  assert.equal(chain[0].id, t.ids.users.pl); assert.equal(chain[0].role, 'requester');
});

test('Auftrag mit geratener Kennung: unbekanntes Über-AP wird eigenes AP, Folgebefehle mit „neu“ oder unbekannter Kennung treffen den neuen Auftrag; Behauptung mit Datum bleibt nur bei Erfolg stehen', async () => {
  const pl = await t.login('pl@demo.local');
  nextCommands = [C({ type: 'report', ref: 'WEB-999', every: 'daily' }), C({ type: 'order', title: 'Termin AirGPU 6.–8.11.', text: 'Hardwareauslagerung', parent: 'WEB-0' }), C({ type: 'priority', ref: 'neu', level: 'hoch' })];
  nextReply = 'Philipp, ich habe den Auftrag für den Termin 6.–8.11. zur Hardwareauslagerung angelegt.';
  await say(pl, dmPl, 'Termin mit AirGPU 6.–8.11. zur Hardwareauslagerung');
  const task = await t.db.one(`select * from tasks where title = 'Termin AirGPU 6.–8.11.'`);
  assert.equal(task.parent_id, null, 'kein Über-AP');
  const card = await lastCard(dmPl);
  assert.match(card.body, /✓ Angelegt: WEB-\d+ „Termin AirGPU 6\.–8\.11\.“.*\(Über-AP WEB-0 gibt es nicht: als eigenes Arbeitspaket\)/);
  assert.doesNotMatch(card.body, /nicht gefunden/, 'report und priority treffen den neuen Auftrag');
  assert.ok(await t.db.maybeOne(`select 1 from notification_rules where task_id = $1 and event = 'progress'`, [task.id]), 'report am neuen AP');
  const reply = await t.db.one(`select body from chat_messages where channel_id = $1 and user_id = $2 and kind = 'user' order by created_at desc limit 1`, [dmPl, agent.id]);
  assert.doesNotMatch(reply.body, /konnte ich nicht ausführen/, 'Auftrag ausgeführt: Satz bleibt');
  await t.db.query(`update tasks set archived_at = now() where id = $1`, [task.id]);
  // Projektkürzel als Teilprojekt: ohne Teilprojekt, ohne Hinweis; unbekanntes Teilprojekt: angelegt mit Hinweis
  nextCommands = [C({ type: 'order', title: 'Rack-Plan AirGPU', text: 'Racks planen', subproject: 'WEB' })];
  await say(pl, dmPl, 'Bitte Rack-Plan');
  const t2 = await t.db.one(`select * from tasks where title = 'Rack-Plan AirGPU'`);
  assert.equal(t2.subproject_id, null);
  assert.doesNotMatch((await lastCard(dmPl)).body, /Teilprojekt|Nicht ausgeführt/);
  nextCommands = [C({ type: 'order', title: 'Kabel AirGPU', text: 'Kabel', subproject: 'Gibtsnicht' })];
  await say(pl, dmPl, 'Bitte Kabel');
  assert.ok(await t.db.maybeOne(`select 1 from tasks where title = 'Kabel AirGPU'`));
  assert.match((await lastCard(dmPl)).body, /✓ Angelegt: .*\(Teilprojekt „Gibtsnicht“ gibt es nicht: ohne Teilprojekt\)/);
  await t.db.query(`update tasks set archived_at = now() where title in ('Rack-Plan AirGPU', 'Kabel AirGPU')`);
});

test('Rückgängig innerhalb von 10 Minuten archiviert den Auftrag; danach nicht mehr', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const task = await t.db.one(`select * from tasks where title = 'Backup-Elektriker Edertal: Entscheidungsvorlage'`);
  assert.equal((await t.api(max).post(`/tasks/${task.id}/undo-order`)).statusCode, 400, 'nur Auftraggeber oder PL');
  assert.equal((await t.api(pl).post(`/tasks/${task.id}/undo-order`)).statusCode, 200);
  assert.ok((await t.db.one(`select archived_at from tasks where id = $1`, [task.id])).archived_at);
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and body like 'Auftrag zurückgenommen%'`, [task.id]));
  await t.db.query(`update tasks set archived_at = null, created_at = now() - interval '11 minutes' where id = $1`, [task.id]);
  assert.equal((await t.api(pl).post(`/tasks/${task.id}/undo-order`)).statusCode, 400, 'Frist abgelaufen');
});

test('Mitglied ohne Auftragsrecht: Vorschlag als Frage order_request an die PL; mit chatOrders = members legt es an; Dublette fragt nach', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  nextCommands = [C({ type: 'order', title: 'Lampen bestellen', text: 'Lampen für den Flur' })];
  await say(max, dmMax, 'Bestell bitte Lampen für den Flur.');
  let card = await lastCard(dmMax);
  assert.match(card.body, /◔ Vorschlag an die Projektleitung weitergegeben/);
  const q = await t.db.one(`select * from questions where kind = 'order_request' and status = 'open'`);
  assert.equal(q.asked_by, agent.id); assert.equal(q.addressee_id, t.ids.users.pl);
  assert.match(q.body, /Max Keller möchte beauftragen: Lampen bestellen/);
  assert.equal(await t.db.maybeOne(`select 1 from tasks where title = 'Lampen bestellen'`), null);
  // Freigabe über die Policy des Projekts
  assert.equal((await t.api(pl).put(`/projects/${web()}/agent-policy`, { mode: 'auto', chatOrders: 'members' })).statusCode, 200);
  nextCommands = [C({ type: 'order', title: 'Lampen bestellen', text: 'Lampen für den Flur' })];
  await say(max, dmMax, 'Bestell bitte Lampen für den Flur.');
  assert.match(prompts.at(-1) ?? '', /Max Keller – Mitglied; darf: Aufträge \(order\)/);
  const task = await t.db.one(`select * from tasks where title = 'Lampen bestellen'`);
  assert.equal(task.requested_by, t.ids.users.max); assert.equal(task.responsible_user_id, agent.id);
  // Dublette
  nextCommands = [C({ type: 'order', title: 'Lampen bestellen', text: 'nochmal' })];
  await say(max, dmMax, 'Lampen bestellen!');
  card = await lastCard(dmMax);
  assert.match(card.body, /✗ Nicht ausgeführt: „Lampen bestellen“ gibt es schon offen als WEB-\d+ – dort weiter\?/);
  assert.equal((await t.db.one(`select count(*)::int as c from tasks where title = 'Lampen bestellen'`)).c, 1);
});

test('Steuerbefehle: note (Autor ist die Person), pause/resume, priority, policy (nur PL), report; approve zeigt die Karte; claimCheck lässt bestätigte Ausführung stehen', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const task = await t.db.one(`select t.*, p.key from tasks t join projects p on p.id = t.project_id where t.title = 'Lampen bestellen'`);
  const ref = `${task.key}-${task.number}`;
  // Bestätigungskarten für Kleinigkeiten nur mit Einstellung chatCards = all (Standard: nur wenn nötig)
  await t.api(pl).patch('/me', { settings: { chatCards: 'all' } });
  nextCommands = [C({ type: 'note', ref, text: 'Gesamtkonzept abgenommen' }), C({ type: 'priority', ref, level: 'hoch' }), C({ type: 'policy', ref, mode: 'confirm_all' }), C({ type: 'report', ref, every: 'daily' })];
  nextReply = 'Ich habe das vermerkt und die Priorität gesetzt.';
  await say(pl, dmPl, `${ref}: Gesamtkonzept abgenommen, Priorität hoch, bei allem rückfragen, täglich berichten.`);
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and user_id = $2 and source = 'chat' and body = 'Gesamtkonzept abgenommen'`, [task.id, t.ids.users.pl]), 'Log mit Autor PL');
  const tk = await t.db.one(`select priority, agent_policy from tasks where id = $1`, [task.id]);
  assert.equal(tk.priority, 'high'); assert.equal(tk.agent_policy.mode, 'confirm_all');
  assert.ok(await t.db.maybeOne(`select 1 from notification_rules where task_id = $1 and user_id = $2 and event = 'progress' and timing->>'every' = 'daily'`, [task.id, t.ids.users.pl]));
  let card = await lastCard(dmPl);
  assert.match(card.body, /✓ WEB-\d+: im Log vermerkt \(Petra Lenz\)/); assert.match(card.body, /✓ WEB-\d+: Priorität high/); assert.match(card.body, /Selbstständigkeit confirm_all/); assert.match(card.body, /Zwischenstände daily/);
  const reply = await t.db.one(`select body from chat_messages where channel_id = $1 and user_id = $2 and kind = 'user' order by created_at desc limit 1`, [dmPl, agent.id]);
  assert.equal(reply.body, 'Ich habe das vermerkt und die Priorität gesetzt.', 'keine Ersetzung bei ausgeführten Befehlen');
  // Standard (nur wenn nötig): die Notiz wird ausgeführt, aber ohne Karte
  await t.api(pl).patch('/me', { settings: { chatCards: 'needed' } });
  nextCommands = [C({ type: 'note', ref, text: 'Nur eine Notiz' })];
  nextReply = 'Notiert.';
  await say(pl, dmPl, `${ref}: nur eine Notiz`);
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and body = 'Nur eine Notiz'`, [task.id]));
  assert.equal((await lastCard(dmPl)).id, card.id, 'keine Karte für die Notiz');
  await t.api(pl).patch('/me', { settings: { chatCards: 'all' } });
  // Mitglied: policy verweigert, pause nur am eigenen AP
  nextCommands = [C({ type: 'policy', ref, mode: 'auto' }), C({ type: 'pause', ref })];
  await say(max, dmMax, `${ref} auf selbstständig und pausieren`);
  card = await lastCard(dmMax);
  assert.match(card.body, /✗ Nicht ausgeführt: WEB-\d+: die Selbstständigkeit setzt nur die PL/);
  assert.match(card.body, /✓ WEB-\d+: Agent pausiert/, 'Max ist Auftraggeber dieses AP');
  assert.equal((await t.db.one(`select agent_paused from tasks where id = $1`, [task.id])).agent_paused, true);
  nextCommands = [C({ type: 'resume', ref })];
  await say(pl, dmPl, `${ref} weiter`);
  assert.equal((await t.db.one(`select agent_paused from tasks where id = $1`, [task.id])).agent_paused, false);
  // approve ohne Angehaltenes: Lauf startet; mit offener Bestätigung: Karte mit der Frage
  nextCommands = [C({ type: 'approve', ref })];
  await say(pl, dmPl, `${ref} freigeben`);
  card = await lastCard(dmPl);
  assert.match(card.body, /nichts angehalten; Lauf gestartet/);
  const q = await t.db.one(`insert into questions (org_id, project_id, task_id, kind, asked_by, addressee_id, body, channel_id, message_id) values ($1,$2,$3,'approval',$4,$5,'Bitte bestätigen',$6,null) returning id`, [t.ids.org, web(), task.id, agent.id, t.ids.users.pl, dmPl]);
  nextCommands = [C({ type: 'approve', ref })];
  await say(pl, dmPl, `${ref} ok, mach`);
  card = await lastCard(dmPl);
  assert.match(card.body, /◔ WEB-\d+: offene Bestätigung – bitte auf der Karte entscheiden/);
  assert.equal(card.meta.approvalQuestionId, q.id);
  assert.match(prompts.at(-1) ?? '', /Offene Bestätigungen von dir/);
  // stop: Fragen abbrechen, Vorschläge zurückziehen
  nextCommands = [C({ type: 'stop', ref, reason: 'Projekt pausiert' })];
  await say(pl, dmPl, `${ref} stopp`);
  assert.equal((await t.db.one(`select status from questions where id = $1`, [q.id])).status, 'cancelled');
  assert.equal((await t.db.one(`select agent_paused from tasks where id = $1`, [task.id])).agent_paused, true);
  // claimCheck ohne ausgeführten Befehl ersetzt den Satz
  nextReply = 'Ich habe das Arbeitspaket angelegt.';
  await say(pl, dmPl, 'Danke');
  const r2 = await t.db.one(`select body from chat_messages where channel_id = $1 and user_id = $2 and kind = 'user' order by created_at desc limit 1`, [dmPl, agent.id]);
  assert.match(r2.body, /^Das konnte ich nicht ausführen/);
  assert.equal(claimCheck('Ich habe WEB-3 angelegt.', false, true).replaced.length, 0);
});
