import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { flushAgentRuns } from '../src/ai/agentEvents.js';

/**
 * Persönlicher Assistent: Agent im persönlichen Projekt ist im Chat angepinnt; unspezifische Aufträge landen im persönlichen
 * Projekt, laufen sofort, Mails kommen als Entwurf mit Karte in den Chat, erledigt heißt abgeschlossen und archiviert.
 */
let chatReply: { reply: string; commands: any[] } = { reply: 'Mache ich.', commands: [] };
let runActions: any[] = [];
const C = (x: Record<string, unknown>) => ({ type: 'order', ref: '', text: '', title: '', parent: '', subproject: '', dueDate: '', deliverables: [], every: '', level: '', mode: '', depth: '', reason: '', mail: false, ...x });
const fakeFetch: typeof fetch = async (input, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (String(input) !== 'http://llm.local:8000/v1/chat/completions') return new Response('{}', { status: 404 });
  const system = body.messages?.[0]?.content ?? '';
  let content = 'bereit';
  if (body.response_format && system.includes('Man erreicht dich im Chat')) { content = JSON.stringify({ ...chatReply, notes: [], answers: [] }); chatReply = { reply: 'Mache ich.', commands: [] }; }
  else if (body.response_format && body.messages?.[1]?.content?.includes('Auftrag deines Eigentümers')) { content = JSON.stringify({ note: 'Assistent', actions: runActions }); runActions = []; }
  else if (body.response_format) content = JSON.stringify({ note: 'nichts', actions: [{ type: 'none', reason: 'Test' }] });
  return new Response(JSON.stringify({ model: 'qwen', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
};
delete process.env.ANTHROPIC_API_KEY;
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());

let pid = ''; let agent: any; let dm = '';

test('Agent im persönlichen Projekt ist angepinnt, auch ohne Nachricht', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  await t.api(admin).put('/org/settings', { personalProjects: true });
  const llm = (await t.api(admin).post('/ai/profiles', { name: 'Qwen', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'qwen', personalScope: true })).json().profile;
  agent = (await t.api(admin).post('/agents', { name: 'James', aiProfileId: llm.id })).json().agent;
  pid = (await t.api(pl).post('/projects', { key: 'PETRA', name: 'Petra Assistent', personal: true })).json().project.id;
  assert.equal((await t.api(pl).put(`/projects/${pid}/members/${agent.id}`, { role: 'pl' })).statusCode, 200);
  const convs = (await t.api(pl).get('/chat/conversations')).json().conversations;
  assert.equal(convs[0].partner?.id, agent.id, 'oben');
  assert.equal(convs[0].pinned, true);
  dm = convs[0].channelId;
  assert.equal((await t.api(pl).get('/chat/assistant')).json().assistant.channelId, dm);
  const max = await t.login('max@demo.local');
  assert.equal((await t.api(max).get('/chat/assistant')).json().assistant, null, 'ohne persönliches Projekt kein Assistent');
});

test('Unspezifischer Auftrag: im persönlichen Projekt angelegt und sofort ausgeführt; Mail als Entwurf mit Karte; erledigt → archiviert ohne Rückfrage', async () => {
  const pl = await t.login('pl@demo.local');
  assert.equal((await t.api(pl).post(`/projects/${pid}/mail/views`, { accountId: t.ids.accounts.personal, name: 'Mein Postfach' })).statusCode, 200);
  chatReply = { reply: 'Ich schreibe Sven.', commands: [C({ title: 'Sven nach dem Stand fragen', text: 'Frag Sven, wie der Stand beim Termin 6.–8.11. ist' })] };
  runActions = [{ type: 'mail', to: ['sven@airgpu.example'], subject: 'Termin 6.–8.11.', text: 'Hallo Sven,\n\nwie ist der Stand?\n\nPetra' }, { type: 'set_status', column: 'Erledigt' }];
  const r = await t.api(pl).post(`/chat/channels/${dm}/messages`, { body: 'Frag Sven, wie der Stand beim Termin 6.–8.11. ist' });
  assert.equal(r.statusCode, 200);
  await flushAgentRuns(); await flushAgentRuns();
  const task = await t.db.one(`select * from tasks where title = 'Sven nach dem Stand fragen'`);
  assert.equal(task.project_id, pid, 'persönliches Projekt');
  assert.ok(await t.db.maybeOne(`select 1 from notification_rules where task_id = $1 and event = 'progress' and timing->>'every' = 'each'`, [task.id]), 'jeder Schritt im Chat');
  const draft = await t.db.one(`select * from mail_drafts where task_id = $1`, [task.id]);
  assert.equal(draft.status, 'pending_approval');
  const card = await t.db.one(`select * from chat_messages where channel_id = $1 and kind = 'system' and meta->>'card' = 'draft'`, [dm]);
  assert.equal(card.meta.draftId, draft.id);
  assert.equal((await t.api(pl).get(`/mail/drafts/${draft.id}`)).json().draft.subject, 'Termin 6.–8.11.');
  const done = await t.db.one(`select archived_at from tasks where id = $1`, [task.id]);
  assert.ok(done.archived_at, 'erledigt und archiviert');
  assert.equal((await t.db.one(`select count(*)::int as c from ai_proposals where task_id = $1 and kind = 'agent_action'`, [task.id])).c, 0, 'keine Rückfrage für Erledigt oder die Mail');
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and body like 'Auftrag erledigt und archiviert%'`, [task.id]));
});
