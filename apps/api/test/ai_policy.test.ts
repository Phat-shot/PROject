import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_AGENT_RIGHTS } from '@projekttool/shared';
import { testApp } from './helpers.js';
import { createDb, runMigrations } from '../src/db.js';
import { agentBudgetLeft } from '../src/ai/agent.js';
import { aiAllowed, NO_AI_RIGHT } from '../src/ai/policy.js';
import { flushAgentRuns } from '../src/ai/agentEvents.js';

/**
 * Agentenmodell: Im Projekt arbeiten nur Agenten. Wer das LLM verwaltet, legt Agenten an und berechtigt sie; die PL lädt ein und
 * schränkt nur weiter ein. Personen lösen Assistenz und Chat aus („KI nutzen“), ausgeführt wird von einem Agenten.
 */
const calls: any[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (String(input) !== 'http://llm.local:8000/v1/chat/completions') return new Response('{}', { status: 404 });
  calls.push(body);
  const req: string[] = body.response_format?.json_schema?.schema?.required ?? [];
  const content = req.includes('note') ? JSON.stringify({ note: 'geprüft', actions: [{ type: 'none', reason: 'nichts zu tun' }] })
    : req.includes('reply') ? JSON.stringify({ reply: 'Hier der Stand.', notes: [] })
    : req.includes('summary') ? JSON.stringify({ summary: 'nichts', actions: [] })
    : 'Antwort der KI [Q1]. bereit';
  return new Response(JSON.stringify({ model: 'lokal', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
};
delete process.env.ANTHROPIC_API_KEY;
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());

const web = () => t.ids.projects.web;
const erp = () => t.ids.projects.erp;
let profileId = '';
let morton: any;
let mortonTask = '';
const without = (f: string) => DEFAULT_AGENT_RIGHTS.filter((x) => x !== f);

test('Einrichtung: LLM, Agent Morton am LLM, von der PL eingeladen, mit Arbeitspaket', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  profileId = (await t.api(admin).post('/ai/profiles', { name: 'Lokal', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'lokal' })).json().profile.id;
  await t.api(admin).put('/ai/settings', { agentDailyBudget: 50 });
  morton = (await t.api(admin).post('/agents', { name: 'Morton', aiProfileId: profileId })).json().agent;
  assert.deepEqual(morton.rights, DEFAULT_AGENT_RIGHTS, 'Standardrechte beim Anlegen');
  assert.ok(!morton.rights.includes('agent.web'), 'Online-Recherche ist beim Anlegen aus');
  await t.api(pl).put(`/projects/${web()}/members/${morton.id}`, { role: 'member' });
  mortonTask = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Freigaben prüfen', responsibleUserId: morton.id })).json().task.id;
  await flushAgentRuns();
  assert.ok(await t.db.maybeOne(`select 1 from agent_runs where task_id = $1 and status = 'ok'`, [mortonTask]), 'mit Standardrechten läuft der Agent');
});

test('Rechte am Agenten (Verwalter des LLM) und Einschränkung durch die PL: die PL kann nur abschalten', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const run = () => aiAllowed(t.db, { userId: morton.id, projectId: web(), feature: 'agent.run', budget: false });
  // Verwalter entzieht das Recht: Stufe policy, Begründung nennt den Agenten
  assert.equal((await t.api(admin).patch(`/agents/${morton.id}`, { rights: without('agent.run') })).statusCode, 200);
  let d = await run();
  assert.deepEqual([d.allowed, d.stage], [false, 'policy']);
  assert.match(d.reason, /Arbeitspakete bearbeiten: für Morton nicht freigegeben/);
  assert.equal((await t.api(admin).patch(`/agents/${morton.id}`, { rights: ['agent.gibtsnicht'] })).statusCode, 400);
  await t.api(admin).patch(`/agents/${morton.id}`, { rights: DEFAULT_AGENT_RIGHTS });
  // PL schaltet im Projekt ab: Stufe project, gilt nur in diesem Projekt
  assert.equal((await t.api(pl).put(`/projects/${web()}/members/${morton.id}/agent-policy`, { deny: ['agent.run'] })).statusCode, 200);
  d = await run();
  assert.deepEqual([d.allowed, d.stage], [false, 'project']);
  assert.match(d.reason, /in diesem Projekt abgeschaltet/);
  // Was der Verwalter nicht gibt, kann die PL nicht einschalten (deny nur über erteilte Rechte; agent.web ist nicht erteilt)
  const pol = await t.api(pl).put(`/projects/${web()}/members/${morton.id}/agent-policy`, { deny: ['agent.web'] });
  assert.equal(pol.json().policy, null, 'nicht erteilte Rechte fallen weg');
  assert.equal((await aiAllowed(t.db, { userId: morton.id, projectId: web(), feature: 'agent.web', budget: false })).stage, 'policy');
  assert.equal((await run()).allowed, true);
  // Übersicht für die PL: Rechte vom Verwalter, Einschränkung im Projekt
  const ap = (await t.api(pl).get(`/projects/${web()}/agent-policy`)).json().agents.find((a: any) => a.userId === morton.id);
  assert.deepEqual(ap.rights, DEFAULT_AGENT_RIGHTS);
  // Ein Agent mit entzogenem Recht wird übersprungen, ohne LLM-Aufruf, nicht budgetwirksam
  await t.api(admin).patch(`/agents/${morton.id}`, { rights: without('agent.run') });
  const before = calls.length; const budget = await agentBudgetLeft(t.db, { id: morton.id, org_id: t.ids.org });
  await t.api(pl).post(`/tasks/${mortonTask}/comments`, { body: 'Bitte prüfen.' });
  await flushAgentRuns();
  const skipped = await t.db.one(`select * from agent_runs where task_id = $1 order by created_at desc limit 1`, [mortonTask]);
  assert.equal(skipped.status, 'skipped'); assert.match(skipped.error, /nicht freigegeben/);
  assert.equal(calls.length, before);
  assert.equal(await agentBudgetLeft(t.db, { id: morton.id, org_id: t.ids.org }), budget);
  await t.api(admin).patch(`/agents/${morton.id}`, { rights: DEFAULT_AGENT_RIGHTS });
});

test('Notaus: sperrt Personen, Agenten und Verbindungstests; Läufe übersprungen ohne LLM-Aufruf', async () => {
  const admin = await t.login('admin@demo.local');
  const max = await t.login('max@demo.local');
  const pl = await t.login('pl@demo.local');
  const st = (await t.api(admin).put('/ai/settings', { enabled: false })).json();
  assert.deepEqual([st.killswitch, st.enabled], [true, false]);
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'ai.killswitch' and details->>'enabled' = 'false'`));
  const d = await aiAllowed(t.db, { userId: t.ids.users.max, projectId: web(), feature: 'assist.ask' });
  assert.deepEqual([d.allowed, d.stage, d.reason], [false, 'killswitch', 'KI im Mandanten abgeschaltet (Notaus)']);
  const r = await t.api(max).post(`/projects/${web()}/ai/ask`, { question: 'Was blockiert?' });
  assert.equal(r.statusCode, 403); assert.match(r.json().error, /Notaus/);
  assert.equal((await t.api(admin).post(`/ai/profiles/${profileId}/test`)).statusCode, 403);
  const before = calls.length;
  // eigenes Arbeitspaket: übersprungene Läufe stehen je Arbeitspaket und Tag nur einmal in der Liste
  const task = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Notaus prüfen', responsibleUserId: morton.id })).json().task.id;
  try {
    await flushAgentRuns();
    const skipped = await t.db.one(`select * from agent_runs where task_id = $1 order by created_at desc limit 1`, [task]);
    assert.deepEqual([skipped.status, skipped.error], ['skipped', 'KI im Mandanten abgeschaltet (Notaus)']);
    assert.equal(calls.length, before, 'kein LLM-Aufruf');
    assert.equal((await t.api(pl).post(`/tasks/${task}/agent-run?wait=1`)).statusCode, 403);
  } finally {
    await t.api(admin).put('/ai/settings', { enabled: true });
  }
});

test('KI-Verwaltung (Org-Recht ai_admin): LLMs und deren Agenten ohne Org-Admin; nur der Org-Admin vergibt Org-Rechte', async () => {
  const admin = await t.login('admin@demo.local');
  const anna = await t.login('anna@demo.local');
  assert.equal((await t.api(anna).put('/ai/settings', { agentDailyBudget: 40 })).statusCode, 403);
  assert.equal((await t.api(anna).post('/agents', { name: 'Hilfe', aiProfileId: profileId })).statusCode, 403, 'Org-LLM verwaltet die KI-Verwaltung');
  assert.equal((await t.api(anna).patch(`/users/${t.ids.users.anna}`, { orgRights: ['ai_admin'] })).statusCode, 403, 'nur Org-Admin');
  assert.equal((await t.api(admin).patch(`/users/${morton.id}`, { orgRights: ['ai_admin'] })).statusCode, 400, 'Agenten nie');
  assert.equal((await t.api(admin).patch(`/users/${t.ids.users.anna}`, { orgRights: ['ai_admin'] })).statusCode, 200);
  assert.equal((await t.api(anna).put('/ai/settings', { agentDailyBudget: 40 })).json().agentDailyBudget, 40);
  const hilfe = await t.api(anna).post('/agents', { name: 'Hilfe', aiProfileId: profileId, rights: ['assist.ask', 'agent.chat'], policy: { maxMode: 'confirm_all' } });
  assert.equal(hilfe.statusCode, 200, hilfe.body);
  assert.deepEqual([hilfe.json().agent.rights, hilfe.json().agent.policy.maxMode], [['assist.ask', 'agent.chat'], 'confirm_all']);
  assert.equal((await t.api(anna).post('/agents', { name: 'Budget', aiProfileId: profileId, dailyBudget: 99 })).statusCode, 400, 'höchstens das Budget des Mandanten');
  assert.equal((await t.api(anna).get('/audit')).statusCode, 403, 'keine Auditverwaltung');
  await t.api(admin).patch(`/agents/${hilfe.json().agent.id}`, { active: false });
  await t.api(admin).put('/ai/settings', { agentDailyBudget: 50 });
  await t.api(admin).patch(`/users/${t.ids.users.anna}`, { orgRights: [] });
});

test('Personen: Assistenz und Chat nur mit „KI nutzen“; Leser nur Fragen; Fähigkeiten mit Begründung', async () => {
  const pl = await t.login('pl@demo.local');
  const max = t.ids.users.max;
  assert.equal((await aiAllowed(t.db, { userId: max, projectId: web(), feature: 'assist.summarize' })).allowed, true);
  await t.api(pl).put(`/projects/${web()}/members/${max}`, { role: 'member', canUseAi: false });
  const d = await aiAllowed(t.db, { userId: max, projectId: web(), feature: 'agent.chat' });
  assert.deepEqual([d.allowed, d.reason], [false, NO_AI_RIGHT]);
  assert.equal((await aiAllowed(t.db, { userId: max, projectId: web(), feature: 'agent.run' })).reason, 'Arbeitspakete bearbeiten: gilt nur für KI-Agenten');
  await t.api(pl).put(`/projects/${web()}/members/${max}`, { role: 'member', canUseAi: true, canEditPlan: true });
  assert.equal((await aiAllowed(t.db, { userId: t.ids.users.leser, projectId: web(), feature: 'assist.report' })).allowed, false);
  // Fähigkeiten: Person erlaubt, ausführender Agent mit Begründung; Agentenliste mit Assistenz-Rechten
  const caps = (await t.api(await t.login('max@demo.local')).get(`/projects/${web()}/ai/capabilities`)).json();
  assert.equal(caps.assistAgentId, morton.id);
  assert.equal(caps.features['assist.summarize'].allowed, true);
  assert.ok(caps.agents.find((a: any) => a.id === morton.id).assist.includes('assist.ask'));
  await t.api(pl).put(`/projects/${web()}/members/${morton.id}/agent-policy`, { deny: ['assist.summarize'] });
  const c2 = (await t.api(pl).get(`/projects/${web()}/ai/capabilities`)).json();
  assert.deepEqual([c2.features['assist.summarize'].allowed, c2.features['assist.summarize'].reason], [false, 'Kein Agent im Projekt darf „Mail zusammenfassen“ (Einstellungen › KI)']);
  await t.api(pl).put(`/projects/${web()}/members/${morton.id}/agent-policy`, null);
});

test('Eigenes LLM: nur wenn der Mandant es erlaubt; dann verwaltet die PL LLM und dessen Agenten, der Org-Admin nur (de)aktiviert', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const anna = await t.login('anna@demo.local');
  await t.api(admin).put('/ai/settings', { ownLlm: 'off' });
  const no = await t.api(pl).post(`/projects/${web()}/llms`, { name: 'Projekt-LLM', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'lokal' });
  assert.equal(no.statusCode, 403); assert.match(no.json().error, /nicht erlaubt/);
  await t.api(admin).put('/ai/settings', { ownLlm: 'all' });
  const llm = (await t.api(pl).post(`/projects/${web()}/llms`, { name: 'Projekt-LLM', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'lokal' })).json().llm;
  assert.equal((await t.api(pl).post(`/projects/${web()}/llms/${llm.id}/test`)).statusCode, 200);
  // PL legt am eigenen LLM einen Agenten an: gehört zum Projekt, ist dort gleich Mitglied; am Org-LLM darf sie es nicht
  const fremd = await t.api(pl).post('/agents', { name: 'Fremd', aiProfileId: profileId }); assert.equal(fremd.statusCode, 403, fremd.body);
  const own = await t.api(pl).post('/agents', { name: 'Eigen', aiProfileId: llm.id, rights: ['assist.ask', 'agent.run', 'agent.chat'] });
  assert.equal(own.statusCode, 200, own.body);
  const eigen = own.json().agent;
  assert.deepEqual([eigen.projectBound.id, eigen.canManage], [web(), true]);
  assert.ok(await t.db.maybeOne(`select 1 from project_members where project_id = $1 and user_id = $2`, [web(), eigen.id]));
  assert.equal((await aiAllowed(t.db, { userId: eigen.id, projectId: web(), feature: 'agent.run', budget: false })).allowed, true);
  // Nur in diesem Projekt; Mitglieder ohne PL-Rolle und der Org-Admin gestalten ihn nicht (die Stellvertretung schon)
  const erpJoin = await t.api(anna).put(`/projects/${erp()}/members/${eigen.id}`, { role: 'member' });
  assert.equal(erpJoin.statusCode, 403);
  assert.equal((await t.api(await t.login('max@demo.local')).patch(`/agents/${eigen.id}`, { name: 'X' })).statusCode, 403);
  assert.equal((await t.api(anna).patch(`/agents/${eigen.id}`, { persona: 'knapp' })).statusCode, 200, 'Stellvertretung ist PL');
  assert.equal((await t.api(admin).patch(`/agents/${eigen.id}`, { rights: [] })).statusCode, 403);
  assert.equal((await t.api(admin).patch(`/agents/${eigen.id}`, { active: false })).json().agent.active, false, 'deaktivieren darf die KI-Verwaltung immer');
  assert.equal((await t.api(pl).patch(`/agents/${eigen.id}`, { active: true, rights: ['assist.ask'] })).json().agent.rights.join(), 'assist.ask');
  // Erlaubt der Mandant eigene LLMs nicht mehr, verwaltet die PL sie nicht mehr und die Agenten laufen nicht
  await t.api(admin).put('/ai/settings', { ownLlm: 'personal' });
  assert.equal((await t.api(pl).patch(`/agents/${eigen.id}`, { name: 'Y' })).statusCode, 403);
  assert.equal((await aiAllowed(t.db, { userId: eigen.id, projectId: web(), feature: 'assist.ask', budget: false })).stage, 'profile');
  // LLM mit aktivem Agenten nicht löschbar
  await t.api(admin).put('/ai/settings', { ownLlm: 'all' });
  assert.equal((await t.api(pl).del(`/projects/${web()}/llms/${llm.id}`)).statusCode, 400);
  await t.api(pl).patch(`/agents/${eigen.id}`, { active: false });
  assert.equal((await t.api(pl).del(`/projects/${web()}/llms/${llm.id}`)).statusCode, 200);
  await t.api(admin).put('/ai/settings', { ownLlm: 'personal' });
});

test('Mail-KI: Rechte mail.triage und agent.mail am Agenten; abgeschaltet → Einrichten 403, Läufe übersprungen mit Begründung', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const view = `/mail/views/${t.ids.views.project}`;
  await t.api(admin).patch(`/agents/${morton.id}`, { rights: without('mail.triage') });
  const assign = await t.api(pl).patch(view, { agentUserId: morton.id });
  assert.equal(assign.statusCode, 403); assert.match(assign.json().error, /Zu Mails vorschlagen \(als Mitglied\): für Morton nicht freigegeben/);
  await t.api(admin).patch(`/agents/${morton.id}`, { rights: DEFAULT_AGENT_RIGHTS });
  assert.equal((await t.api(pl).patch(view, { aiProcess: true, agentUserId: morton.id })).statusCode, 200);
  // Die PL schaltet die Mail-Vorschläge im Projekt ab: Lauf übersprungen, ohne LLM-Aufruf
  await t.api(pl).put(`/projects/${web()}/members/${morton.id}/agent-policy`, { deny: ['mail.triage'] });
  const n = calls.length;
  t.mail.dev.inject(t.ids.accounts.project, { from: { address: 'kunde@extern.de', name: 'Kunde' }, to: ['projekt-web@demo.local'], subject: 'Frage zur Website', text: 'Wann geht es los?' } as any);
  await t.mail.syncAccount(t.ids.accounts.project);
  await flushAgentRuns();
  const run = await t.db.one(`select r.status, r.error from mail_ai_runs r join mails m on m.id = r.mail_id where m.subject = 'Frage zur Website'`);
  assert.equal(run.status, 'skipped'); assert.match(run.error, /in diesem Projekt abgeschaltet/);
  assert.equal(calls.length, n);
  await t.api(pl).put(`/projects/${web()}/members/${morton.id}/agent-policy`, null);
  assert.equal((await t.api(pl).patch(view, { aiProcess: false, agentUserId: null })).statusCode, 200);
});

test('Abschluss-Antwort mit KI: formuliert vom Agenten mit assist.final_reply; ohne KI weiter möglich', async () => {
  const pl = await t.login('pl@demo.local');
  const gf = (await t.api(pl).get(`/mail/views/${t.ids.views.project}/mails`)).json().mails.find((m: any) => m.fromAddr === 'gf@demo.local');
  const task = (await t.api(pl).post(`/mail/mails/${gf.id}/create-task`, { projectId: web(), title: 'Angebot beantworten' })).json().task.id;
  await t.api(pl).put(`/projects/${web()}/members/${morton.id}/agent-policy`, { deny: ['assist.final_reply'] });
  const blocked = await t.api(pl).get(`/tasks/${task}/final-reply?ai=1`);
  assert.equal(blocked.statusCode, 400); assert.match(blocked.json().error, /Kein Agent im Projekt darf „Abschluss-Antwort formulieren“/);
  assert.equal((await t.api(pl).get(`/tasks/${task}/final-reply`)).statusCode, 200, 'ohne KI');
  await t.api(pl).put(`/projects/${web()}/members/${morton.id}/agent-policy`, null);
  const ok = await t.api(pl).get(`/tasks/${task}/final-reply?ai=1`);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.match(ok.json().body, /Antwort der KI/);
  assert.ok(await t.db.maybeOne(`select 1 from agent_runs where agent_user_id = $1 and trigger = 'assist' and reasoning = 'Assistenz: final_reply'`, [morton.id]), 'zählt beim Agenten');
});

test('Migration 063: Rechte und Obergrenze an den Agenten, Sperren je Projekt als Einschränkung, LLM statt Standard, nichts wird geöffnet', async () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const db = await createDb();
  try {
    await db.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql') && x < '063').sort()) {
      await db.exec(readFileSync(path.join(dir, f), 'utf8'));
      await db.query(`insert into schema_migrations (name) values ($1)`, [f]);
    }
    const org = (await db.one(`insert into orgs (name) values ('Alt GmbH') returning id`)).id;
    const prof = (await db.one(`insert into ai_profiles (org_id, name, provider, base_url, model) values ($1,'Lokal','local','http://x/v1','m') returning id`, [org])).id;
    await db.query(`update orgs set settings = jsonb_build_object('ai', jsonb_build_object('defaultProfileId', $2::text, 'agentPolicy', '{"maxMode":"confirm_critical"}'::jsonb)) where id = $1`, [org, prof]);
    const pl = (await db.one(`insert into users (org_id, email, name, password_hash, global_role) values ($1,'pl@alt.local','Paula',' ','project_creator') returning id`, [org])).id;
    const p = (await db.one(`insert into projects (org_id, key, name, created_by) values ($1,'ALT','Alt',$2) returning id`, [org, pl])).id;
    const a = (await db.one(`insert into users (org_id, email, name, password_hash, kind) values ($1,'a@agent.local','Anton',' ','agent') returning id`, [org])).id;
    const b = (await db.one(`insert into users (org_id, email, name, password_hash, kind) values ($1,'b@agent.local','Berta',' ','agent') returning id`, [org])).id;
    await db.query(`insert into project_members (project_id, user_id, role, can_use_ai) values ($1,$2,'member',true), ($1,$3,'member',true)`, [p, a, b]);
    // Mandant sperrt Mails nach außen; Anton darf recherchieren; Berta ist im Projekt für die Mail-KI gesperrt
    await db.query(`insert into ai_policies (org_id, feature, effect) values ($1,'agent.send_external','deny')`, [org]);
    await db.query(`insert into ai_policies (org_id, user_id, feature, effect) values ($1,$2,'agent.web','allow')`, [org, a]);
    await db.query(`insert into ai_policies (org_id, project_id, user_id, feature, effect) values ($1,$2,$3,'mail','deny')`, [org, p, b]);
    assert.deepEqual(await runMigrations(db), readdirSync(dir).filter((x) => x.endsWith('.sql') && x >= '063').sort());
    const rows = (await db.query(`select name, ai_profile_id, agent_rights, agent_policy from users where kind = 'agent' order by name`)).rows;
    const anton = rows[0]; const berta = rows[1];
    assert.deepEqual([anton.ai_profile_id, berta.ai_profile_id], [prof, prof], 'Standard-LLM wird das LLM des Agenten');
    assert.ok(anton.agent_rights.includes('agent.web') && !anton.agent_rights.includes('agent.send_external'));
    assert.ok(!berta.agent_rights.includes('agent.web') && !berta.agent_rights.includes('agent.send_external') && berta.agent_rights.includes('agent.run'));
    assert.equal(anton.agent_policy.maxMode, 'confirm_critical', 'Policy des Mandanten wird Obergrenze am Agenten');
    const deny = (await db.one(`select agent_policy from project_members where project_id = $1 and user_id = $2`, [p, b])).agent_policy.deny.sort();
    assert.deepEqual(deny, ['agent.mail', 'mail.triage']);
  } finally {
    await db.close();
  }
});

test('Einziger Weg zur KI: aiConfigForAgent und profileConfig nur in client.ts und policy.ts; complete() nur mit Konfiguration aus aiConfigFor bzw. assistAgent', () => {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []; });
  const files = walk(src).map((f) => ({ rel: path.relative(src, f).split(path.sep).join('/'), text: readFileSync(f, 'utf8') }));
  const internal = files.filter((f) => /\baiConfigFor(Agent|Profile)\s*\(/.test(f.text)).map((f) => f.rel).sort();
  assert.deepEqual(internal, ['ai/client.ts', 'ai/policy.ts']);
  assert.deepEqual(files.filter((f) => /\bprofileConfig\s*\(/.test(f.text)).map((f) => f.rel).sort(), ['ai/client.ts']);
  for (const f of files.filter((x) => x.rel !== 'ai/client.ts')) {
    assert.ok(!/\bas AiConfig\b|<AiConfig>|:\s*AiConfig\s*=\s*\{|\bcomplete\(\s*\{/.test(f.text), `${f.rel} baut eine KI-Konfiguration selbst`);
  }
  const via = (x: { text: string }) => x.text.includes('aiConfigFor(') || x.text.includes('assistAgent(');
  for (const f of files.filter((x) => /\bcomplete\(\s*(cfg|c)\b/.test(x.text) && x.rel !== 'ai/client.ts')) assert.ok(via(f) || /\bcfg: AiConfig\b/.test(f.text), `${f.rel} holt die KI-Konfiguration nicht über aiConfigFor`);
  const viaParam = files.filter((x) => /\bcfg: AiConfig\b/.test(x.text) && /\bcomplete\(/.test(x.text) && !via(x)).map((f) => f.rel).sort();
  assert.deepEqual(viaParam, ['ai/service.ts', 'mail/origin.ts', 'outbound.ts']);
  for (const fn of ['summarizeMail', 'essenceForTask', 'essenceForPage', 'statusReportDraft', 'askProject', 'aiFinalReply', 'guardOutbound']) {
    for (const f of files.filter((x) => new RegExp(`await ${fn}\\(db`).test(x.text))) assert.ok(via(f), `${f.rel} ruft ${fn} ohne aiConfigFor`);
  }
});
