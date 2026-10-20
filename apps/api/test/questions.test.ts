import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { flushAgentRuns } from '../src/ai/agentEvents.js';
import { runAgents } from '../src/ai/agent.js';
import { askQuestion, runQuestions } from '../src/questions.js';

/** Lokales LLM: Arbeitspaket-Läufe bekommen die nächsten Aktionen, Chat-Läufe eine feste Antwort (ggf. mit answers). */
let next: any[] = [{ type: 'none', reason: 'Test' }];
let chatAnswers: { questionId: string; text: string }[] = [];
const calls: any[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (String(input) !== 'http://llm.local:8000/v1/chat/completions') return new Response('{}', { status: 404 });
  calls.push(body);
  const system = String(body.messages?.[0]?.content ?? '');
  let content = 'bereit';
  if (body.response_format && system.includes('Man erreicht dich im Chat')) { content = JSON.stringify({ reply: 'Alles klar.', notes: [], answers: chatAnswers }); chatAnswers = []; }
  else if (body.response_format) content = JSON.stringify({ note: 'Test', actions: next });
  return new Response(JSON.stringify({ model: 'qwen3', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { status: 200 });
};
delete process.env.ANTHROPIC_API_KEY;
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());

const web = () => t.ids.projects.web;
let morton: any; let ap: any;
const A = (a: Record<string, unknown>) => ({ type: 'none', text: '', column: '', itemId: '', to: [], subject: '', reason: '', kind: '', checkAfterHours: 0, until: '', remindAfterHours: 0, escalateAfterHours: 0, pageId: '', title: '', folder: '', status: '', ref: '', responsible: '', startDate: '', dueDate: '', subproject: '', items: [], startsAt: '', endsAt: '', location: '', questionId: '', ...a });
const openOf = async (taskId: string) => (await t.db.query(`select * from questions where task_id = $1 and status = 'open' order by created_at`, [taskId])).rows;

test('ask: Frage an die Kette als Chat-Thread, Meldung mit Bezug, Log, Warten; Dedupe; Antwort im Thread erledigt alles und startet den Agenten', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const p = (await t.api(admin).post('/ai/profiles', { name: 'Qwen', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'qwen3' })).json().profile;
  await t.api(admin).put('/ai/settings', { defaultProfileId: p.id, agentDailyBudget: 100 });
  morton = (await t.api(admin).post('/agents', { name: 'Morton' })).json().agent;
  await t.api(pl).put(`/projects/${web()}/members/${morton.id}`, { role: 'member' });
  next = [A({ type: 'ask', text: 'Welche Farbe soll die Startseite bekommen?', remindAfterHours: 24 })];
  ap = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Startseite gestalten', responsibleUserId: morton.id })).json().task;
  await flushAgentRuns();
  const qs = await openOf(ap.id);
  assert.equal(qs.length, 1, 'eine offene Frage');
  const q = qs[0];
  assert.equal(q.kind, 'question'); assert.equal(q.addressee_id, t.ids.users.pl, 'Stufe 0 der Kette: PL (kein Über-AP, kein Teilprojekt)'); assert.equal(q.addressee_role, 'pl');
  assert.ok(q.channel_id && q.message_id, 'Chat-Nachricht als Thread-Wurzel');
  const msg = await t.db.one(`select body, meta from chat_messages where id = $1`, [q.message_id]);
  assert.match(msg.body, /^WEB-\d+ „Startseite gestalten“: Welche Farbe/);
  assert.equal(msg.meta.questionId, q.id);
  // Frist aus Regel N (question: 48 h / 120 h), dueHours verkürzt das Nachfassen auf 24 h
  assert.ok(Math.abs(new Date(q.remind_at).getTime() - Date.now() - 24 * 3600_000) < 60_000, 'Nachfassen nach 24 h');
  assert.ok(Math.abs(new Date(q.escalate_at).getTime() - Date.now() - 120 * 3600_000) < 60_000, 'Weitergabe nach 120 h');
  const n = await t.db.one(`select * from notifications where ref_type = 'question' and ref_id = $1`, [q.id]);
  assert.equal(n.user_id, t.ids.users.pl); assert.equal(n.event, 'question'); assert.equal(n.mail, 'now'); assert.equal(n.resolved_at, null);
  assert.match(n.link, new RegExp(`^/chat/${q.channel_id}\\?thread=${q.message_id}&msg=${q.message_id}$`));
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and question_id = $2 and body like 'Frage an Petra Lenz (Chat):%'`, [ap.id, q.id]), 'Log');
  const task = (await t.api(pl).get(`/tasks/${ap.id}`)).json().task;
  assert.equal(task.agentWait.kind, 'reply'); assert.equal(task.agentWait.questionId, q.id);
  // Dedupe: dieselbe Frage an denselben Adressaten wird abgewiesen, der Agent erfährt es
  const r = await t.api(pl).post(`/tasks/${ap.id}/agent-run`);
  assert.match(String(r.json().error ?? ''), /ist seit .* offen; nicht erneut fragen/);
  assert.equal((await openOf(ap.id)).length, 1);
  // Liste „Offen für mich“ und Deep-Link-Daten der Nachricht
  const mine = (await t.api(pl).get('/questions?status=open')).json();
  assert.ok(mine.questions.some((x: any) => x.id === q.id && x.taskCode === `WEB-${ap.number}` && x.askedByName === 'Morton'));
  const msgInfo = (await t.api(pl).get(`/chat/messages/${q.message_id}`)).json();
  assert.equal(msgInfo.question.id, q.id); assert.equal(msgInfo.question.status, 'open'); assert.equal(msgInfo.channel.kind, 'dm');
  assert.equal((await t.api(await t.login('max@demo.local')).get(`/chat/messages/${q.message_id}`)).statusCode, 403, 'fremde DM');
  // Antwort im Thread der Frage (Regel F Schritt 1)
  next = [A({ type: 'comment', text: 'Farbe notiert.' })];
  const n0 = calls.length;
  await t.api(pl).post(`/chat/channels/${q.channel_id}/messages`, { body: 'Dunkelblau wie das Logo.', threadId: q.message_id });
  await flushAgentRuns();
  const done = await t.db.one(`select * from questions where id = $1`, [q.id]);
  assert.equal(done.status, 'answered'); assert.equal(done.answer_source, 'chat'); assert.equal(done.answered_by, t.ids.users.pl); assert.equal(done.answer_text, 'Dunkelblau wie das Logo.');
  assert.ok(done.answer_message_id && done.answer_comment_id);
  assert.ok((await t.db.one(`select resolved_at, read_at from notifications where id = $1`, [n.id])).resolved_at, 'Meldung erledigt');
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where id = $1 and body = 'Rückmeldung per Chat an Morton: Dunkelblau wie das Logo.' and source = 'chat' and user_id = $2`, [done.answer_comment_id, t.ids.users.pl]));
  assert.equal((await t.api(pl).get(`/tasks/${ap.id}`)).json().task.agentWait, null, 'Warten beendet');
  const run = await t.db.one(`select trigger from agent_runs where task_id = $1 and status <> 'skipped' order by created_at desc limit 1`, [ap.id]);
  assert.equal(run.trigger, 'answer');
  assert.match(String(calls.slice(n0).find((c) => !String(c.messages[0].content).includes('Man erreicht dich im Chat'))?.messages[1].content), /Antwort auf deine Frage ist da/);
  // Der Agent antwortet trotzdem im Thread (nichts wird verschluckt)
  assert.ok(await t.db.maybeOne(`select 1 from chat_messages where channel_id = $1 and user_id = $2 and created_at > $3`, [q.channel_id, morton.id, done.answered_at]), 'Chat-Antwort im Gespräch');
});

test('Antwort in der Aufgabe (questionId am Kommentar, Route mit Auswahl): Thread bekommt Systemnachricht; Abbruch bei Erledigt', async () => {
  const pl = await t.login('pl@demo.local');
  const anna = await t.login('anna@demo.local');
  next = [A({ type: 'ask', text: 'Welches Logo-Format liegt vor?', to: ['anna@demo.local'] })];
  await t.api(pl).post(`/tasks/${ap.id}/agent-run`);
  const [q] = await openOf(ap.id);
  assert.equal(q.addressee_id, t.ids.users.anna, 'gewählte Stufe: Stellvertretung aus der Kette');
  assert.equal((await t.api(pl).post(`/tasks/${ap.id}/questions`, {})).statusCode, 404);
  assert.equal((await t.api(pl).get(`/tasks/${ap.id}/questions`)).json().questions.length, 1);
  // Beantworten in der Aufgabe als Kommentar mit questionId: auch die PL darf, nicht ein Leser
  next = [A({ type: 'none', reason: 'x' })];
  const c = await t.api(pl).post(`/tasks/${ap.id}/comments`, { body: 'SVG und PNG liegen in der Doku.', questionId: q.id });
  assert.equal(c.statusCode, 200, c.body);
  await flushAgentRuns();
  const a1 = await t.db.one(`select * from questions where id = $1`, [q.id]);
  assert.equal(a1.status, 'answered'); assert.equal(a1.answer_source, 'task'); assert.equal(a1.answer_comment_id, c.json().comment.id);
  const sys = await t.db.one(`select body, kind from chat_messages where thread_id = $1 order by created_at desc limit 1`, [q.message_id]);
  assert.equal(sys.kind, 'system'); assert.match(sys.body, /^Beantwortet in WEB-\d+ von Petra Lenz: SVG und PNG/);
  assert.ok((await t.db.one(`select resolved_at from notifications where ref_type = 'question' and ref_id = $1 and user_id = $2`, [q.id, t.ids.users.anna])).resolved_at, 'Meldung bei Anna erledigt');
  assert.equal((await t.api(anna).post(`/questions/${q.id}/answer`, { text: 'zu spät' })).statusCode, 400, 'nicht mehr offen');
  // Frage mit Auswahl über die Route beantworten (Karte); Leser darf nicht
  const r = await askQuestion(t.db, { taskId: ap.id, asker: { id: morton.id, name: 'Morton', org_id: t.ids.org, kind: 'agent' }, kind: 'decision', body: 'Startseite freigeben?', options: [{ key: 'yes', label: 'Freigeben' }, { key: 'no', label: 'Noch nicht' }] });
  assert.ok('question' in r);
  const q2 = (r as any).question;
  assert.equal((await t.api(await t.login('leser@demo.local')).post(`/questions/${q2.id}/answer`, { option: 'yes' })).statusCode, 403);
  assert.equal((await t.api(pl).post(`/questions/${q2.id}/answer`, { option: 'nope' })).statusCode, 400);
  const ok = await t.api(pl).post(`/questions/${q2.id}/answer`, { option: 'no', text: 'Erst nach dem Review.' });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().question.answerOption, 'no');
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and question_id = $2 and body = 'Erst nach dem Review.'`, [ap.id, q2.id]), 'Antwort im Log');
  // Abbruch: AP erledigt → offene Fragen erledigen sich, Meldungen weg, Thread geschlossen
  const r3 = await askQuestion(t.db, { taskId: ap.id, asker: { id: morton.id, name: 'Morton', org_id: t.ids.org, kind: 'agent' }, kind: 'question', body: 'Noch offen?' });
  const q3 = (r3 as any).question;
  const doneCol = (await t.api(pl).get(`/projects/${web()}`)).json().columns.find((c: any) => c.isDone).id;
  await t.api(pl).post(`/tasks/${ap.id}/move`, { columnId: doneCol });
  const c3 = await t.db.one(`select status, cancel_reason from questions where id = $1`, [q3.id]);
  assert.equal(c3.status, 'cancelled'); assert.match(c3.cancel_reason, /ist erledigt/);
  assert.ok((await t.db.one(`select resolved_at from notifications where ref_type = 'question' and ref_id = $1`, [q3.id])).resolved_at);
  assert.match((await t.db.one(`select body from chat_messages where thread_id = $1 and kind = 'system' order by created_at desc limit 1`, [q3.message_id])).body, /^Hat sich erledigt/);
});

test('Frist: Erinnerung im Thread und Weitergabe an die nächste Stufe mit parent_id; Antwort der neuen Stufe erledigt beide; Kette endet offen', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  // AP in Teilprojekt „Konzept & Design“ (Max verantwortlich) → Kette: Max, Petra (PL), Anna (Stellv.)
  const sp = (await t.api(pl).get(`/projects/${web()}`)).json().subprojects.find((s: any) => s.name === 'Konzept & Design');
  const ap2 = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Bildwelt festlegen', subprojectId: sp.id, responsibleUserId: morton.id })).json().task;
  next = [A({ type: 'ask', text: 'Stockfotos oder eigenes Shooting?' })];
  await flushAgentRuns();
  const [q] = await openOf(ap2.id);
  assert.equal(q.addressee_id, t.ids.users.max, 'Stufe 0: Teilprojekt-Verantwortung');
  const now = Date.now();
  // Erinnerung (48 h)
  const r1 = await runQuestions(t.db, new Date(now + 49 * 3600_000));
  assert.equal(r1.reminded, 1);
  assert.match((await t.db.one(`select body from chat_messages where thread_id = $1 and kind = 'system' order by created_at desc limit 1`, [q.message_id])).body, /^Erinnerung: Stockfotos/);
  assert.ok(await t.db.maybeOne(`select 1 from notifications where ref_type = 'question' and ref_id = $1 and dedupe_key = $2`, [q.id, `q:${q.id}:remind`]));
  assert.equal((await runQuestions(t.db, new Date(now + 50 * 3600_000))).reminded, 0, 'nur einmal');
  // Weitergabe (120 h) an Petra, Vorgänger escalated
  const r2 = await runQuestions(t.db, new Date(now + 121 * 3600_000));
  assert.equal(r2.escalated, 1);
  const old = await t.db.one(`select status from questions where id = $1`, [q.id]);
  assert.equal(old.status, 'escalated');
  const [q2] = await openOf(ap2.id);
  assert.equal(q2.parent_id, q.id); assert.equal(q2.level, 1); assert.equal(q2.addressee_id, t.ids.users.pl);
  assert.ok((await t.db.one(`select resolved_at, body from notifications where ref_type = 'question' and ref_id = $1 and dedupe_key = $2`, [q.id, `q:${q.id}:0`])).resolved_at, 'alte Meldung erledigt');
  assert.equal((await t.api(pl).get(`/tasks/${ap2.id}`)).json().task.agentWait.questionId, q2.id, 'Warten zeigt auf die neue Frage');
  assert.match((await t.db.one(`select body from chat_messages where thread_id = $1 and kind = 'system' order by created_at desc limit 1`, [q.message_id])).body, /^Weitergegeben an Petra Lenz/);
  // Max antwortet noch im alten Thread: keine Zuordnung mehr (Frage nicht mehr offen), normaler Chat
  await t.api(max).post(`/chat/channels/${q.channel_id}/messages`, { body: 'Shooting!', threadId: q.message_id });
  await flushAgentRuns();
  assert.equal((await t.db.one(`select status from questions where id = $1`, [q.id])).status, 'escalated');
  // Petra antwortet in ihrer DM (einzige offene Frage von Morton an sie): beide Fragen gelten als erledigt
  next = [A({ type: 'none', reason: 'x' })];
  await t.api(pl).post(`/chat/channels/${q2.channel_id}/messages`, { body: 'Eigenes Shooting, Budget ist da.' });
  await flushAgentRuns();
  assert.equal((await t.db.one(`select status from questions where id = $1`, [q2.id])).status, 'answered');
  assert.equal((await t.db.one(`select count(*)::int as c from notifications where ref_type = 'question' and ref_id in ($1, $2) and resolved_at is null`, [q.id, q2.id])).c, 0);
  // Kette: nach Petra Anna (Stellv.), dann der Projektkanal als letzte Stufe; danach bleibt die Frage offen
  const r3 = await askQuestion(t.db, { taskId: ap2.id, asker: { id: morton.id, name: 'Morton', org_id: t.ids.org, kind: 'agent' }, kind: 'question', body: 'Letzte Stufe?', level: 2 });
  const q3 = (r3 as any).question;
  assert.equal(q3.addressee_id, t.ids.users.anna);
  await t.db.query(`update questions set escalate_at = now() - interval '1 minute' where id = $1`, [q3.id]);
  assert.equal((await runQuestions(t.db)).escalated, 1, 'Weitergabe in den Projektkanal');
  const q4 = (await openOf(ap2.id)).find((x: any) => x.parent_id === q3.id);
  assert.equal(q4.addressee_id, null); assert.equal(q4.addressee_role, 'project');
  const ch = await t.db.one(`select kind from chat_channels where id = $1`, [q4.channel_id]);
  assert.equal(ch.kind, 'project');
  assert.ok(await t.db.maybeOne(`select 1 from notifications where ref_type = 'question' and ref_id = $1 and user_id = $2`, [q4.id, t.ids.users.max]), 'Projektkanal: Mitglieder mit Sicht werden gemeldet');
  await t.db.query(`update questions set escalate_at = now() - interval '1 minute' where id = $1`, [q4.id]);
  assert.equal((await runQuestions(t.db)).escalated, 0);
  const still = await t.db.one(`select status, escalate_at from questions where id = $1`, [q4.id]);
  assert.equal(still.status, 'open'); assert.equal(still.escalate_at, null, 'keine weitere Weitergabe');
  assert.match((await t.db.one(`select body from chat_messages where thread_id = $1 and kind = 'system' order by created_at desc limit 1`, [q4.message_id])).body, /Keine weitere Stufe/);
  // Antwort im Projektkanal-Thread durch ein Mitglied mit Sicht (Max), nicht durch Leser
  next = [A({ type: 'none', reason: 'x' })];
  await t.api(await t.login('leser@demo.local')).post(`/chat/channels/${q4.channel_id}/messages`, { body: 'Ich weiß es!', threadId: q4.message_id }).catch(() => undefined);
  assert.equal((await t.db.one(`select status from questions where id = $1`, [q4.id])).status, 'open', 'Leser beantworten nicht');
  await t.api(max).post(`/chat/channels/${q4.channel_id}/messages`, { body: 'Shooting, Budget ist da.', threadId: q4.message_id });
  await flushAgentRuns();
  assert.equal((await t.db.one(`select status, answered_by from questions where id = $1`, [q4.id])).answered_by, t.ids.users.max);
});

test('Regel F Schritt 2: mehrere offene Fragen in der DM → der Chat-Lauf ordnet mit answers zu; Bestätigungsfragen antwortet kein Freitext', async () => {
  const pl = await t.login('pl@demo.local');
  const ap3 = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Druck beauftragen', responsibleUserId: morton.id })).json().task;
  next = [A({ type: 'ask', text: 'Auflage 500 oder 1000?' }), A({ type: 'ask', text: 'Matt oder glänzend?' }), A({ type: 'create_event', title: 'Druckabnahme', startsAt: '2026-12-01T10:00' })];
  await flushAgentRuns();
  const qs = await openOf(ap3.id);
  assert.deepEqual(qs.map((q: any) => q.kind), ['question', 'question', 'confirm']);
  const dm = qs[0].channel_id;
  // Freitext in der DM: zwei offene Fragen → keine automatische Zuordnung; der Chat-Lauf liefert answers für eine
  chatAnswers = [{ questionId: qs[1].id, text: 'glänzend' }];
  next = [A({ type: 'none', reason: 'x' })];
  await t.api(pl).post(`/chat/channels/${dm}/messages`, { body: 'Glänzend bitte.' });
  await flushAgentRuns();
  assert.equal((await t.db.one(`select status, answer_text from questions where id = $1`, [qs[1].id])).status, 'answered');
  assert.equal((await t.db.one(`select status from questions where id = $1`, [qs[0].id])).status, 'open');
  const chatPrompt = calls.filter((c) => String(c.messages[0].content).includes('Man erreicht dich im Chat')).pop();
  assert.match(String(chatPrompt.messages[1].content), /Deine offenen Fragen hier[\s\S]*Auflage 500 oder 1000\?[\s\S]*questionId/);
  // Jetzt genau eine offene Freitext-Frage: die nächste Nachricht beantwortet sie direkt; die Bestätigungsfrage bleibt für die Karte
  await t.api(pl).post(`/chat/channels/${dm}/messages`, { body: '1000 Stück.' });
  await flushAgentRuns();
  assert.equal((await t.db.one(`select status, answer_text from questions where id = $1`, [qs[0].id])).answer_text, '1000 Stück.');
  assert.equal((await t.db.one(`select status from questions where id = $1`, [qs[2].id])).status, 'open', 'Bestätigung nicht per Freitext');
  // Termin bestätigen beantwortet die Bestätigungsfrage; Löschen eines Termins bricht offene ab
  const ev = (await t.api(pl).get(`/projects/${web()}/meetings`)).json().meetings.find((m: any) => m.title === 'Druckabnahme');
  await t.api(pl).post(`/meetings/${ev.id}/confirm`);
  await flushAgentRuns();
  const cq = await t.db.one(`select status, answer_source, answer_option from questions where id = $1`, [qs[2].id]);
  assert.deepEqual([cq.status, cq.answer_source, cq.answer_option], ['answered', 'meeting', 'confirm']);
  assert.equal((await t.db.one(`select count(*)::int as c from task_comments where task_id = $1 and body like 'Termin bestätigt:%'`, [ap3.id])).c, 1, 'ein Log-Eintrag');
});
