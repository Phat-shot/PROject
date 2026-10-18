import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { aiConfigForAgent, aiConfigForProject } from '../src/ai/client.js';

/** Lokales LLM: antwortet „bereit“ und meldet Token. */
const fakeFetch: typeof fetch = async (input, init) => {
  if (!String(input).endsWith('/chat/completions')) return new Response('{}', { status: 404 });
  void init;
  return new Response(JSON.stringify({ model: 'eigen', choices: [{ message: { role: 'assistant', content: 'bereit' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }), { status: 200 });
};
delete process.env.ANTHROPIC_API_KEY;
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());

const web = () => t.ids.projects.web;
let orgLlm = '';
let erpOnly = '';

test('Freigabe je Profil: alle, ausgewählte, keine; die PL wählt nur Verfügbares, Entzug schaltet die Projekt-KI ab', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  orgLlm = (await t.api(admin).post('/ai/profiles', { name: 'Qwen', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'qwen' })).json().profile.id;
  erpOnly = (await t.api(admin).post('/ai/profiles', { name: 'Nur ERP', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'erp', projectScope: 'selected', projectIds: [t.ids.projects.erp] })).json().profile.id;
  const agentsOnly = (await t.api(admin).post('/ai/profiles', { name: 'Nur Agenten', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'ag', projectScope: 'none' })).json().profile.id;
  const avail = (await t.api(pl).get(`/projects/${web()}/llms`)).json();
  assert.deepEqual(avail.available.map((x: any) => x.name), ['Qwen']);
  assert.equal((await t.api(pl).patch(`/projects/${web()}`, { aiProfileId: erpOnly })).statusCode, 400);
  assert.equal((await t.api(pl).patch(`/projects/${web()}`, { aiProfileId: agentsOnly })).statusCode, 400);
  assert.equal((await t.api(pl).patch(`/projects/${web()}`, { aiProfileId: orgLlm })).statusCode, 200);
  assert.ok(await aiConfigForProject(t.db, web()));
  // Org-Admin gibt nur noch für ERP frei: WEB verliert die Projekt-KI
  await t.api(admin).patch(`/ai/profiles/${orgLlm}`, { projectScope: 'selected', projectIds: [t.ids.projects.erp] });
  assert.equal(await aiConfigForProject(t.db, web()), null);
  await t.api(admin).patch(`/ai/profiles/${orgLlm}`, { projectScope: 'all' });
  assert.ok(await aiConfigForProject(t.db, web()));
  const st = (await t.api(admin).get('/ai/status')).json();
  assert.deepEqual(st.profiles.find((p: any) => p.id === erpOnly).projectIds, [t.ids.projects.erp]);
});

test('Eigenes LLM: Mandantenschalter (aus / persönlich / alle), PL bindet ein, Org-Admin sieht Metadaten und sperrt', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const own = { name: 'Mein Qwen', provider: 'local', baseUrl: 'http://mein-llm.local:8000/v1', model: 'eigen', apiKey: 'geheim-123' };
  // Standard: nur persönliche Projekte
  assert.equal((await t.api(pl).post(`/projects/${web()}/llms`, own)).statusCode, 403);
  const pers = (await t.api(pl).post('/projects', { key: 'PERS', name: 'Petras Assistent', personal: true })).json().project.id;
  const created = await t.api(pl).post(`/projects/${pers}/llms`, own);
  assert.equal(created.statusCode, 200, created.body);
  const lid = created.json().llm.id;
  assert.equal(created.json().llm.hasKey, true);
  assert.ok(!created.body.includes('geheim-123'), 'Schlüssel nie zurück');
  assert.equal((await t.api(pl).post(`/projects/${pers}/llms/${lid}/test`)).json().reply, 'bereit');
  assert.ok((await t.api(pl).get(`/projects/${pers}/llms`)).json().available.some((x: any) => x.id === lid && x.own));
  assert.ok(!(await t.api(pl).get(`/projects/${web()}/llms`)).json().available.some((x: any) => x.id === lid), 'nur im eigenen Projekt');
  assert.equal((await t.api(pl).patch(`/projects/${web()}`, { aiProfileId: lid })).statusCode, 400);
  assert.equal((await t.api(pl).patch(`/projects/${pers}`, { aiProfileId: lid })).statusCode, 200);
  // Org-Admin: Metadaten mit Verbrauch, ohne Schlüssel und ohne Projektnamen; nicht im eigenen Profil-Listing
  const list = (await t.api(admin).get('/ai/project-llms')).json().llms;
  const row = list.find((x: any) => x.id === lid);
  assert.equal(row.project, 'persönlich (Petra Lenz)');
  assert.equal(row.baseUrl, 'http://mein-llm.local:8000/v1');
  assert.ok(row.tokensIn >= 12, 'Verbrauch gezählt');
  assert.ok(!JSON.stringify(list).includes('geheim'));
  assert.ok(!(await t.api(admin).get('/ai/status')).json().profiles.some((p: any) => p.id === lid));
  assert.equal((await t.api(admin).patch(`/ai/profiles/${lid}`, { model: 'anders' })).statusCode, 403, 'nur sperren');
  assert.equal((await t.api(admin).post(`/ai/profiles/${lid}/test`)).statusCode, 404);
  assert.equal((await t.api(admin).patch(`/ai/profiles/${lid}`, { adminBlocked: true })).statusCode, 200);
  assert.equal(await aiConfigForProject(t.db, pers), null, 'gesperrt = Projekt-KI aus');
  assert.equal((await t.api(pl).patch(`/projects/${pers}/llms/${lid}`, { active: true })).json().llm.adminBlocked, true, 'PL entsperrt nicht');
  await t.api(admin).patch(`/ai/profiles/${lid}`, { adminBlocked: false });
  // Schalter aus: eigenes LLM nirgends verfügbar
  await t.api(admin).put('/ai/settings', { ownLlm: 'off' });
  assert.equal(await aiConfigForProject(t.db, pers), null);
  await t.api(admin).put('/ai/settings', { ownLlm: 'all' });
  assert.equal((await t.api(pl).post(`/projects/${web()}/llms`, { ...own, name: 'WEB eigen' })).statusCode, 200, 'alle Projekte');
  await t.api(admin).put('/ai/settings', { ownLlm: 'personal' });
});

test('Neues Projekt ohne Agent; Agenten der PL nur auf Projekt-LLMs, Agenten des Org-Admins nie auf eigenen LLMs', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const pers = (await t.db.one(`select id from projects where key = 'PERS'`)).id;
  assert.equal((await t.db.one(`select count(*)::int as c from project_members m join users u on u.id = m.user_id where m.project_id = $1 and u.kind = 'agent'`, [pers])).c, 0, 'startet ohne Agent');
  await t.api(admin).put('/ai/settings', { plAgents: { enabled: true, maxBudget: 10 } });
  const lid = (await t.db.one(`select id from ai_profiles where project_id = $1`, [pers])).id;
  const pol = (await t.api(pl).get(`/projects/${pers}/agents`)).json().policy;
  assert.deepEqual(pol.profiles.map((p: any) => p.name).sort(), ['Mein Qwen', 'Qwen'], 'freigegeben + eigenes, nicht „Nur ERP“');
  assert.equal((await t.api(pl).post(`/projects/${pers}/agents`, { name: 'X', aiProfileId: erpOnly })).statusCode, 400);
  const a = (await t.api(pl).post(`/projects/${pers}/agents`, { name: 'Assi', aiProfileId: lid })).json().agent;
  assert.equal(a.aiProfileId, lid);
  assert.ok(await aiConfigForAgent(t.db, a.id));
  await t.api(admin).patch(`/ai/profiles/${lid}`, { adminBlocked: true });
  assert.equal(await aiConfigForAgent(t.db, a.id), null, 'gesperrtes LLM: Agent läuft nicht');
  assert.equal((await t.api(admin).post('/agents', { name: 'Org', aiProfileId: lid })).statusCode, 400, 'Org-Agenten nur auf Mandantenprofilen');
});
