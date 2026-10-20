import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { readFile } from 'node:fs/promises';
import { aiConfigForAgent, aiConfigForProject } from '../src/ai/client.js';
import { aiAllowed } from '../src/ai/policy.js';

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
  const polNames = async () => (await t.api(pl).get(`/projects/${pers}/agents`)).json().policy.profiles.map((p: any) => p.name).sort();
  assert.deepEqual(await polNames(), ['Mein Qwen'], 'persönliches Projekt: Org-Profil „alle“ nur mit „auch in persönlichen Projekten“');
  await t.api(admin).patch(`/ai/profiles/${orgLlm}`, { personalScope: true });
  assert.deepEqual(await polNames(), ['Mein Qwen', 'Qwen'], 'freigegeben + eigenes, nicht „Nur ERP“');
  assert.equal((await t.api(pl).post(`/projects/${pers}/agents`, { name: 'X', aiProfileId: erpOnly })).statusCode, 400);
  const a = (await t.api(pl).post(`/projects/${pers}/agents`, { name: 'Assi', aiProfileId: lid })).json().agent;
  assert.equal(a.aiProfileId, lid);
  assert.ok(await aiConfigForAgent(t.db, a.id));
  await t.api(admin).patch(`/ai/profiles/${lid}`, { adminBlocked: true });
  assert.equal(await aiConfigForAgent(t.db, a.id), null, 'gesperrtes LLM: Agent läuft nicht');
  assert.equal((await t.api(admin).post('/agents', { name: 'Org', aiProfileId: lid })).statusCode, 400, 'Org-Agenten nur auf Mandantenprofilen');
});

test('Eigenes Anthropic-LLM eines Projekts nutzt nie ANTHROPIC_API_KEY; Verbindungstest nur, solange eigene LLMs erlaubt sind', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const pers = (await t.db.one(`select id from projects where key = 'PERS'`)).id;
  process.env.ANTHROPIC_API_KEY = 'server-schluessel';
  try {
    // Profil des Mandanten ohne eigenen Schlüssel: Server-Schlüssel gilt
    const org = (await t.api(admin).post('/ai/profiles', { name: 'Claude Mandant', provider: 'anthropic' })).json().profile;
    assert.equal(org.hasKey, true);
    // Eigenes LLM des Projekts ohne Schlüssel: kein Rückgriff auf den Server-Schlüssel
    const own = await t.api(pl).post(`/projects/${pers}/llms`, { name: 'Claude eigen', provider: 'anthropic' });
    assert.equal(own.statusCode, 200, own.body);
    const lid = own.json().llm.id;
    assert.equal(own.json().llm.hasKey, false);
    const test1 = await t.api(pl).post(`/projects/${pers}/llms/${lid}/test`);
    assert.equal(test1.statusCode, 400);
    assert.match(test1.json().error, /unvollständig/);
    assert.equal((await t.api(pl).patch(`/projects/${pers}`, { aiProfileId: lid })).statusCode, 200);
    assert.equal(await aiConfigForProject(t.db, pers), null, 'Projekt-KI bleibt ohne eigenen Schlüssel aus');
    // Mit eigenem Schlüssel nutzbar; schaltet der Mandant eigene LLMs ab, ist auch der Verbindungstest gesperrt
    await t.api(pl).patch(`/projects/${pers}/llms/${lid}`, { apiKey: 'projekt-schluessel' });
    assert.equal((await aiConfigForProject(t.db, pers))?.apiKey, 'projekt-schluessel');
    await t.api(admin).put('/ai/settings', { ownLlm: 'off' });
    const test2 = await t.api(pl).post(`/projects/${pers}/llms/${lid}/test`);
    assert.equal(test2.statusCode, 403);
    assert.match(test2.json().error, /nicht freigegeben/);
    await t.api(admin).put('/ai/settings', { ownLlm: 'personal' });
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test('Persönliche Projekte: Org-Profile nur mit „auch in persönlichen Projekten“ oder Auswahl; Org-Agenten dort nur mit solchem Profil; Bestand per Migration', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const pers = (await t.db.one(`select id from projects where key = 'PERS'`)).id;
  await t.api(admin).patch(`/ai/profiles/${orgLlm}`, { projectScope: 'all', personalScope: false });
  const names = async () => (await t.api(pl).get(`/projects/${pers}/llms`)).json().available.map((x: any) => x.name);
  assert.ok(!(await names()).includes('Qwen'), 'ohne Flag nicht im persönlichen Projekt');
  assert.ok((await t.api(pl).get(`/projects/${t.ids.projects.web}/llms`)).json().available.some((x: any) => x.name === 'Qwen'), 'normales Projekt unverändert');
  assert.equal((await t.api(admin).patch(`/ai/profiles/${orgLlm}`, { projectScope: 'selected', projectIds: [], personalScope: true })).statusCode, 400, 'Flag nur bei „alle“');
  assert.equal((await t.api(admin).patch(`/ai/profiles/${orgLlm}`, { personalScope: true })).statusCode, 200);
  assert.ok((await names()).includes('Qwen'), 'mit Flag');
  assert.equal((await t.api(admin).get('/ai/status')).json().profiles.find((p: any) => p.id === orgLlm).personalScope, true);
  // Auswahl statt Flag
  await t.api(admin).patch(`/ai/profiles/${orgLlm}`, { personalScope: false });
  assert.ok(!(await names()).includes('Qwen'));
  await t.api(admin).patch(`/ai/profiles/${orgLlm}`, { projectScope: 'selected', projectIds: [pers, t.ids.projects.web] });
  assert.ok((await names()).includes('Qwen'), 'per Auswahl');
  // Org-Agent: in normalen Projekten läuft er mit seinem Profil (auch scope none), im persönlichen nur mit Freigabe
  const agentsOnly = (await t.db.one(`select id from ai_profiles where name = 'Nur Agenten'`)).id;
  const orgi = (await t.api(admin).post('/agents', { name: 'Orgi', aiProfileId: agentsOnly })).json().agent;
  assert.equal((await t.api(pl).put(`/projects/${t.ids.projects.web}/members/${orgi.id}`, { role: 'member' })).statusCode, 200);
  assert.equal((await t.api(pl).put(`/projects/${pers}/members/${orgi.id}`, { role: 'member' })).statusCode, 200);
  assert.equal((await aiAllowed(t.db, { userId: orgi.id, projectId: t.ids.projects.web, feature: 'agent.run', budget: false })).allowed, true, 'normales Projekt: Profil none sperrt nicht');
  const denied = await aiAllowed(t.db, { userId: orgi.id, projectId: pers, feature: 'agent.run', budget: false });
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /im persönlichen Projekt nicht freigegeben/);
  assert.equal(await aiConfigForAgent(t.db, orgi.id, pers), null);
  assert.ok(await aiConfigForAgent(t.db, orgi.id, null));
  await t.api(admin).patch(`/ai/profiles/${agentsOnly}`, { projectScope: 'selected', projectIds: [pers] });
  assert.equal((await aiAllowed(t.db, { userId: orgi.id, projectId: pers, feature: 'agent.run', budget: false })).allowed, true, 'per Auswahl');
  // Migration: ein persönliches Projekt, das ein „alle“-Profil als Projekt-KI nutzt, behält es als Auswahl
  await t.api(admin).patch(`/ai/profiles/${orgLlm}`, { projectScope: 'all', projectIds: [], personalScope: false });
  await t.db.query(`update projects set ai_profile_id = $2 where id = $1`, [pers, orgLlm]);
  await t.db.query(`delete from ai_profile_projects where profile_id = $1`, [orgLlm]);
  await t.db.query(`delete from audit_log where action = 'ai.profile.personal_scope.migrated'`);
  assert.equal(await aiConfigForProject(t.db, pers), null, 'vor der Migration ohne Freigabe');
  await t.db.exec(await readFile(new URL('../migrations/048_profile_personal_scope.sql', import.meta.url), 'utf8'));
  assert.ok(await t.db.maybeOne(`select 1 from ai_profile_projects where profile_id = $1 and project_id = $2`, [orgLlm, pers]), 'Bestand als Auswahl');
  assert.ok(await aiConfigForProject(t.db, pers), 'Projekt-KI läuft weiter');
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'ai.profile.personal_scope.migrated' and org_id = $1`, [t.ids.org]));
});
