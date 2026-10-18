import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { flushAgentRuns } from '../src/ai/agentEvents.js';

/** Lokales LLM: Chat-Läufe (erkennbar am System-Prompt) bekommen reply/notes, Arbeitspaket-Läufe keine Aktion. */
const prompts: string[] = [];
let nextNotes: { taskId: string; text: string }[] = [];
/** Solange gesetzt, wartet ein Chat-Lauf nach dem Prompt auf die Freigabe (Lauf „läuft gerade“). */
let gate: Promise<void> | null = null;
const fakeFetch: typeof fetch = async (input, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (String(input) !== 'http://llm.local:8000/v1/chat/completions') return new Response('{}', { status: 404 });
  const system = body.messages?.[0]?.content ?? '';
  const user = body.messages?.[1]?.content ?? '';
  let content = 'bereit';
  if (body.response_format && system.includes('Man erreicht dich im Chat')) {
    prompts.push(user);
    if (gate) await gate;
    content = JSON.stringify({ reply: 'Das Angebot liegt vor, ich kläre die Lizenzen.', notes: nextNotes });
    nextNotes = [];
  } else if (body.response_format) content = JSON.stringify({ note: 'nichts zu tun', actions: [{ type: 'none', reason: 'Test' }] });
  return new Response(JSON.stringify({ model: 'qwen3', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { status: 200 });
};
delete process.env.ANTHROPIC_API_KEY;
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());

test('KI-Agent im Chat: Direktnachricht, Erwähnung im Projektkanal mit Thread, Log-Eintrag am Arbeitspaket, nur sichtbare Arbeitspakete', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const web = t.ids.projects.web;
  const profile = (await t.api(admin).post('/ai/profiles', { name: 'Qwen', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'qwen3' })).json().profile;
  await t.api(admin).put('/ai/settings', { agentDailyBudget: 50, defaultProfileId: profile.id });
  const agent = (await t.api(admin).post('/agents', { name: 'Chatty' })).json().agent;
  assert.equal((await t.api(pl).put(`/projects/${web}/members/${agent.id}`, { role: 'member', agentCanMail: false })).statusCode, 200);
  assert.equal((await t.api(pl).patch(`/tasks/${t.ids.tasks.t4}`, { responsibleUserId: agent.id })).statusCode, 200);
  const secret = await t.db.one(`select id from tasks where title = 'Agenturvertrag verhandeln'`);
  assert.equal((await t.api(pl).patch(`/tasks/${secret.id}`, { responsibleUserId: agent.id })).statusCode, 200);
  await flushAgentRuns();

  // Agent ist als Gesprächspartner wählbar
  const people = (await t.api(max).get('/chat/people')).json().people;
  assert.equal(people.find((p: any) => p.id === agent.id)?.kind, 'agent');

  // Direktnachricht: Agent antwortet, sieht nur, was Max sehen darf, hält Information am Arbeitspaket fest
  const dm = await t.api(max).post('/chat/dm', { userId: agent.id });
  assert.equal(dm.statusCode, 200, dm.body);
  const cid = dm.json().channelId;
  nextNotes = [{ taskId: t.ids.tasks.t4, text: 'Max: Lizenzfrage ist mit dem Einkauf geklärt.' }, { taskId: secret.id, text: 'darf nicht ankommen' }];
  assert.equal((await t.api(max).post(`/chat/channels/${cid}/messages`, { body: 'Stand zum Angebot? Lizenzfrage ist geklärt.' })).statusCode, 200);
  await flushAgentRuns();
  const p1 = prompts.at(-1)!;
  assert.ok(p1.includes('Angebot Agentur'), 'eigenes Arbeitspaket im Kontext');
  assert.ok(!p1.includes('Agenturvertrag'), 'eingeschränktes Teilprojekt bleibt draußen');
  assert.ok(p1.includes('Stand zum Angebot?'));
  const msgs = (await t.api(max).get(`/chat/channels/${cid}/messages`)).json().messages;
  assert.equal(msgs.at(-1).userId, agent.id);
  assert.equal(msgs.at(-1).body, 'Das Angebot liegt vor, ich kläre die Lizenzen.');
  const log = await t.db.query(`select body from task_comments where task_id = $1 and user_id = $2 and body like 'Aus dem Chat%'`, [t.ids.tasks.t4, agent.id]);
  assert.equal(log.rows.length, 1);
  assert.match(log.rows[0].body, /Max Keller.*Lizenzfrage/);
  assert.equal((await t.db.one(`select count(*)::int as n from task_comments where task_id = $1 and body like 'Aus dem Chat%'`, [secret.id])).n, 0, 'nur Arbeitspakete aus dem Kontext');
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'chat.dm' and link = $2`, [t.ids.users.max, `/chat/${cid}`]));
  const run = await t.db.one(`select * from agent_runs where agent_user_id = $1 and trigger = 'chat' order by created_at desc limit 1`, [agent.id]);
  assert.equal(run.channel_id, cid);
  assert.equal(run.project_id, null);

  // Projektkanal: Erwähnung → Antwort im Thread; Folgeantwort im Thread ohne Erwähnung → Agent antwortet wieder
  const ch = (await t.api(pl).get(`/projects/${web}/chat`)).json().channel.id;
  const m = (await t.api(pl).post(`/chat/channels/${ch}/messages`, { body: '@Chatty wie ist der Stand?' })).json().message;
  await flushAgentRuns();
  const thread = (await t.api(pl).get(`/chat/channels/${ch}/messages?thread=${m.id}`)).json().messages;
  assert.equal(thread.length, 1);
  assert.equal(thread[0].userId, agent.id);
  assert.ok(!prompts.at(-1)!.includes('Agenturvertrag'), 'im Projektkanal keine eingeschränkten Teilprojekte, auch nicht für die PL');
  await t.api(pl).post(`/chat/channels/${ch}/messages`, { body: 'Danke, und bis wann?', threadId: m.id });
  await flushAgentRuns();
  assert.equal((await t.api(pl).get(`/chat/channels/${ch}/messages?thread=${m.id}`)).json().messages.filter((x: any) => x.userId === agent.id).length, 2);
  // Ohne Erwähnung im Kanal bleibt der Agent still
  const before = prompts.length;
  await t.api(pl).post(`/chat/channels/${ch}/messages`, { body: 'Allgemeine Info an alle.' });
  await flushAgentRuns();
  assert.equal(prompts.length, before);
});

test('Messenger: Gesprächsliste mit Projektkanälen und Direktnachrichten, Suche über Nachrichten mit Rechten', async () => {
  const max = await t.login('max@demo.local');
  const leser = await t.login('leser@demo.local');
  const convs = (await t.api(max).get('/chat/conversations')).json().conversations;
  const web = convs.find((c: any) => c.kind === 'project' && c.projectId === t.ids.projects.web);
  assert.ok(web, 'Projektkanal WEB');
  assert.equal(web.projectKey, 'WEB');
  assert.ok(convs.some((c: any) => c.kind === 'project' && c.projectId === t.ids.projects.erp), 'ERP-Kanal wird angelegt, auch ohne Nachrichten');
  const dm = convs.find((c: any) => c.kind === 'dm' && c.partner.kind === 'agent');
  assert.equal(dm.title, 'Chatty');
  assert.ok(web.unread >= 1, 'Nachrichten der PL im Kanal ungelesen');
  assert.ok(convs.indexOf(dm) < convs.findIndex((c: any) => c.projectId === t.ids.projects.erp), 'nach letzter Aktivität');
  const hits = (await t.api(max).get('/chat/search?q=Lizenzfrage')).json().messages;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, 'Chatty');
  assert.equal((await t.api(leser).get('/chat/search?q=Lizenzfrage')).json().messages.length, 0, 'fremde Direktnachrichten nicht');
  assert.equal((await t.api(leser).get('/chat/search?q=Allgemeine')).json().messages.length, 1, 'Projektkanal für Mitglieder');
  assert.equal((await t.api(max).get('/chat/search?q=%25')).json().messages.length, 0, 'Platzhalter werden maskiert');
});

test('Nachrichten während eines Chat-Laufs gehen nicht verloren: genau ein Folgelauf, der den Verlauf neu liest', async () => {
  const max = await t.login('max@demo.local');
  const agent = await t.db.one(`select id from users where name = 'Chatty' and kind = 'agent'`);
  const cid = (await t.api(max).post('/chat/dm', { userId: agent.id })).json().channelId;
  const replies = async () => (await t.api(max).get(`/chat/channels/${cid}/messages`)).json().messages.filter((m: any) => m.userId === agent.id).length;
  const r0 = await replies();
  let release!: () => void;
  gate = new Promise<void>((r) => { release = r; });
  const n0 = prompts.length;
  await t.api(max).post(`/chat/channels/${cid}/messages`, { body: 'Erste Frage: Wann kommt das Angebot?' });
  // Der Lauf hat begonnen und wartet auf das Modell; jetzt kommen zwei weitere Nachrichten
  for (let i = 0; i < 400 && prompts.length === n0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(prompts.length, n0 + 1, 'erster Lauf läuft');
  await t.api(max).post(`/chat/channels/${cid}/messages`, { body: 'Zweite Frage: Wer prüft es?' });
  await t.api(max).post(`/chat/channels/${cid}/messages`, { body: 'Dritte Frage: Bis wann?' });
  gate = null;
  release();
  await flushAgentRuns();
  assert.equal(prompts.length, n0 + 2, 'genau ein Folgelauf für beide Nachrichten');
  assert.ok(!prompts[n0].includes('Zweite Frage'));
  assert.match(prompts[n0 + 1], /Erste Frage[\s\S]*Zweite Frage[\s\S]*Dritte Frage/, 'Folgelauf liest den Verlauf neu');
  assert.equal(await replies(), r0 + 2);
});

test('Projektkanal: Erwähnungen in verschiedenen Threads während eines Laufs bekommen je eine Antwort im eigenen Thread', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const agent = await t.db.one(`select id from users where name = 'Chatty' and kind = 'agent'`);
  const ch = (await t.api(pl).get(`/projects/${t.ids.projects.web}/chat`)).json().channel.id;
  const answers = async (id: string) => (await t.api(pl).get(`/chat/channels/${ch}/messages?thread=${id}`)).json().messages.filter((m: any) => m.userId === agent.id).length;
  let release!: () => void;
  gate = new Promise<void>((r) => { release = r; });
  const n0 = prompts.length;
  const a = (await t.api(pl).post(`/chat/channels/${ch}/messages`, { body: '@Chatty Frage A' })).json().message;
  for (let i = 0; i < 400 && prompts.length === n0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(prompts.length, n0 + 1, 'Lauf für Thread A läuft');
  // Zwei neue Threads, während der Lauf für A noch wartet: keiner verdrängt den anderen
  const b = (await t.api(max).post(`/chat/channels/${ch}/messages`, { body: '@Chatty Frage B' })).json().message;
  const c = (await t.api(pl).post(`/chat/channels/${ch}/messages`, { body: '@Chatty Frage C' })).json().message;
  gate = null;
  release();
  await flushAgentRuns();
  assert.deepEqual([await answers(a.id), await answers(b.id), await answers(c.id)], [1, 1, 1]);
  assert.equal(prompts.length, n0 + 3, 'ein Lauf je Thread');
});
