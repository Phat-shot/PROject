import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { flushAgentRuns } from '../src/ai/agentEvents.js';

/** Lokales LLM: Mail-Läufe liefern `mailNext` mit offenen Punkten `mailOpen`, Arbeitspaket-Läufe keine Aktion. */
let mailNext: any[] = [];
let mailOpen: string[] = [];
const systems: string[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (String(input) !== 'http://llm.local:8000/v1/chat/completions') return new Response('{}', { status: 404 });
  const system = body.messages?.[0]?.content ?? '';
  systems.push(system);
  const content = !body.response_format ? 'bereit' : system.includes('# Mail bearbeiten') ? JSON.stringify({ summary: 'Angebot angelegt.', openPoints: mailOpen, actions: mailNext }) : JSON.stringify({ note: 'nichts', actions: [{ type: 'none', reason: 'Test' }] });
  return new Response(JSON.stringify({ model: 'qwen', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
};
delete process.env.ANTHROPIC_API_KEY;
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());

const M = (x: Record<string, unknown>) => ({ type: 'none', title: null, text: null, ref: null, subproject: null, responsible: null, startDate: null, dueDate: null, items: null, startsAt: null, endsAt: null, location: null, folder: null, reason: null, ...x });
const web = () => t.ids.projects.web;
let agent: any;
let n = 0;
const inject = async (subject: string) => {
  n++;
  t.mail.dev.inject(t.ids.accounts.project, { from: { address: 'handwerker@extern.de', name: 'Elektro Kurz' }, to: ['projekt-web@demo.local'], subject, text: `Mail ${n}` } as any);
  await t.mail.syncAccount(t.ids.accounts.project);
  await flushAgentRuns();
  return t.db.one(`select * from mails where subject = $1`, [subject]);
};
const openQuestion = (mailId: string) => t.db.maybeOne(`select * from questions where context->>'mailId' = $1 and status = 'open' order by created_at desc limit 1`, [mailId]);

test('Projektagent setzen: nur PL, nur Agenten; Mitgliedschaft wird stellvertretende PL; Vorgabe der Mail-Rückfrage kommt vom Mandanten', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const p = (await t.api(admin).post('/ai/profiles', { name: 'Qwen', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'qwen' })).json().profile;
  await t.api(admin).put('/ai/settings', { defaultProfileId: p.id, agentDailyBudget: 50 });
  await t.api(pl).patch(`/projects/${web()}`, { aiProfileId: p.id });
  agent = (await t.api(admin).post('/agents', { name: 'Morton' })).json().agent;
  assert.equal((await t.api(max).put(`/projects/${web()}/agent`, { agentUserId: agent.id, agentMail: 'process' })).statusCode, 403, 'nur PL');
  assert.equal((await t.api(pl).put(`/projects/${web()}/agent`, { agentUserId: t.ids.users.max, agentMail: 'process' })).statusCode, 400, 'nur Agenten');
  assert.equal((await t.api(pl).put(`/projects/${web()}/agent`, { agentUserId: agent.id, agentMail: 'sofort' })).statusCode, 400, 'Modus geprüft');
  const r = await t.api(pl).put(`/projects/${web()}/agent`, { agentUserId: agent.id, agentMail: 'process' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().project.agentUserId, agent.id);
  assert.equal(r.json().project.agentMail, 'process');
  const m = await t.db.one(`select role, is_deputy from project_members where project_id = $1 and user_id = $2`, [web(), agent.id]);
  assert.equal(m.role, 'pl'); assert.equal(m.is_deputy, true);
  const d = (await t.api(pl).get(`/projects/${web()}`)).json();
  assert.equal(d.project.agentUserId, agent.id);
  assert.deepEqual(d.project.mailInquiry, { mode: 'ask_pl', waitHours: 48, inherited: true }, 'Standard geerbt');
  // Mitglieder-Route hält den Zeiger konsistent: Rolle runter nimmt die Projektagent-Rolle
  await t.api(pl).put(`/projects/${web()}/members/${agent.id}`, { role: 'member' });
  assert.equal((await t.db.one(`select agent_user_id, agent_mail from projects where id = $1`, [web()])).agent_user_id, null);
  await t.api(pl).put(`/projects/${web()}/members/${agent.id}`, { role: 'pl' });
  assert.equal((await t.db.one(`select agent_user_id, agent_mail from projects where id = $1`, [web()])).agent_user_id, agent.id, 'Agent als PL wird Projektagent');
  assert.equal((await t.db.one(`select agent_mail from projects where id = $1`, [web()])).agent_mail, 'off', 'Mail-Modus setzt die PL ausdrücklich');
  assert.equal((await t.api(pl).put(`/projects/${web()}/agent`, { agentUserId: agent.id, agentMail: 'process' })).statusCode, 200);
});

test('Projektagent bearbeitet neue Mails des Projektkontos selbst (Rechte und Budget des Agenten, Freigabe agent.mail); offene Punkte fragen die PL per Karte', async () => {
  mailNext = [M({ type: 'create_ap', title: 'Angebot Elektrik einholen', text: 'Angebot bis 20.11.', dueDate: '2026-11-20' })];
  mailOpen = ['Budgetrahmen fehlt', 'Gewünschter Liefertermin unklar'];
  const mail = await inject('Angebot Elektrik');
  const run = await t.db.one(`select * from mail_ai_runs where mail_id = $1`, [mail.id]);
  assert.equal(run.status, 'ok', run.error ?? '');
  assert.equal(run.mode, 'process');
  assert.equal(run.actor_user_id, agent.id, 'der Agent selbst ist Auftraggeber');
  assert.equal(run.agent_user_id, agent.id);
  assert.deepEqual(run.open_points, mailOpen);
  assert.ok(systems.at(-1)?.includes('Projektagent (stellvertretende Projektleitung)'), 'Rolle im Prompt');
  const task = await t.db.one(`select t.*, l.copied from tasks t join mail_task_links l on l.task_id = t.id where l.mail_id = $1`, [mail.id]);
  assert.equal(task.title, 'Angebot Elektrik einholen');
  assert.equal(task.copied, true);
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and user_id = $2 and body like '%Projektagent Morton%'`, [task.id, agent.id]), 'Log unter dem Namen des Agenten');
  assert.ok(await t.db.maybeOne(`select 1 from agent_runs where agent_user_id = $1 and trigger = 'mail_process' and task_id = $2`, [agent.id, task.id]), 'zählt als Lauf des Agenten');
  assert.ok(await t.db.maybeOne(`select 1 from chat_messages m join chat_channel_members x on x.channel_id = m.channel_id and x.user_id = $1 where m.user_id = $2 and m.body like 'Mail „Angebot Elektrik“%bearbeitet:%'`, [t.ids.users.pl, agent.id]), 'PL erfährt davon per Chat');
  const q = await openQuestion(mail.id);
  assert.ok(q, 'Frage an die PL');
  assert.equal(q.kind, 'decision');
  assert.equal(q.asked_by, agent.id);
  assert.equal(q.addressee_id, t.ids.users.pl);
  assert.equal(q.task_id, task.id);
  assert.deepEqual(q.options.map((o: any) => o.key), ['klar', 'ask_project', 'ask_sender']);
  assert.match(q.body, /Budgetrahmen fehlt/);
  assert.equal(q.context.topic, 'mail_inquiry');
  const dm = await t.db.one(`select body, meta from chat_messages where id = $1`, [q.message_id]);
  assert.equal(dm.meta.questionId, q.id);
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and ref_type = 'question' and ref_id = $2`, [t.ids.users.pl, q.id]), 'Meldung mit Bezug');
});

test('„Im Projekt fragen“: der Agent stellt die Frage im Projektkanal mit der Frist; „Beim Absender rückfragen“: Lauf mit Anlass inquiry', async () => {
  const pl = await t.login('pl@demo.local');
  const mail = await t.db.one(`select * from mails where subject = 'Angebot Elektrik'`);
  const q = await openQuestion(mail.id);
  const r = await t.api(pl).post(`/questions/${q.id}/answer`, { option: 'ask_project', text: 'Im Projekt fragen' });
  assert.equal(r.statusCode, 200, r.body);
  await flushAgentRuns();
  assert.equal((await t.db.one(`select status, answer_option from questions where id = $1`, [q.id])).answer_option, 'ask_project');
  const q2 = await openQuestion(mail.id);
  assert.ok(q2 && q2.id !== q.id, 'Folgefrage');
  assert.equal(q2.kind, 'question');
  assert.equal(q2.addressee_id, null, 'im Projektkanal');
  assert.equal(q2.asked_by, agent.id);
  assert.equal(q2.context.parentQuestionId, q.id);
  assert.match(q2.body, /Liefertermin unklar/);
  assert.ok(await t.db.maybeOne(`select 1 from chat_messages m join chat_channels c on c.id = m.channel_id where m.id = $1 and c.project_id = $2`, [q2.message_id, web()]), 'Nachricht im Projektkanal');
  assert.equal((await t.db.one(`select count(*)::int as c from agent_runs where agent_user_id = $1 and trigger = 'answer'`, [agent.id])).c, 0, 'kein zusätzlicher Lauf „answer“');

  // Zweite Mail: Rückfrage beim Absender
  mailNext = [M({ type: 'create_ap', title: 'Gerüst bestellen', text: 'Gerüst für Fassade' })];
  mailOpen = ['Höhe des Gerüsts fehlt'];
  const mail2 = await inject('Gerüst');
  const qb = await openQuestion(mail2.id);
  assert.ok(qb);
  const r2 = await t.api(pl).post(`/questions/${qb.id}/answer`, { option: 'ask_sender', text: 'Beim Absender rückfragen' });
  assert.equal(r2.statusCode, 200, r2.body);
  await flushAgentRuns();
  const task2 = await t.db.one(`select t.id from tasks t join mail_task_links l on l.task_id = t.id where l.mail_id = $1`, [mail2.id]);
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and body like 'Rückfrage beim Absender%'`, [task2.id]), 'Log zur Rückfrage');
  const ar = await t.db.maybeOne(`select * from agent_runs where agent_user_id = $1 and trigger = 'inquiry' and task_id = $2`, [agent.id, task2.id]);
  assert.ok(ar, 'Lauf mit Anlass inquiry, obwohl der Agent nicht zuständig ist');
  assert.equal(ar.status, 'ok');
  assert.equal((await t.db.one(`select status from questions where id = $1`, [qb.id])).status, 'answered');
});

test('Einstellung je Projekt (aus, im Projekt fragen) und Vorgabe des Mandanten; Projektagent im Modus Vorschläge und aus', async () => {
  const pl = await t.login('pl@demo.local');
  const admin = await t.login('admin@demo.local');
  assert.equal((await t.api(pl).patch(`/projects/${web()}`, { mailInquiry: { mode: 'sofort', waitHours: 1 } })).statusCode, 400);
  assert.equal((await t.api(pl).patch(`/projects/${web()}`, { mailInquiry: { mode: 'off', waitHours: 24 } })).statusCode, 200);
  assert.deepEqual((await t.api(pl).get(`/projects/${web()}`)).json().project.mailInquiry, { mode: 'off', waitHours: 24 });
  mailNext = [M({ type: 'create_ap', title: 'Fliesen auswählen', text: 'Muster' })];
  mailOpen = ['Farbe der Fliesen'];
  const mail = await inject('Fliesen');
  assert.equal(await openQuestion(mail.id), null, 'aus: keine Frage');
  const task = await t.db.one(`select t.id from tasks t join mail_task_links l on l.task_id = t.id where l.mail_id = $1`, [mail.id]);
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and body like 'Offene Punkte aus der Mail%Farbe der Fliesen%'`, [task.id]), 'nur Log');

  // Mandant: Vorgabe „im Projekt fragen“, Projekt übernimmt sie wieder (null)
  assert.equal((await t.api(pl).put('/org/settings', { mailInquiry: { mode: 'ask_project', waitHours: 16 } })).statusCode, 403);
  assert.equal((await t.api(admin).put('/org/settings', { mailInquiry: { mode: 'ask_project', waitHours: 16 } })).statusCode, 200);
  assert.equal((await t.api(pl).patch(`/projects/${web()}`, { mailInquiry: null })).statusCode, 200);
  assert.deepEqual((await t.api(pl).get(`/projects/${web()}`)).json().project.mailInquiry, { mode: 'ask_project', waitHours: 16, inherited: true });
  mailNext = [M({ type: 'create_ap', title: 'Türen', text: 'Innentüren' })];
  mailOpen = ['Anzahl der Türen'];
  const mail2 = await inject('Türen');
  const q = await openQuestion(mail2.id);
  assert.ok(q, 'direkt im Projekt gefragt');
  assert.equal(q.kind, 'question');
  assert.equal(q.addressee_id, null);
  const h = (new Date(q.remind_at).getTime() - new Date(q.created_at).getTime()) / 3600_000;
  assert.ok(h > 15 && h < 17, `Frist aus der Einstellung (${h} h)`);

  // Ohne offene Punkte keine Frage
  mailOpen = [];
  mailNext = [M({ type: 'create_ap', title: 'Fenster', text: 'Fenster' })];
  const mail3 = await inject('Fenster');
  assert.equal(await openQuestion(mail3.id), null);

  // Modus Vorschläge: Lauf triage mit dem Projektagenten, offene Punkte in der Meldung
  assert.equal((await t.api(pl).put(`/projects/${web()}/agent`, { agentUserId: agent.id, agentMail: 'triage' })).statusCode, 200);
  mailOpen = ['Lieferadresse'];
  mailNext = [M({ type: 'create_ap', title: 'Lampen', text: 'Lampen' })];
  const mail4 = await inject('Lampen');
  const run4 = await t.db.one(`select * from mail_ai_runs where mail_id = $1`, [mail4.id]);
  assert.equal(run4.mode, 'triage'); assert.equal(run4.agent_user_id, agent.id); assert.equal(run4.actor_user_id, null);
  assert.equal(run4.actions[0].status, 'pending');
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'mail.ai' and body like '%Offen: Lieferadresse%'`, [t.ids.users.pl]), 'Vorschläge: offene Punkte in der Meldung');
  assert.equal(await openQuestion(mail4.id), null, 'ohne Arbeitspaket keine Frage');

  // Modus aus: keine Läufe mehr
  assert.equal((await t.api(pl).put(`/projects/${web()}/agent`, { agentUserId: agent.id, agentMail: 'off' })).statusCode, 200);
  const mail5 = await inject('Steckdosen');
  assert.equal(await t.db.maybeOne(`select 1 from mail_ai_runs where mail_id = $1`, [mail5.id]), null);
  assert.equal((await t.db.one(`select role from project_members where project_id = $1 and user_id = $2`, [web(), agent.id])).role, 'pl', 'Rolle bleibt');

  // Projektagent entfernen: wieder Mitglied
  assert.equal((await t.api(pl).put(`/projects/${web()}/agent`, { agentUserId: null })).statusCode, 200);
  assert.equal((await t.db.one(`select role from project_members where project_id = $1 and user_id = $2`, [web(), agent.id])).role, 'member');
});

test('KI-Freigabe agent.mail gesperrt: Lauf übersprungen mit Begründung', async () => {
  const pl = await t.login('pl@demo.local');
  const admin = await t.login('admin@demo.local');
  assert.equal((await t.api(pl).put(`/projects/${web()}/agent`, { agentUserId: agent.id, agentMail: 'process' })).statusCode, 200);
  const rule = await t.api(admin).put('/ai/policies', { projectId: null, userId: agent.id, groupId: null, note: null, feature: 'agent.mail', effect: 'deny' });
  assert.equal(rule.statusCode, 200, rule.body);
  mailOpen = [];
  mailNext = [M({ type: 'create_ap', title: 'Kabel', text: 'Kabel' })];
  const mail = await inject('Kabel');
  const run = await t.db.one(`select * from mail_ai_runs where mail_id = $1`, [mail.id]);
  assert.equal(run.status, 'skipped');
  assert.match(run.error ?? '', /gesperrt|Gesperrt|Projektagent bearbeitet Mails/);
  assert.equal(await t.db.maybeOne(`select 1 from tasks where title = 'Kabel'`), null);
});
