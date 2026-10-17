import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { runAgents } from '../src/ai/agent.js';

/** Lokales LLM (OpenAI-kompatibel wie vLLM): antwortet mit Aktionen je nach Prompt. */
const calls: { url: string; body: any }[] = [];
let nextActions: any[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  calls.push({ url, body });
  if (url === 'http://llm.local:8000/v1/chat/completions') {
    if (body.model !== 'qwen3') return new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 });
    const content = body.response_format ? JSON.stringify({ note: 'Stand unklar, Lieferant gefragt.', actions: nextActions }) : 'bereit';
    return new Response(JSON.stringify({ model: 'qwen3', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 500, completion_tokens: 40 } }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
};
delete process.env.ANTHROPIC_API_KEY;
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());

let profileId = '';
test('Lokales LLM als Profil: Org-Admin legt es an (Adresse, Modell, optional Schlüssel), Verbindungstest, Tagesbudget', async () => {
  const admin = await t.login('admin@demo.local');
  const r = await t.api(admin).post('/ai/profiles', { name: 'Qwen auf vLLM', provider: 'local', baseUrl: 'http://llm.local:8000/v1/', model: 'qwen3' });
  assert.equal(r.statusCode, 200, r.body);
  profileId = r.json().profile.id;
  assert.equal(r.json().profile.baseUrl, 'http://llm.local:8000/v1');
  assert.equal((await t.api(admin).get('/ai/status')).json().enabled, true, 'ohne Schlüssel aktiv');
  const ok = await t.api(admin).post(`/ai/profiles/${profileId}/test`);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().reply, 'bereit');
  assert.ok(calls.some((c) => c.url === 'http://llm.local:8000/v1/chat/completions' && c.body.messages[0].role === 'system'));
  const wrong = (await t.api(admin).post('/ai/profiles', { name: 'Kaputt', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'gibtsnicht' })).json().profile;
  assert.equal((await t.api(admin).post(`/ai/profiles/${wrong.id}/test`)).statusCode, 400);
  assert.equal((await t.api(admin).post('/ai/profiles', { name: 'Ohne Adresse', provider: 'local', model: 'x' })).statusCode, 400);
  const s = await t.api(admin).put('/ai/settings', { agentDailyBudget: 5, defaultProfileId: profileId });
  assert.equal(s.json().agentDailyBudget, 5);
  assert.equal(s.json().defaultProfileId, profileId);
});

test('Agent: nur Org-Admin legt an; kein Login; Mitgliedschaft wird Mitglied mit Stellvertretung; Zuweisung nur durch PL', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  assert.equal((await t.api(pl).post('/agents', { name: 'Nachfasser' })).statusCode, 403);
  const a = (await t.api(admin).post('/agents', { name: 'Nachfasser' })).json().agent;
  assert.match(a.email, /@agent\.local$/);
  assert.equal(a.aiProfileId, profileId, 'Standardprofil des Mandanten');
  const wrong = (await t.api(admin).get('/ai/profiles')).json().profiles.find((p: any) => p.name === 'Kaputt');
  assert.equal((await t.api(admin).patch(`/agents/${a.id}`, { aiProfileId: wrong.id })).json().agent.aiProfileId, wrong.id);
  assert.equal((await t.api(admin).patch(`/agents/${a.id}`, { aiProfileId: profileId })).json().agent.aiProfileId, profileId);
  const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: a.email, password: 'irgendwas' } });
  assert.equal(login.statusCode, 401);
  const forgot = await t.app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: a.email } });
  assert.ok([200, 400, 404].includes(forgot.statusCode));
  const pid = t.ids.projects.web;
  const mem = await t.api(pl).put(`/projects/${pid}/members/${a.id}`, { role: 'pl', isDeputy: false, canApprove: true, agentCanMail: false });
  assert.equal(mem.statusCode, 200, mem.body);
  assert.equal(mem.json().membership.role, 'member');
  assert.equal(mem.json().membership.isDeputy, true);
  assert.equal(mem.json().membership.canApprove, false);
  assert.equal(mem.json().membership.agentCanMail, false);
  const detail = await t.api(pl).get(`/projects/${pid}`);
  const row = detail.json().members.find((m: any) => m.userId === a.id);
  assert.equal(row.kind, 'agent');
  const list = (await t.api(pl).get('/agents')).json().agents;
  assert.ok(list.find((x: any) => x.id === a.id).projects.some((p: any) => p.key === 'WEB'));
  // Zuweisung: Mitglied darf nicht, PL darf
  const byMember = await t.api(max).patch(`/tasks/${t.ids.tasks.t2}`, { responsibleUserId: a.id });
  assert.equal(byMember.statusCode, 403);
  const created = await t.api(max).post(`/projects/${pid}/tasks`, { title: 'Agentenjob', responsibleUserId: a.id });
  assert.equal(created.statusCode, 403);
  const byPl = await t.api(pl).patch(`/tasks/${t.ids.tasks.t2}`, { responsibleUserId: a.id });
  assert.equal(byPl.statusCode, 200, byPl.body);
  assert.equal(byPl.json().task.responsibleUserId, a.id);
});

test('Agentenlauf: Kontext aus Arbeitspaket, Aktionen (Log, Status, Task, Mail als Entwurf ohne Mail-Recht, direkt mit Recht, Eskalation), Budget und Pause', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const pid = t.ids.projects.web;
  const a = (await t.api(pl).get('/agents')).json().agents[0];
  const taskId = t.ids.tasks.t2;
  await t.db.query(`update tasks set column_id = (select id from board_columns where project_id = $2 order by position limit 1) where id = $1`, [taskId, pid]);
  const item = (await t.api(pl).post(`/tasks/${taskId}/checklist`, { title: 'Angebot prüfen' })).json();
  const itemId = (item.item ?? item.checklist?.[0] ?? item).id ?? (await t.db.one(`select id from checklist_items where task_id = $1 order by position desc limit 1`, [taskId])).id;
  nextActions = [
    { type: 'comment', text: 'Stand geprüft: Angebot liegt vor, Lizenzfrage offen.' },
    { type: 'set_status', column: 'In Arbeit' },
    { type: 'check_item', itemId },
    { type: 'mail', to: ['k.mueller@mueller-design.de'], subject: 'Rückfrage Lizenzen', text: 'Guten Tag Frau Müller, bitte um Klärung der Lizenzfrage. Nachfasser (KI-Agent, Projekt WEB)' },
    { type: 'escalate', text: 'Budgetfreigabe für Lizenzen nötig.' }
  ];
  const r = await t.api(pl).post(`/tasks/${taskId}/agent-run`);
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().actions.map((x: any) => x.type), ['comment', 'set_status', 'check_item', 'mail', 'escalate']);
  const prompt: string = calls[calls.length - 1].body.messages[1].content;
  assert.match(prompt, /Arbeitspaket WEB-\d+/);
  assert.match(prompt, /nur als Entwurf zur Freigabe/);
  assert.match(prompt, /Angebot prüfen \(itemId/);
  assert.equal(calls[calls.length - 1].body.response_format.type, 'json_schema');
  const col = await t.db.one(`select c.name from tasks t join board_columns c on c.id = t.column_id where t.id = $1`, [taskId]);
  assert.equal(col.name, 'In Arbeit');
  const done = await t.db.one(`select done from checklist_items where id = $1`, [itemId]);
  assert.equal(done.done, true);
  const comments = await t.db.query(`select body, source, user_id from task_comments where task_id = $1 and source = 'ai' order by created_at`, [taskId]);
  assert.ok(comments.rows.every((c: any) => c.user_id === a.id), 'Einträge unter der Agent-ID');
  assert.ok(comments.rows.some((c: any) => /Stand geprüft/.test(c.body)));
  const draft = await t.db.maybeOne(`select * from mail_drafts where task_id = $1 and user_id = $2`, [taskId, a.id]);
  assert.ok(draft, 'ohne Mail-Recht: Entwurf');
  assert.equal(draft.status, 'pending_approval');
  const plNotif = await t.db.maybeOne(`select 1 from notifications where user_id = $1 and title like 'Nachfasser braucht eine Entscheidung%'`, [t.ids.users.pl]);
  assert.ok(plNotif, 'Eskalation erreicht die PL');
  const runs = (await t.api(pl).get(`/projects/${pid}/agent-runs?taskId=${taskId}`)).json().runs;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].trigger, 'manual');
  assert.equal(runs[0].inputTokens, 500);
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'agent.run' and user_id = $1`, [a.id]));

  // Mit Mail-Recht: direkter Versand über das Projektkonto
  await t.api(pl).put(`/projects/${pid}/members/${a.id}`, { role: 'member', agentCanMail: true });
  const before = t.mail.dev.sent.length;
  nextActions = [{ type: 'mail', to: ['k.mueller@mueller-design.de'], subject: 'Erinnerung', text: 'Kurze Erinnerung. Nachfasser (KI-Agent, Projekt WEB)' }];
  await t.api(pl).post(`/tasks/${taskId}/agent-run`);
  assert.equal(t.mail.dev.sent.length, before + 1);
  assert.equal(t.mail.dev.sent[before].msg.subject, 'Erinnerung');

  // Worker: nur bei Anlass; Pause stoppt; Budget deckelt
  nextActions = [{ type: 'none', reason: 'nichts Neues' }];
  const r1 = await runAgents(t.db, t.mail, fakeFetch);
  assert.equal(r1.length, 0, 'kein Anlass direkt nach dem letzten Lauf');
  await t.api(pl).post(`/tasks/${taskId}/comments`, { body: 'Bitte auch Hosting klären.' });
  const r2 = await runAgents(t.db, t.mail, fakeFetch, new Date(Date.now() + 3600_000));
  assert.equal(r2.length, 1);
  assert.equal(r2[0].trigger ?? 'changed', 'changed');
  await t.api(pl).post(`/tasks/${taskId}/agent-pause`, { paused: true });
  await t.api(pl).post(`/tasks/${taskId}/comments`, { body: 'Noch etwas.' });
  const r3 = await runAgents(t.db, t.mail, fakeFetch, new Date(Date.now() + 2 * 3600_000));
  assert.equal(r3.length, 0, 'pausiert');
  await t.api(pl).post(`/tasks/${taskId}/agent-pause`, { paused: false });
  await t.api(admin).put('/ai/settings', { agentDailyBudget: 3 });
  const r4 = await runAgents(t.db, t.mail, fakeFetch, new Date(Date.now() + 4 * 3600_000));
  assert.equal(r4.length, 0, 'Tagesbudget (3) durch die bisherigen Läufe aufgebraucht');
  // Deaktivieren nimmt die Zuweisung weg
  await t.api(admin).patch(`/agents/${a.id}`, { active: false });
  const after = await t.db.one(`select responsible_user_id from tasks where id = $1`, [taskId]);
  assert.equal(after.responsible_user_id, null);
});
