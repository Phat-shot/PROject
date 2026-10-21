import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { aiAllowed } from '../src/ai/policy.js';

/** Konzept LLM/Agenten: Verwalter und Einsatz. Ein Agent läuft nur in Projekten, die sein Einsatz umfasst und in denen sein LLM freigegeben ist. */
const t = await testApp();
test.after(() => t.close());
const web = () => t.ids.projects.web;
const erp = () => t.ids.projects.erp;

test('Einsatz von LLM und Agent: Aufnehmen nur, wo beides passt; Gründe für die PL; Warnungen für die Verwaltung', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const anna = await t.login('anna@demo.local');
  const all = (await t.api(admin).post('/ai/profiles', { name: 'Überall', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'qwen' })).json().profile;
  const erpOnly = (await t.api(admin).post('/ai/profiles', { name: 'Nur ERP', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'qwen', projectScope: 'selected', projectIds: [erp()] })).json().profile;
  // Agent A: LLM überall, Einsatz nur WEB; Agent B: LLM nur ERP, Einsatz alle
  assert.equal((await t.api(admin).post('/agents', { name: 'A', aiProfileId: all.id, scope: 'irgendwo' })).statusCode, 400);
  assert.equal((await t.api(admin).post('/agents', { name: 'A' })).statusCode, 400, 'ein Agent gehört zu genau einem LLM: bei mehreren wählen');
  const a = (await t.api(admin).post('/agents', { name: 'Agent A', aiProfileId: all.id, scope: 'selected', projectIds: [web()] })).json().agent;
  const b = (await t.api(admin).post('/agents', { name: 'Agent B', aiProfileId: erpOnly.id })).json().agent;
  assert.deepEqual([a.scope, a.projectIds, b.scope, b.projectIds], ['selected', [web()], 'all', []]);
  // WEB: A ja, B nein (LLM nicht freigegeben)
  assert.equal((await t.api(pl).put(`/projects/${web()}/members/${a.id}`, { role: 'member' })).statusCode, 200);
  const bWeb = await t.api(pl).put(`/projects/${web()}/members/${b.id}`, { role: 'member' });
  assert.equal(bWeb.statusCode, 400); assert.match(bWeb.json().error, /LLM „Nur ERP“ von Agent B ist für dieses Projekt nicht freigegeben/);
  // ERP: A nein (Einsatz), B ja
  const aErp = await t.api(anna).put(`/projects/${erp()}/members/${a.id}`, { role: 'member' });
  assert.equal(aErp.statusCode, 400); assert.match(aErp.json().error, /Agent A ist nicht für dieses Projekt vorgesehen/);
  assert.equal((await t.api(anna).put(`/projects/${erp()}/members/${b.id}`, { role: 'member' })).statusCode, 200);
  // Projektagent nur, wenn einsetzbar
  const pa = await t.api(pl).put(`/projects/${web()}/agent`, { agentUserId: b.id, agentMail: 'off' });
  assert.equal(pa.statusCode, 400); assert.match(pa.json().error, /nicht freigegeben/);
  assert.equal((await t.api(pl).put(`/projects/${web()}/agent`, { agentUserId: a.id, agentMail: 'off' })).statusCode, 200);
  // Einladen: Agenten mit Einsetzbarkeit und Grund; Agenten im Projekt mit Status
  const list = (await t.api(pl).get(`/projects/${web()}/agents`)).json();
  const oa = (name: string) => list.candidates.find((x: any) => x.name === name);
  assert.ok(!oa('Agent A'), 'schon im Projekt');
  assert.equal(oa('Agent B').usable, false);
  assert.match(oa('Agent B').reason, /nicht freigegeben/);
  assert.deepEqual(list.inProject.filter((x: any) => x.name === 'Agent A').map((x: any) => [x.role, x.usable, x.profileName]), [['pl', true, 'Überall']]);
  // Einsatz des Agenten enger: Rollenwechsel bleibt möglich, Lauf nicht; Warnung in der Antwort; Liste zeigt den Grund
  const upd = await t.api(admin).patch(`/agents/${a.id}`, { scope: 'selected', projectIds: [erp()] });
  assert.equal(upd.statusCode, 200, upd.body);
  assert.ok(upd.json().warnings.some((w: string) => /^Läuft in WEB Website-Relaunch nicht: Agent A ist nicht für dieses Projekt vorgesehen/.test(w)), JSON.stringify(upd.json().warnings));
  assert.equal((await t.api(pl).put(`/projects/${web()}/members/${a.id}`, { role: 'member' })).statusCode, 200, 'Rollenwechsel eines Mitglieds');
  const d = await aiAllowed(t.db, { userId: a.id, projectId: web(), feature: 'agent.run', budget: false });
  assert.equal(d.allowed, false); assert.equal(d.stage, 'profile'); assert.match(d.reason, /nicht für dieses Projekt vorgesehen/);
  const agents = (await t.api(admin).get('/agents')).json().agents;
  const aRow = agents.find((x: any) => x.id === a.id);
  assert.deepEqual([aRow.profileName, aRow.projects.find((p: any) => p.id === web()).usable], ['Überall', false]);
  assert.match(aRow.projects.find((p: any) => p.id === web()).reason, /nicht für dieses Projekt vorgesehen/);
  // Einsatz wieder weit: läuft
  await t.api(admin).patch(`/agents/${a.id}`, { scope: 'all', projectIds: [] });
  assert.equal((await aiAllowed(t.db, { userId: a.id, projectId: web(), feature: 'agent.run', budget: false })).allowed, true);
  // LLM-Änderung: Freigabe enger → Warnung für Agenten an diesem LLM
  const c = (await t.api(admin).post('/agents', { name: 'Agent C', aiProfileId: all.id })).json().agent;
  assert.equal((await t.api(pl).put(`/projects/${web()}/members/${c.id}`, { role: 'member' })).statusCode, 200, 'LLM überall');
  const narrowed = await t.api(admin).patch(`/ai/profiles/${all.id}`, { projectScope: 'selected', projectIds: [erp()] });
  assert.ok(narrowed.json().warnings.some((w: string) => /^Agent C läuft in WEB Website-Relaunch nicht mehr: LLM „Überall“ von Agent C/.test(w)), JSON.stringify(narrowed.json().warnings));
  assert.ok(narrowed.json().warnings.some((w: string) => /^Agent A läuft in WEB Website-Relaunch nicht mehr/.test(w)));
  // LLM mit aktiven Agenten lässt sich nicht löschen
  const del = await t.api(admin).del(`/ai/profiles/${erpOnly.id}`);
  assert.equal(del.statusCode, 400); assert.match(del.json().error, /aktive Agenten/);
});
