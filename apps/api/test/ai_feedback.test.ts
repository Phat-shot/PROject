import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { flushAgentRuns } from '../src/ai/agentEvents.js';

/** KI-Feedback (Migration 064): Daumen an Chat-Antworten und Läufen, automatische Signale, Liste und Export nur für die KI-Verwaltung. */
let nextCommands: any[] = [];
let nextReply = 'Mache ich.';
const C = (x: Record<string, unknown>) => ({ type: 'note', ref: '', text: '', title: '', parent: '', subproject: '', dueDate: '', deliverables: [], every: '', level: '', mode: '', depth: '', reason: '', mail: false, ...x });
const fakeFetch: typeof fetch = async (input, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (String(input) !== 'http://llm.local:8000/v1/chat/completions') return new Response('{}', { status: 404 });
  const system = body.messages?.[0]?.content ?? '';
  let content = 'bereit';
  if (body.response_format && system.includes('Man erreicht dich im Chat')) {
    content = JSON.stringify({ reply: nextReply, notes: [], answers: [], commands: nextCommands });
    nextCommands = []; nextReply = 'Mache ich.';
  } else if (body.response_format) content = JSON.stringify({ note: 'nichts zu tun', actions: [{ type: 'none', reason: 'Test' }] });
  return new Response(JSON.stringify({ model: 'qwen', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { status: 200 });
};
delete process.env.ANTHROPIC_API_KEY;
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());

let agent: any; let dm = '';
const say = async (who: any, body: string) => { const r = await t.api(who).post(`/chat/channels/${dm}/messages`, { body }); assert.equal(r.statusCode, 200, r.body); await flushAgentRuns(); };
const lastAgentMsg = async () => t.db.one(`select * from chat_messages where channel_id = $1 and user_id = $2 and kind = 'user' order by created_at desc limit 1`, [dm, agent.id]);
const fb = (kind: string) => t.db.query(`select * from ai_feedback where kind = $1 order by created_at`, [kind]).then((r) => r.rows);

test('Daumen an Chat-Antworten: speichern mit Nachricht davor und Kommentar, umschalten, zurücknehmen, Zustand in der Liste', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const p = (await t.api(admin).post('/ai/profiles', { name: 'Qwen', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'qwen' })).json().profile;
  agent = (await t.api(admin).post('/agents', { name: 'Morton', aiProfileId: p.id })).json().agent;
  await t.api(pl).put(`/projects/${t.ids.projects.web}/members/${agent.id}`, { role: 'member' });
  dm = (await t.api(pl).post('/chat/dm', { userId: agent.id })).json().channelId;
  nextReply = 'WEB hat drei offene Arbeitspakete.';
  await say(pl, 'Wie ist der Stand im Projekt WEB?');
  const m = await lastAgentMsg();
  const list = (await t.api(pl).get(`/chat/channels/${dm}/messages`)).json().messages;
  const row = list.find((x: any) => x.id === m.id);
  assert.equal(row.fromAgent, true); assert.equal(row.myRating, null);
  assert.equal(list.find((x: any) => x.userId === t.ids.users.pl).fromAgent, undefined, 'eigene Nachricht nicht bewertbar');

  assert.equal((await t.api(pl).post(`/chat/messages/${m.id}/rating`, { rating: -1, comment: 'Zahl stimmt nicht' })).statusCode, 200);
  let r = await fb('rating');
  assert.equal(r.length, 1); assert.equal(r[0].rating, -1); assert.equal(r[0].comment, 'Zahl stimmt nicht');
  assert.equal(r[0].agent_user_id, agent.id); assert.equal(r[0].project_id, t.ids.projects.web);
  assert.equal(r[0].context.input, 'Wie ist der Stand im Projekt WEB?'); assert.equal(r[0].context.output, 'WEB hat drei offene Arbeitspakete.');
  await t.api(pl).post(`/chat/messages/${m.id}/rating`, { rating: 1 });
  r = await fb('rating');
  assert.equal(r.length, 1, 'ein Eintrag je Person und Antwort'); assert.equal(r[0].rating, 1);
  assert.equal((await t.api(pl).get(`/chat/channels/${dm}/messages`)).json().messages.find((x: any) => x.id === m.id).myRating, 1);
  await t.api(pl).post(`/chat/messages/${m.id}/rating`, { rating: 0 });
  assert.equal((await fb('rating')).length, 0, 'zurückgenommen');

  const own = await t.db.one(`select id from chat_messages where channel_id = $1 and user_id = $2 limit 1`, [dm, t.ids.users.pl]);
  assert.equal((await t.api(pl).post(`/chat/messages/${own.id}/rating`, { rating: 1 })).statusCode, 404, 'nur Antworten von Agenten');
  const max = await t.login('max@demo.local');
  assert.equal((await t.api(max).post(`/chat/messages/${m.id}/rating`, { rating: 1 })).statusCode, 403, 'nur Teilnehmer des Chats');
});

test('Automatisch: ersetzte Behauptung und nicht ausgeführter Befehl mit Nachricht und Antwort', async () => {
  const pl = await t.login('pl@demo.local');
  nextReply = 'Ich habe die Mail an Müller gesendet.';
  nextCommands = [C({ type: 'pause', ref: 'WEB-999' })];
  await say(pl, 'Schick Müller die Mail und pausiere WEB-999');
  const claim = await fb('claim_replaced');
  assert.equal(claim.length, 1);
  assert.deepEqual(claim[0].context.replaced, ['Ich habe die Mail an Müller gesendet.']);
  assert.equal(claim[0].context.input, 'Schick Müller die Mail und pausiere WEB-999');
  const cmd = await fb('command_failed');
  assert.equal(cmd.length, 1); assert.equal(cmd[0].context.command.type, 'pause'); assert.match(cmd[0].context.reason, /WEB-999 nicht gefunden/);
});

test('Automatisch: Mail-Entwurf des Agenten bearbeitet (einmal, vorher bleibt) und abgelehnt', async () => {
  const pl = await t.login('pl@demo.local');
  const d = (await t.db.one(`insert into mail_drafts (account_id, task_id, project_id, user_id, to_addrs, cc_addrs, subject, body, status) values ($1,$2,$3,$4,'["lieferant@example.com"]','[]','Angebot','Bitte um Angebot.','pending_approval') returning id`, [t.ids.accounts.project, t.ids.tasks.t2, t.ids.projects.web, agent.id])).id;
  assert.equal((await t.api(pl).patch(`/mail/drafts/${d}`, { body: 'Bitte um ein Angebot bis Freitag.' })).statusCode, 200);
  await t.api(pl).patch(`/mail/drafts/${d}`, { body: 'Bitte um ein Angebot bis Freitag, danke.' });
  const e = await fb('draft_edited');
  assert.equal(e.length, 1);
  assert.equal(e[0].context.before.body, 'Bitte um Angebot.', 'Fassung des Agenten bleibt');
  assert.equal(e[0].context.after.body, 'Bitte um ein Angebot bis Freitag, danke.');
  assert.equal((await t.api(pl).del(`/mail/drafts/${d}`)).statusCode, 200);
  const rj = await fb('draft_rejected');
  assert.equal(rj.length, 1); assert.equal(rj[0].agent_user_id, agent.id);
});

test('Lauf bewerten; Liste, Zähler und Export nur für die KI-Verwaltung', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const run = await t.db.one(`insert into agent_runs (org_id, agent_user_id, project_id, task_id, trigger, status, reasoning, actions) values ($1,$2,$3,$4,'assigned','ok','Log geschrieben','[]') returning id`, [agent.org_id ?? (await t.db.one(`select org_id from users where id = $1`, [agent.id])).org_id, agent.id, t.ids.projects.web, t.ids.tasks.t2]);
  assert.equal((await t.api(pl).post(`/agent-runs/${run.id}/rating`, { rating: 1, comment: 'gut' })).statusCode, 200);
  const runs = (await t.api(pl).get(`/projects/${t.ids.projects.web}/agent-runs`)).json().runs;
  assert.equal(runs.find((x: any) => x.id === run.id).myRating, 1);

  assert.equal((await t.api(pl).get('/ai/feedback')).statusCode, 403, 'PL sieht kein Feedback');
  const all = (await t.api(admin).get('/ai/feedback')).json();
  const kinds = all.items.map((x: any) => x.kind);
  for (const k of ['rating', 'claim_replaced', 'command_failed', 'draft_edited', 'draft_rejected']) assert.ok(kinds.includes(k), k);
  assert.equal(all.items.find((x: any) => x.kind === 'rating').agent.name, 'Morton');
  assert.equal((await t.api(admin).get('/ai/feedback?kind=draft_edited')).json().items.length, 1);
  assert.ok(all.counts.some((c: any) => c.kind === 'rating' && c.up === 1));

  const jsonl = await t.api(admin).get('/ai/feedback/export');
  assert.equal(jsonl.statusCode, 200); assert.match(jsonl.headers['content-type'] as string, /ndjson/);
  const lines = jsonl.body.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, all.items.length);
  const csv = await t.api(admin).get('/ai/feedback/export?format=csv&kind=rating');
  assert.match(csv.body, /"Zeit";"Art";"Bewertung"/); assert.match(csv.body, /"rating";"1";"Morton"/);
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'ai.feedback_export'`), 'Export im Audit');
  assert.equal((await t.api(pl).get('/ai/feedback/export')).statusCode, 403);
});
