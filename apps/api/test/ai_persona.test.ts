import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { flushAgentRuns } from '../src/ai/agentEvents.js';

/** Lokales LLM: merkt sich jede Anfrage; Chat-Läufe bekommen reply/notes, Arbeitspaket-Läufe keine Aktion. */
const calls: any[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (String(input) !== 'http://llm.local:8000/v1/chat/completions') return new Response('{}', { status: 404 });
  calls.push(body);
  const system = body.messages?.[0]?.content ?? '';
  const content = !body.response_format ? 'bereit' : system.includes('Man erreicht dich im Chat') ? JSON.stringify({ reply: 'Moin, läuft.', notes: [] }) : JSON.stringify({ note: 'nichts', actions: [{ type: 'none', reason: 'Test' }] });
  return new Response(JSON.stringify({ model: 'qwen', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
};
delete process.env.ANTHROPIC_API_KEY;
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());

test('KI-Profil: Denkmodus aus sendet enable_thinking=false an das lokale Modell, abschaltbar', async () => {
  const admin = await t.login('admin@demo.local');
  const r = await t.api(admin).post('/ai/profiles', { name: 'Qwen', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'qwen', thinkingOff: true });
  assert.equal(r.statusCode, 200, r.body);
  const p = r.json().profile;
  assert.equal(p.thinkingOff, true);
  await t.api(admin).post(`/ai/profiles/${p.id}/test`);
  assert.deepEqual(calls.at(-1).chat_template_kwargs, { enable_thinking: false });
  // PATCH ohne Feld lässt den Schalter, mit false schaltet er ab
  assert.equal((await t.api(admin).patch(`/ai/profiles/${p.id}`, { name: 'Qwen 3.8' })).json().profile.thinkingOff, true);
  assert.equal((await t.api(admin).patch(`/ai/profiles/${p.id}`, { thinkingOff: false })).json().profile.thinkingOff, false);
  await t.api(admin).post(`/ai/profiles/${p.id}/test`);
  assert.equal(calls.at(-1).chat_template_kwargs, undefined);
  assert.equal((await t.api(admin).get('/ai/status')).json().profiles.find((x: any) => x.id === p.id).thinkingOff, false);
  await t.api(admin).patch(`/ai/profiles/${p.id}`, { thinkingOff: true });
  await t.api(admin).put('/ai/settings', { agentDailyBudget: 50 });
});

test('Agent-Persona: eine Zeile, nur Org-Admin, steht als Schreibstil im Prompt für Arbeitspaket und Chat', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const a = (await t.api(admin).post('/agents', { name: 'Fred', persona: 'norddeutsch knapp,\n  duzt das Team,   siezt Externe' })).json().agent;
  assert.equal(a.persona, 'norddeutsch knapp, duzt das Team, siezt Externe', 'Zeilenumbrüche und Mehrfach-Leerzeichen zusammengefasst');
  assert.equal((await t.api(admin).patch(`/agents/${a.id}`, { persona: 'x'.repeat(301) })).statusCode, 400);
  assert.equal((await t.api(pl).patch(`/agents/${a.id}`, { persona: 'von der PL' })).statusCode, 403);
  assert.equal((await t.api(admin).get('/agents')).json().agents.find((x: any) => x.id === a.id).persona, 'norddeutsch knapp, duzt das Team, siezt Externe');

  await t.api(pl).put(`/projects/${t.ids.projects.web}/members/${a.id}`, { role: 'member', agentCanMail: false });
  await t.api(pl).patch(`/tasks/${t.ids.tasks.t2}`, { responsibleUserId: a.id });
  await flushAgentRuns();
  const taskCall = calls.at(-1);
  assert.match(taskCall.messages[0].content, /Dein Schreibstil für Log, Mails, Doku und Chat: norddeutsch knapp, duzt das Team, siezt Externe\./);
  assert.deepEqual(taskCall.chat_template_kwargs, { enable_thinking: false }, 'Agent nutzt das Profil mit Denkmodus aus');

  const dm = (await t.api(max).post('/chat/dm', { userId: a.id })).json().channelId;
  await t.api(max).post(`/chat/channels/${dm}/messages`, { body: 'Moin Fred, wie läuft es?' });
  await flushAgentRuns();
  assert.match(calls.at(-1).messages[0].content, /Man erreicht dich im Chat[\s\S]*norddeutsch knapp/);

  // Persona leeren: Standardstil
  assert.equal((await t.api(admin).patch(`/agents/${a.id}`, { persona: '  ' })).json().agent.persona, null);
  await t.api(pl).post(`/tasks/${t.ids.tasks.t2}/agent-run?wait=1`);
  assert.match(calls.at(-1).messages[0].content, /Du schreibst sachlich, kurz und auf Deutsch; im Team Du, nach außen Sie\./);
  assert.doesNotMatch(calls.at(-1).messages[0].content, /norddeutsch/);
});

test('Denkmodus je Agent: überschreibt das Profil (an/aus), null = wie Profil', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const a = (await t.api(admin).get('/agents')).json().agents.find((x: any) => x.name === 'Fred');
  assert.equal(a.thinkingMode, null);
  assert.equal((await t.api(admin).patch(`/agents/${a.id}`, { thinkingMode: 'vielleicht' })).statusCode, 400);
  // Profil: Denkmodus aus; Agent: an → ausdrücklich enable_thinking = true und mehr Ausgabe-Spielraum
  assert.equal((await t.api(admin).patch(`/agents/${a.id}`, { thinkingMode: 'on' })).json().agent.thinkingMode, 'on');
  await t.api(pl).post(`/tasks/${t.ids.tasks.t2}/agent-run?wait=1`);
  assert.deepEqual(calls.at(-1).chat_template_kwargs, { enable_thinking: true });
  assert.equal(calls.at(-1).stream, true, 'gestreamt (lange Denkphasen ohne Header-Timeout)');
  assert.ok(calls.at(-1).max_tokens > 2500 + 6000, `Platz fürs Denken: ${calls.at(-1).max_tokens}`);
  // Profil an (Modellstandard), Agent aus
  const prof = a.aiProfileId;
  await t.api(admin).patch(`/ai/profiles/${prof}`, { thinkingOff: false });
  await t.api(admin).patch(`/agents/${a.id}`, { thinkingMode: 'off' });
  await t.api(pl).post(`/tasks/${t.ids.tasks.t2}/agent-run?wait=1`);
  assert.deepEqual(calls.at(-1).chat_template_kwargs, { enable_thinking: false });
  assert.equal(calls.at(-1).max_tokens, 2500);
  // wie Profil: Profil ohne Schalter → kein Feld, Modellstandard
  await t.api(admin).patch(`/agents/${a.id}`, { thinkingMode: null });
  await t.api(pl).post(`/tasks/${t.ids.tasks.t2}/agent-run?wait=1`);
  assert.equal(calls.at(-1).chat_template_kwargs, undefined);
});
