import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { agentBudgetLeft } from '../src/ai/agent.js';

delete process.env.ANTHROPIC_API_KEY;
const t = await testApp();
test.after(() => t.close());

let pid = '';
let profileA = '';
let profileB = '';

test('Persönliches Projekt: anlegen nur mit Freigabe, leer, nur Ersteller und Agenten, keine Einladungen, nur Mitglieder sichtbar', async () => {
  const admin = await t.login('admin@demo.local');
  const max = await t.login('max@demo.local');
  assert.equal((await t.api(max).post('/projects', { key: 'MAX', name: 'Max Assistent', personal: true })).statusCode, 403, 'ohne Freigabe nicht für Benutzer');
  assert.equal((await t.api(admin).put('/org/settings', { personalProjects: true })).statusCode, 200);
  assert.equal((await t.api(max).post('/projects', { key: 'MAXX', name: 'Normal' })).statusCode, 403, 'normale Projekte weiter nur Projektersteller');
  const r = await t.api(max).post('/projects', { key: 'MAX', name: 'Max Assistent', personal: true });
  assert.equal(r.statusCode, 200, r.body);
  pid = r.json().project.id;
  assert.equal(r.json().project.personal, true);
  assert.equal((await t.db.one(`select count(*)::int as c from doc_folders where project_id = $1`, [pid])).c, 0, 'leer');
  assert.equal((await t.api(max).put(`/projects/${pid}/members/${t.ids.users.anna}`, { role: 'member' })).statusCode, 403);
  assert.equal((await t.api(max).post('/invitations', { email: 'neu@extern.de', name: 'Neu', projectId: pid })).statusCode, 403);
  assert.equal((await t.api(max).patch(`/projects/${pid}`, { visibility: 'org' })).statusCode, 400);
  const agent = (await t.api(admin).post('/agents', { name: 'Hilfe' })).json().agent;
  assert.equal((await t.api(max).put(`/projects/${pid}/members/${agent.id}`, { role: 'pl' })).statusCode, 200, 'Agenten ja, auch als stellv. PL');
  assert.equal((await t.api(admin).get(`/projects/${pid}`)).statusCode, 403, 'Org-Admin sieht keine Inhalte');
  // Org-Admin: Agentenliste ohne Projektnamen
  const listed = (await t.api(admin).get('/agents')).json().agents.find((a: any) => a.id === agent.id);
  assert.deepEqual(listed.projects.map((p: any) => p.name), ['persönlich (Max Keller)']);
});

test('Persönliches Projekt: Audit-Export des Org-Admins ohne Details, Projektkonto verwaltet der Org-Admin nicht', async () => {
  const admin = await t.login('admin@demo.local');
  const max = await t.login('max@demo.local');
  const acc = await t.api(max).post('/mail/accounts', { type: 'project', projectId: pid, name: 'Max Postfach', address: 'max-assistent@demo.local', provider: 'dev' });
  assert.equal(acc.statusCode, 200, acc.body);
  const accountId = acc.json().account.id;
  assert.ok(!(await t.api(admin).get('/mail/accounts')).json().accounts.some((a: any) => a.id === accountId));
  assert.equal((await t.api(admin).patch(`/mail/accounts/${accountId}`, { name: 'Übernommen' })).statusCode, 403);
  assert.equal((await t.api(max).patch(`/mail/accounts/${accountId}`, { name: 'Mein Postfach' })).statusCode, 200);
  await t.api(max).post(`/projects/${pid}/tasks`, { title: 'Geheimes Thema' });
  const entries = (await t.api(admin).get('/audit')).json().entries.filter((e: any) => e.projectId === pid);
  assert.ok(entries.length >= 3);
  assert.ok(entries.every((e: any) => JSON.stringify(e.details) === '{"personalProject":true}'), 'keine Details');
  assert.ok(!JSON.stringify(entries).includes('Geheimes Thema'));
  // Projektbezogenes Audit sieht der Eigentümer vollständig
  assert.ok(JSON.stringify((await t.api(max).get(`/audit?projectId=${pid}`)).json().entries).includes('Geheimes Thema'));
});

test('Eigene Agenten der PL: nur mit Freigabe, nur freigegebene Profile, Budget gedeckelt, nur im eigenen Projekt, Org-Admin nur (de)aktivieren', async () => {
  const admin = await t.login('admin@demo.local');
  const max = await t.login('max@demo.local');
  const pl = await t.login('pl@demo.local');
  const anna = await t.login('anna@demo.local');
  profileA = (await t.api(admin).post('/ai/profiles', { name: 'Lokal A', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'qwen' })).json().profile.id;
  profileB = (await t.api(admin).post('/ai/profiles', { name: 'Teuer B', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'big' })).json().profile.id;
  assert.equal((await t.api(max).post(`/projects/${pid}/agents`, { name: 'Morton', aiProfileId: profileA })).statusCode, 403, 'nicht freigegeben');
  await t.api(admin).put('/ai/settings', { agentDailyBudget: 40, plAgents: { enabled: true, profileIds: [profileA], maxBudget: 10 } });
  assert.equal((await t.api(max).post(`/projects/${pid}/agents`, { name: 'Morton', aiProfileId: profileB })).statusCode, 400, 'Profil nicht freigegeben');
  assert.equal((await t.api(max).post(`/projects/${pid}/agents`, { name: 'Morton', aiProfileId: profileA, dailyBudget: 11 })).statusCode, 400, 'Budget über dem Deckel');
  const r = await t.api(max).post(`/projects/${pid}/agents`, { name: 'Morton', aiProfileId: profileA, dailyBudget: 5, role: 'pl', persona: 'knapp', signature: 'Morton\nfür Max' });
  assert.equal(r.statusCode, 200, r.body);
  const morton = r.json().agent;
  assert.equal(morton.projectBound.id, pid);
  const mem = await t.db.one(`select role, is_deputy from project_members where project_id = $1 and user_id = $2`, [pid, morton.id]);
  assert.deepEqual([mem.role, mem.is_deputy], ['pl', true]);
  assert.equal(await agentBudgetLeft(t.db, { id: morton.id, org_id: t.ids.org }), 5, 'eigenes Budget');
  // Nicht in anderen Projekten, kein Chat für Fremde
  assert.equal((await t.api(pl).put(`/projects/${t.ids.projects.web}/members/${morton.id}`, { role: 'member' })).statusCode, 403);
  assert.equal((await t.api(anna).post('/chat/dm', { userId: morton.id })).statusCode, 403);
  assert.equal((await t.api(max).post('/chat/dm', { userId: morton.id })).statusCode, 200);
  // Fremde PL bearbeitet ihn nicht; PL ändert im Rahmen
  assert.equal((await t.api(pl).patch(`/projects/${t.ids.projects.web}/agents/${morton.id}`, { name: 'X' })).statusCode, 404);
  assert.equal((await t.api(max).patch(`/projects/${pid}/agents/${morton.id}`, { dailyBudget: 8, persona: 'freundlich' })).json().agent.dailyBudget, 8);
  // Org-Admin: sieht ihn, darf deaktivieren, nicht gestalten
  const listed = (await t.api(admin).get('/agents')).json().agents.find((a: any) => a.id === morton.id);
  assert.match(listed.projectBound.label, /persönliches Projekt von Max Keller/);
  assert.equal((await t.api(admin).patch(`/agents/${morton.id}`, { persona: 'vom Admin' })).statusCode, 403);
  assert.equal((await t.api(admin).patch(`/agents/${morton.id}`, { active: false })).json().agent.active, false);
  assert.equal((await t.api(admin).get(`/projects/${pid}/agents`)).statusCode, 403, 'keine Projektinhalte');
});
