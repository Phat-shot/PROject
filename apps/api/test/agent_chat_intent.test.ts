import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { flushAgentRuns } from '../src/ai/agentEvents.js';
import { intentHeuristic, intentMarker } from '../src/ai/agentChat.js';

/**
 * Absicht einer Chat-Nachricht (allgemein, Projekt, persönlicher Assistent): Marker, Heuristik, Rückfrage mit Knöpfen (Karte
 * choices), Antwort auf die Rückfrage, Hinweis auf die Annahme einmal je Thread. Lokales LLM antwortet fest.
 */
const prompts: string[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (String(input) !== 'http://llm.local:8000/v1/chat/completions') return new Response('{}', { status: 404 });
  const system = body.messages?.[0]?.content ?? '';
  let content = 'bereit';
  if (body.response_format && system.includes('Man erreicht dich im Chat')) { prompts.push(String(body.messages?.[1]?.content ?? '')); content = JSON.stringify({ reply: 'Gern, hier die Antwort.', notes: [], answers: [], commands: [] }); }
  else if (body.response_format) content = JSON.stringify({ note: 'nichts zu tun', actions: [{ type: 'none', reason: 'Test' }] });
  return new Response(JSON.stringify({ model: 'qwen', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { status: 200 });
};
delete process.env.ANTHROPIC_API_KEY;
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());

let agent: any; let max: any; let cid = '';
const say = async (body: string, threadId?: string) => { const n = prompts.length; const r = await t.api(max).post(`/chat/channels/${cid}/messages`, { body, threadId }); assert.equal(r.statusCode, 200, r.body); await flushAgentRuns(); return { id: r.json().message.id as string, calls: prompts.length - n, prompt: prompts.at(-1) ?? '' }; };
const messages = async (threadId?: string) => (await t.api(max).get(`/chat/channels/${cid}/messages${threadId ? `?thread=${threadId}` : ''}`)).json().messages as any[];
const lastReply = async (threadId?: string) => (await messages(threadId)).filter((m) => m.userId === agent.id).at(-1)?.body as string;
const lastCard = async () => (await messages()).filter((m) => m.kind === 'system' && m.meta?.card === 'choices').at(-1);
const noProjectData = (p: string) => !p.includes('Kennzahlen zu') && !p.includes('Angebot Agentur') && !p.includes('Schnittstellenliste') && !p.includes('Gemeinsame Projekte') && !p.includes('Agenten-Policy');

test('Marker und Heuristik ohne Datenbank', () => {
  const P = [{ id: '1', key: 'WEB', name: 'Website-Relaunch' }];
  assert.deepEqual(intentMarker('allgemein', P), { intent: 'general' });
  assert.deepEqual(intentMarker('Allgemein: wie geht das?', P), { intent: 'general' });
  assert.deepEqual(intentMarker('ohne Projekt', P), { intent: 'general' });
  assert.deepEqual(intentMarker('persönlich', P), { intent: 'personal' });
  assert.deepEqual(intentMarker('Für mich: Einkaufsliste', P), { intent: 'personal' });
  assert.equal(intentMarker('Für mich ist das in Ordnung.', P), null, '„für mich“ als Satzanfang ist kein Marker');
  assert.equal(intentMarker('Projekt WEB', P)?.intent, 'project');
  assert.equal(intentMarker('web', P)?.intent, 'project');
  assert.equal(intentMarker('Wie weit ist WEB?', P), null, 'Nennung im Satz ist Sache der Erwähnungen');
  assert.equal(intentHeuristic('Wie lege ich ein Arbeitspaket an?'), 'general');
  assert.equal(intentHeuristic('Wo finde ich die Doku?'), 'general');
  assert.equal(intentHeuristic('Formuliere mir eine höfliche Absage'), 'general');
  assert.equal(intentHeuristic('Was kannst du?'), 'general');
  assert.equal(intentHeuristic('Wie kann ich die Mail an Müller schicken?'), null, 'Aktion mit Vorgang ist Arbeit');
  assert.equal(intentHeuristic('Formuliere die Absage an den Lieferanten'), null, 'Formulierung mit Arbeitsworten');
  assert.equal(intentHeuristic('Erinnere mich morgen an die Steuererklärung'), 'personal');
  assert.equal(intentHeuristic('Was sind meine Aufgaben heute?'), 'personal');
  assert.equal(intentHeuristic('Wie steht es mit dem Angebot?'), null);
});

test('Vorbereitung: Agent in WEB und ERP, persönliches Projekt von Max', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const anna = await t.login('anna@demo.local');
  max = await t.login('max@demo.local');
  const prof = (await t.api(admin).post('/ai/profiles', { name: 'Qwen', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'qwen', personalScope: true })).json().profile;
  await t.api(admin).patch(`/ai/profiles/${prof.id}`, { personalScope: true });
  await t.api(admin).put('/ai/settings', { agentDailyBudget: 50 });
  assert.equal((await t.api(admin).put('/org/settings', { personalProjects: true })).statusCode, 200);
  agent = (await t.api(admin).post('/agents', { name: 'Ava' })).json().agent;
  assert.equal((await t.api(pl).put(`/projects/${t.ids.projects.web}/members/${agent.id}`, { role: 'member', agentCanMail: false })).statusCode, 200);
  assert.equal((await t.api(anna).put(`/projects/${t.ids.projects.erp}/members/${agent.id}`, { role: 'member', agentCanMail: false })).statusCode, 200);
  assert.equal((await t.api(pl).patch(`/tasks/${t.ids.tasks.t4}`, { responsibleUserId: agent.id })).statusCode, 200);
  const erpTask = await t.db.one(`select id from tasks where title = 'Schnittstellenliste Altsystem'`);
  assert.equal((await t.api(anna).patch(`/tasks/${erpTask.id}`, { responsibleUserId: agent.id })).statusCode, 200);
  const r = await t.api(max).post('/projects', { key: 'MAXP', name: 'Max Assistent', personal: true });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await t.api(max).put(`/projects/${r.json().project.id}/members/${agent.id}`, { role: 'member', agentCanMail: false })).statusCode, 200);
  await flushAgentRuns();
  cid = (await t.api(max).post('/chat/dm', { userId: agent.id })).json().channelId;
});

test('Marker: „allgemein“ ohne Projektdaten und ohne Befehle, „persönlich“ als Assistent, „Projekt WEB“ als Projekt (alle sicher, ohne Hinweis)', async () => {
  let r = await say('Allgemein: Was ist der Unterschied zwischen Brutto und Netto?');
  assert.equal(r.calls, 1);
  assert.match(r.prompt, /Thema: allgemeine Anfrage ohne Projektbezug/);
  assert.match(r.prompt, /Absender: Max Keller – allgemeine Anfrage: keine Befehle, keine Notizen/);
  assert.match(r.prompt, /Link \/hilfe/);
  assert.ok(noProjectData(r.prompt), 'keine Projektdaten');
  assert.ok(!r.prompt.includes('Doku im persönlichen Projekt'));
  assert.equal(await lastReply(), 'Gern, hier die Antwort.', 'sicher: kein Hinweis auf eine Annahme');
  r = await say('persönlich: Was steht bei mir an?');
  assert.match(r.prompt, /Thema: Projekt MAXP „Max Assistent“ \(persönliches Projekt des Absenders/);
  assert.match(r.prompt, /Rolle: Du bist hier persönlicher Assistent von Max Keller\./);
  assert.ok(!r.prompt.includes('Angebot Agentur') && !r.prompt.includes('Schnittstellenliste'));
  assert.equal(await lastReply(), 'Gern, hier die Antwort.');
  r = await say('Projekt WEB');
  assert.match(r.prompt, /Thema: Projekt WEB „Website-Relaunch“ \(in der Nachricht genannt\)/);
  assert.ok(r.prompt.includes('Angebot Agentur') && !r.prompt.includes('Schnittstellenliste'));
  assert.ok(!r.prompt.includes('Rolle: Du bist hier persönlicher Assistent'));
});

test('Heuristik: Tool-Frage ist allgemein (Annahme mit Hinweis, einmal), Ich-Form mit Aufgabenbezug ist persönlich', async () => {
  let r = await say('Wie lege ich ein Arbeitspaket an?');
  assert.equal(r.calls, 1);
  assert.match(r.prompt, /Thema: allgemeine Anfrage ohne Projektbezug/);
  assert.ok(noProjectData(r.prompt));
  assert.equal(await lastReply(), 'Gern, hier die Antwort. (Ich antworte allgemein, ohne Projektbezug – nenn ein Projekt oder „persönlich“, wenn es um etwas Konkretes geht.)');
  // Zweite Annahme kurz danach: kein zweiter Hinweis
  r = await say('Wo finde ich die Doku?');
  assert.match(r.prompt, /Thema: allgemeine Anfrage ohne Projektbezug/);
  assert.equal(await lastReply(), 'Gern, hier die Antwort.');
  r = await say('Erinnere mich morgen an die Steuererklärung.');
  assert.match(r.prompt, /Thema: Projekt MAXP „Max Assistent“ \(persönliches Projekt des Absenders/);
  assert.match(r.prompt, /Rolle: Du bist hier persönlicher Assistent von Max Keller\./);
  const run = await t.db.one(`select * from agent_runs where agent_user_id = $1 and trigger = 'chat' order by created_at desc limit 1`, [agent.id]);
  assert.match(run.reasoning, /Thema: MAXP \(personal\)/);
});

test('Korrektur einer Annahme per Markerwort: die vorige Frage wird mit fester Absicht neu beantwortet', async () => {
  const q = await say('Was bedeutet eigentlich „Zurückgestellt“?');
  assert.match(q.prompt, /Thema: allgemeine Anfrage ohne Projektbezug/);
  const r = await say('Projekt WEB');
  assert.equal(r.calls, 1, 'ein Lauf für die Ursprungsfrage, keiner für das Markerwort');
  assert.match(r.prompt, /Thema: Projekt WEB „Website-Relaunch“ \(auf deine Rückfrage gewählt\)/);
  assert.match(r.prompt, /Was bedeutet eigentlich „Zurückgestellt“\?[\s\S]*Die letzte Nachricht „Projekt WEB“ beantwortet nur deine Rückfrage[\s\S]*Beantworte damit die Nachricht davor von Max Keller inhaltlich: „Was bedeutet eigentlich „Zurückgestellt“\?“/);
  // Ohne Annahme davor ist ein Kürzel eine normale Nennung
  const r2 = await say('WEB');
  assert.match(r2.prompt, /\(in der Nachricht genannt\)/);
});

test('Mehrere Kandidaten ohne Anhaltspunkt: Rückfrage mit Karte (Projekte, persönlich, allgemein); Knopfwert beantwortet die Ursprungsfrage, Karte gewählt', async () => {
  const q = await say('Was meinst du dazu?');
  assert.equal(q.calls, 0, 'kein LLM-Aufruf');
  assert.equal(await lastReply(), 'Zu welchem Projekt? ERP-Einführung (ERP), Website-Relaunch (WEB), persönlich (dein Projekt) oder allgemein (kein Projekt)? Klick unten oder antworte mit Kürzel, „persönlich“ oder „allgemein“.');
  const card = await lastCard();
  assert.ok(card, 'Systemkarte');
  assert.equal(card.meta.forMessageId, q.id);
  assert.deepEqual(card.meta.choices.map((c: any) => [c.label, c.value]), [['Projekt ERP – ERP-Einführung', 'Projekt ERP'], ['Projekt WEB – Website-Relaunch', 'Projekt WEB'], ['Persönlich (mein Projekt)', 'persönlich'], ['Allgemein (kein Projekt)', 'allgemein']]);
  assert.equal(card.meta.chosen, undefined);
  const run = await t.db.one(`select * from agent_runs where agent_user_id = $1 and trigger = 'chat' order by created_at desc limit 1`, [agent.id]);
  assert.equal(run.status, 'skipped');
  assert.equal(run.error, 'Rückfrage: Thema nicht eindeutig');
  // Knopf „Allgemein“: Ursprungsfrage allgemein beantwortet, Karte gewählt, kein zweiter Lauf
  const a = await say('allgemein');
  assert.equal(a.calls, 1);
  assert.match(a.prompt, /Thema: allgemeine Anfrage ohne Projektbezug/);
  assert.match(a.prompt, /Was meinst du dazu\?[\s\S]*Die letzte Nachricht „allgemein“ beantwortet nur deine Rückfrage/);
  assert.ok(noProjectData(a.prompt));
  assert.equal((await lastCard()).meta.chosen, 'allgemein');
  assert.equal(await lastReply(), 'Gern, hier die Antwort.', 'feste Absicht: kein Hinweis');
  // Nach der Antwort ist die Karte erledigt: ein weiteres „persönlich“ ist eine neue (leere) Nachricht an den Assistenten, keine zweite Antwort auf die Karte
  const b = await say('persönlich');
  assert.equal(b.calls, 1);
  assert.match(b.prompt, /Thema: Projekt MAXP/);
  assert.ok(!b.prompt.includes('beantwortet nur deine Rückfrage'));
  assert.equal((await lastCard()).meta.chosen, 'allgemein', 'Karte bleibt beim ersten Wert');
  // Rückfrage im Thread: Antwort per Knopf „persönlich“ bleibt im Thread
  const root = await say('Was hältst du davon?');
  assert.equal(root.calls, 0);
  const inThread = await say('Lohnt sich das deiner Meinung nach?', root.id);
  assert.equal(inThread.calls, 0, 'im Thread ebenfalls unklar: Karte im Thread');
  const cardInThread = (await messages(root.id)).filter((m) => m.kind === 'system' && m.meta?.card === 'choices').at(-1);
  assert.ok(cardInThread);
  assert.equal(cardInThread.meta.forMessageId, inThread.id);
  const c = await say('persönlich', root.id);
  assert.equal(c.calls, 1);
  assert.match(c.prompt, /Thema: Projekt MAXP/);
  assert.match(c.prompt, /Lohnt sich das deiner Meinung nach\?[\s\S]*Die letzte Nachricht „persönlich“/);
  assert.equal((await messages(root.id)).find((m: any) => m.id === cardInThread.id).meta.chosen, 'persönlich');
});

test('Ohne persönliches Projekt und mit nur einem gemeinsamen Projekt: Annahme Projekt mit Hinweis; gewähltes Projekt ohne Freigabe: feste Absage', async () => {
  const pl = await t.login('pl@demo.local');
  const leser = await t.login('leser@demo.local');
  const admin = await t.login('admin@demo.local');
  // Leser bekommt „KI nutzen“ in WEB (Mitglied), nur dort hat der Agent ein gemeinsames Projekt mit ihm
  assert.equal((await t.api(pl).put(`/projects/${t.ids.projects.web}/members/${t.ids.users.leser}`, { role: 'member', canUseAi: true })).statusCode, 200);
  const dm = (await t.api(leser).post('/chat/dm', { userId: agent.id })).json().channelId;
  const n = prompts.length;
  assert.equal((await t.api(leser).post(`/chat/channels/${dm}/messages`, { body: 'Was meinst du dazu?' })).statusCode, 200);
  await flushAgentRuns();
  assert.equal(prompts.length, n + 1);
  assert.match(prompts.at(-1)!, /Thema: Projekt WEB „Website-Relaunch“ \(einziges gemeinsames Projekt\)/);
  const reply = (await t.api(leser).get(`/chat/channels/${dm}/messages`)).json().messages.filter((m: any) => m.userId === agent.id).at(-1).body;
  assert.equal(reply, 'Gern, hier die Antwort. (Ich nehme Projekt WEB – sag „allgemein“ oder nenn ein anderes Projekt, wenn ich falsch liege.)');
  // Korrektur mit einem Projekt ohne gemeinsame Freigabe: wie eine fremde Kennung
  assert.equal((await t.api(leser).post(`/chat/channels/${dm}/messages`, { body: 'Projekt ERP' })).statusCode, 200);
  await flushAgentRuns();
  assert.equal(prompts.length, n + 1, 'kein LLM-Aufruf');
  assert.equal((await t.api(leser).get(`/chat/channels/${dm}/messages`)).json().messages.filter((m: any) => m.userId === agent.id).at(-1).body, 'Dazu kann ich dir hier nichts sagen.');
  void admin;
});
