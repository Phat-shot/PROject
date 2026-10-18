import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testApp } from './helpers.js';
import { createDb, runMigrations } from '../src/db.js';
import { agentBudgetLeft, runAgents } from '../src/ai/agent.js';
import { aiAllowed, NO_AI_RIGHT } from '../src/ai/policy.js';
import { flushAgentRuns, queueAgentRun } from '../src/ai/agentEvents.js';

/** Lokales LLM: Agentenlauf (note/actions), Chat (reply/notes), Mail-KI (summary/actions), sonst Text; jede Anfrage wird gezählt. */
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
const rule = async (cookies: Record<string, string>, r: Record<string, unknown>) => {
  const res = await t.api(cookies).put('/ai/policies', { projectId: null, userId: null, groupId: null, note: null, ...r });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
};
const clearRules = () => t.db.query(`delete from ai_policies`);
const policyOk = (d: any) => d.trace.find((s: any) => s.stage === 'policy')?.ok === true;

test('Einrichtung: Profil, Projekt-KI, Agent Morton mit Arbeitspaket', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  profileId = (await t.api(admin).post('/ai/profiles', { name: 'Lokal', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'lokal' })).json().profile.id;
  await t.api(admin).put('/ai/settings', { defaultProfileId: profileId, agentDailyBudget: 50 });
  assert.equal((await t.api(pl).patch(`/projects/${web()}`, { aiProfileId: profileId })).statusCode, 200);
  morton = (await t.api(admin).post('/agents', { name: 'Morton' })).json().agent;
  await t.api(pl).put(`/projects/${web()}/members/${morton.id}`, { role: 'member' });
  mortonTask = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Freigaben prüfen', responsibleUserId: morton.id })).json().task.id;
  await flushAgentRuns();
  assert.ok(await t.db.maybeOne(`select 1 from agent_runs where task_id = $1 and status = 'ok'`, [mortonTask]), 'ohne Regel läuft der Agent');
});

test('Regel K: Beispiele aus dem Konzept (Sperre gewinnt, Ausnahme nur „Person in Projekt“, Gruppen, Agenten)', async () => {
  const admin = await t.login('admin@demo.local');
  const max = t.ids.users.max;
  const ask = (projectId: string, userId = max, feature: any = 'assist.ask') => aiAllowed(t.db, { userId, projectId, feature, budget: false });
  // Org „*“ gesperrt, Projekt WEB „*“ erlaubt: KI nur in WEB
  await rule(admin, { feature: '*', effect: 'deny', note: 'Pilotphase' });
  await rule(admin, { projectId: web(), feature: '*', effect: 'allow' });
  assert.equal((await ask(web())).allowed, true);
  const inErp = await ask(erp());
  assert.equal(inErp.stage, 'policy');
  assert.match(inErp.reason, /^Gesperrt durch Org-Admin \(Alex Admin\) für den Mandanten: Pilotphase$/);
  // Org gesperrt, Person Max „assist“ erlaubt: Max überall (soweit die PL es zulässt; in ERP fehlt die Projekt-KI)
  await rule(admin, { userId: max, feature: 'assist', effect: 'allow' });
  const erp2 = await ask(erp());
  assert.ok(policyOk(erp2), 'Regeln lassen Max zu');
  assert.equal(erp2.stage, 'profile');
  await clearRules();
  // Projekt WEB gesperrt, Max erlaubt: in WEB gesperrt; Ausnahme nur über „Max in WEB“
  await rule(admin, { projectId: web(), feature: '*', effect: 'deny', note: 'Datenschutz Bauherr' });
  await rule(admin, { userId: max, feature: '*', effect: 'allow' });
  const blocked = await ask(web());
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /Gesperrt durch Org-Admin \(Alex Admin\) für Projekt WEB Website-Relaunch: Datenschutz Bauherr/);
  await rule(admin, { projectId: web(), userId: max, feature: 'assist.ask', effect: 'allow', note: 'Ausnahme' });
  assert.equal((await ask(web())).allowed, true, 'Ausnahme Person in Projekt');
  assert.equal((await ask(web(), max, 'assist.report')).allowed, false, 'Ausnahme gilt nur für die genannte Funktion');
  // Die PL schränkt weiter ein: eine Ausnahme hilft weder Lesern über „Frage ans Projekt“ hinaus noch ohne „KI nutzen“
  await rule(admin, { projectId: web(), userId: t.ids.users.leser, feature: '*', effect: 'allow', note: 'Ausnahme' });
  const reader = await ask(web(), t.ids.users.leser, 'assist.report');
  assert.ok(policyOk(reader), 'Regeln lassen die Leserin zu');
  assert.deepEqual([reader.allowed, reader.stage], [false, 'project']);
  assert.match(reader.reason, /Leser stellen nur Fragen/);
  await t.db.query(`update project_members set can_use_ai = false where project_id = $1 and user_id = $2`, [web(), max]);
  const noRight = await ask(web());
  assert.deepEqual([noRight.allowed, noRight.stage, noRight.reason], [false, 'project', NO_AI_RIGHT], 'Ausnahme ersetzt „KI nutzen“ nicht');
  await t.db.query(`update project_members set can_use_ai = true where project_id = $1 and user_id = $2`, [web(), max]);
  // Ausnahme für einen Agenten in einem Projekt: übersteuert die Projektsperre nur dort, wo sie steht
  assert.equal((await aiAllowed(t.db, { userId: morton.id, projectId: web(), feature: 'agent.run', budget: false })).stage, 'policy');
  await rule(admin, { projectId: web(), userId: morton.id, feature: 'agent.run', effect: 'allow' });
  assert.equal((await aiAllowed(t.db, { userId: morton.id, projectId: web(), feature: 'agent.run', budget: false })).allowed, true, 'Morton in WEB');
  assert.equal((await aiAllowed(t.db, { userId: morton.id, projectId: web(), feature: 'agent.chat', budget: false })).allowed, false, 'nur die genannte Funktion');
  await clearRules();
  // Morton nur in ERP gesperrt: in WEB unberührt
  await rule(admin, { projectId: erp(), userId: morton.id, feature: 'agent', effect: 'deny' });
  assert.equal((await aiAllowed(t.db, { userId: morton.id, projectId: erp(), feature: 'agent.run', budget: false })).stage, 'policy');
  assert.equal((await aiAllowed(t.db, { userId: morton.id, projectId: web(), feature: 'agent.run', budget: false })).allowed, true);
  await clearRules();
  // Person und Projekt erlaubt: erlaubt, die Begründung nennt beide
  await rule(admin, { projectId: web(), feature: '*', effect: 'allow' });
  await rule(admin, { userId: max, feature: 'assist', effect: 'allow' });
  const both = await ask(web());
  assert.equal(both.allowed, true);
  assert.match(both.reason, /für Max Keller, KI-Assistenz; Erlaubt durch Org-Admin \(Alex Admin\) für Projekt WEB/);
  await clearRules();
  // WEB erlaubt, Max gesperrt: Max auch in WEB gesperrt
  await rule(admin, { projectId: web(), feature: '*', effect: 'allow' });
  await rule(admin, { userId: max, feature: 'assist', effect: 'deny', note: 'Abmahnung' });
  const personal = await ask(web());
  assert.equal(personal.allowed, false);
  // Für geteilte Orte (Projektkanal, Lauflisten) ohne Namen und Notiz
  assert.match(personal.reason, /für Max Keller, KI-Assistenz: Abmahnung/);
  assert.equal(personal.publicReason, 'Gesperrt durch eine KI-Freigabe für diese Person, KI-Assistenz');
  await clearRules();
  // Gruppe Externe gesperrt, Gruppe Elektro erlaubt: Gleichstand → gesperrt
  const g1 = (await t.api(admin).post('/groups', { name: 'Externe', memberIds: [max] })).json().group.id;
  const g2 = (await t.api(admin).post('/groups', { name: 'Elektro', memberIds: [max] })).json().group.id;
  await rule(admin, { groupId: g1, feature: 'assist', effect: 'deny' });
  await rule(admin, { groupId: g2, feature: 'assist', effect: 'allow' });
  const tie = await ask(web());
  assert.equal(tie.allowed, false);
  assert.match(tie.reason, /Gruppe Externe/);
  await clearRules();
  // Ausnahme über eine Gruppe in einem Projekt übersteuert die Projektsperre; mehrere Gruppen in p: Sperre gewinnt
  await rule(admin, { projectId: web(), feature: '*', effect: 'deny' });
  await rule(admin, { projectId: web(), groupId: g2, feature: 'assist', effect: 'allow' });
  const viaGroup = await ask(web());
  assert.equal(viaGroup.allowed, true);
  assert.match(viaGroup.reason, /Gruppe Elektro in Projekt WEB/);
  assert.equal((await ask(erp())).stage, 'profile', 'die Ausnahme gilt nur in WEB, in ERP greifen die Regeln nicht ein');
  await rule(admin, { projectId: web(), groupId: g1, feature: 'assist', effect: 'deny' });
  const groupTie = await ask(web());
  assert.equal(groupTie.allowed, false);
  assert.match(groupTie.reason, /Gruppe Externe in Projekt WEB/);
  assert.equal(groupTie.publicReason, 'Gesperrt durch eine KI-Freigabe für eine Gruppe dieser Person in diesem Projekt, KI-Assistenz');
  await clearRules();
  // Innerhalb einer Zelle: Funktion vor Kategorie
  await rule(admin, { feature: 'agent', effect: 'deny' });
  await rule(admin, { feature: 'agent.chat', effect: 'allow' });
  assert.equal((await aiAllowed(t.db, { userId: morton.id, projectId: web(), feature: 'agent.chat', budget: false })).allowed, true);
  assert.equal((await aiAllowed(t.db, { userId: morton.id, projectId: web(), feature: 'agent.run', budget: false })).allowed, false);
  await clearRules();
  // Projekt WEB „agent“ gesperrt: auch Agenten der Org laufen in WEB nicht
  await rule(admin, { projectId: web(), feature: 'agent', effect: 'deny' });
  assert.equal((await aiAllowed(t.db, { userId: morton.id, projectId: web(), feature: 'agent.run' })).stage, 'policy');
  await clearRules();
  // Einzelner Agent gesperrt: andere Agenten bleiben unberührt
  const lotte = (await t.api(admin).post('/agents', { name: 'Lotte' })).json().agent;
  await t.api(await t.login('pl@demo.local')).put(`/projects/${web()}/members/${lotte.id}`, { role: 'member' });
  await rule(admin, { userId: morton.id, feature: 'agent.chat', effect: 'deny' });
  assert.equal((await aiAllowed(t.db, { userId: morton.id, projectId: web(), feature: 'agent.chat' })).allowed, false);
  assert.equal((await aiAllowed(t.db, { userId: lotte.id, projectId: web(), feature: 'agent.chat' })).allowed, true);
  await clearRules();
  // Unbekannte und noch nicht geprüfte Funktionen nimmt die Verwaltung nicht an
  assert.equal((await t.api(admin).put('/ai/policies', { feature: 'assist.zaubern', effect: 'deny' })).statusCode, 400);
  assert.equal((await t.api(admin).put('/ai/policies', { feature: 'agent.web', effect: 'allow' })).statusCode, 400);
  assert.equal((await t.api(admin).put('/ai/policies', { feature: 'assist', effect: 'deny', userId: max, groupId: g1 })).statusCode, 400);
  // Regeländerungen stehen im Audit
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'ai.policy.set' and details->>'feature' = 'agent.chat'`));
  await rule(admin, { userId: morton.id, feature: 'agent.chat', effect: 'deny' });
  await rule(admin, { userId: morton.id, feature: 'agent.chat', effect: null });
  assert.equal((await t.db.one(`select count(*)::int as c from ai_policies`)).c, 0, 'erben = Regel entfernt');
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'ai.policy.delete'`));
});

test('Notaus: sperrt alles, auch Ausnahmen und Verbindungstests; Läufe übersprungen ohne LLM-Aufruf', async () => {
  const admin = await t.login('admin@demo.local');
  const max = await t.login('max@demo.local');
  const pl = await t.login('pl@demo.local');
  await rule(admin, { projectId: web(), userId: t.ids.users.max, feature: '*', effect: 'allow', note: 'Ausnahme' });
  const st = (await t.api(admin).put('/ai/settings', { enabled: false })).json();
  assert.equal(st.killswitch, true);
  assert.equal(st.enabled, false);
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'ai.killswitch' and details->>'enabled' = 'false'`));
  const d = await aiAllowed(t.db, { userId: t.ids.users.max, projectId: web(), feature: 'assist.ask' });
  assert.deepEqual([d.allowed, d.stage, d.reason], [false, 'killswitch', 'KI im Mandanten abgeschaltet (Notaus)']);
  const r = await t.api(max).post(`/projects/${web()}/ai/ask`, { question: 'Was blockiert?' });
  assert.equal(r.statusCode, 403);
  assert.match(r.json().error, /Notaus/);
  assert.equal((await t.api(admin).post(`/ai/profiles/${profileId}/test`)).statusCode, 403);
  const before = calls.length;
  const budget = await agentBudgetLeft(t.db, { id: morton.id, org_id: t.ids.org });
  await t.api(pl).post(`/tasks/${mortonTask}/comments`, { body: 'Bitte prüfen.' });
  await flushAgentRuns();
  const skipped = await t.db.one(`select * from agent_runs where task_id = $1 order by created_at desc limit 1`, [mortonTask]);
  assert.deepEqual([skipped.status, skipped.error], ['skipped', 'KI im Mandanten abgeschaltet (Notaus)']);
  assert.equal(calls.length, before, 'kein LLM-Aufruf');
  assert.equal(await agentBudgetLeft(t.db, { id: morton.id, org_id: t.ids.org }), budget, 'nicht budgetwirksam');
  const manual = await t.api(pl).post(`/tasks/${mortonTask}/agent-run`);
  assert.equal(manual.statusCode, 403);
  assert.match(manual.json().error, /Notaus/);
  assert.equal((await t.api(pl).get(`/projects/${web()}/ai/capabilities`)).json().killswitch, true);
  assert.equal((await t.api(admin).put('/ai/settings', { enabled: true })).json().killswitch, false);
  await clearRules();
});

test('Org-Recht ai_admin: Verwaltung › KI ohne Org-Admin; nur der Org-Admin vergibt Org-Rechte', async () => {
  const admin = await t.login('admin@demo.local');
  const anna = await t.login('anna@demo.local');
  assert.equal((await t.api(anna).get('/ai/policies')).statusCode, 403);
  assert.equal((await t.api(anna).put('/ai/settings', { assistDailyBudget: 150 })).statusCode, 403);
  assert.equal((await t.api(anna).patch(`/users/${t.ids.users.anna}`, { orgRights: ['ai_admin'] })).statusCode, 403, 'nur Org-Admin');
  assert.equal((await t.api(admin).patch(`/users/${t.ids.users.anna}`, { orgRights: ['root'] })).statusCode, 400);
  assert.equal((await t.api(admin).patch(`/users/${morton.id}`, { orgRights: ['ai_admin'] })).statusCode, 400, 'Agenten nie');
  assert.equal((await t.api(admin).patch(`/users/${t.ids.users.anna}`, { globalRole: 'org_admin' })).statusCode, 400);
  const u = await t.api(admin).patch(`/users/${t.ids.users.anna}`, { orgRights: ['ai_admin'] });
  assert.equal(u.statusCode, 200, u.body);
  assert.deepEqual(u.json().user.orgRights, ['ai_admin']);
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'user.role' and object_id = $1`, [t.ids.users.anna]));
  assert.deepEqual((await t.api(anna).get('/auth/me')).json().user.orgRights, ['ai_admin']);
  assert.equal((await t.api(anna).get('/ai/policies')).statusCode, 200);
  assert.equal((await t.api(anna).put('/ai/settings', { assistDailyBudget: 150 })).json().assistDailyBudget, 150);
  const p = await t.api(anna).post('/ai/profiles', { name: 'Zweites', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'lokal' });
  assert.equal(p.statusCode, 200, p.body);
  assert.equal((await t.api(anna).post('/agents', { name: 'Hilfe' })).statusCode, 200);
  await rule(anna, { userId: t.ids.users.leser, feature: 'assist', effect: 'deny', note: 'Test' });
  assert.match((await aiAllowed(t.db, { userId: t.ids.users.leser, projectId: web(), feature: 'assist.ask' })).reason, /Gesperrt durch KI-Verwaltung \(Anna Berger\) für Lea Reuter/);
  // Keine Benutzer- oder Auditverwaltung
  assert.equal((await t.api(anna).get('/audit')).statusCode, 403);
  assert.equal((await t.api(anna).post('/users', { email: 'x@demo.local', name: 'X', password: 'geheim12345' })).statusCode, 403);
  await t.api(admin).del(`/ai/profiles/${p.json().profile.id}`);
  await clearRules();
});

test('Vorschau „Wirkung für Person X in Projekt Y“ mit Spur; Fähigkeiten mit Begründung', async () => {
  const admin = await t.login('admin@demo.local');
  const max = await t.login('max@demo.local');
  const leser = await t.login('leser@demo.local');
  await rule(admin, { projectId: web(), feature: 'assist.report', effect: 'deny', note: 'Berichte nur von Hand' });
  const eff = (await t.api(admin).get(`/ai/policies/effective?userId=${t.ids.users.max}&projectId=${web()}`)).json();
  assert.equal(eff.subject.kind, 'person');
  const f = (k: string) => eff.features.find((x: any) => x.feature === k);
  assert.equal(f('assist.report').decision.allowed, false);
  assert.match(f('assist.report').decision.reason, /Gesperrt durch Org-Admin \(Alex Admin\) für Projekt WEB Website-Relaunch, Statusbericht-Entwurf: Berichte nur von Hand/);
  assert.deepEqual(f('assist.ask').decision.trace.map((s: any) => [s.stage, s.ok]), [['killswitch', true], ['policy', true], ['project', true], ['profile', true], ['budget', true]]);
  assert.ok(!eff.features.some((x: any) => x.feature === 'agent.run'), 'Agentenfunktionen nur für Agenten');
  assert.ok(!eff.features.some((x: any) => x.feature === 'agent.web'), 'noch nicht geprüfte Funktionen fehlen');
  const effAgent = (await t.api(admin).get(`/ai/policies/effective?userId=${morton.id}&projectId=${web()}`)).json();
  assert.deepEqual(effAgent.features.map((x: any) => x.feature).sort(), ['agent.chat', 'agent.run', 'mail.triage']);
  assert.equal((await t.api(max).get(`/ai/policies/effective?userId=${t.ids.users.max}`)).statusCode, 403);
  // Ziele für die Matrix: persönliche Projekte nur als „persönlich (Eigentümer)“
  const targets = (await t.api(admin).get('/ai/policy-targets')).json();
  assert.ok(targets.projects.some((p: any) => p.label === 'WEB Website-Relaunch'));
  assert.ok(targets.agents.some((a: any) => a.id === morton.id));
  assert.ok(!targets.users.some((u: any) => u.id === morton.id));
  // Fähigkeiten: Knöpfe zeigen die Begründung
  const caps = (await t.api(max).get(`/projects/${web()}/ai/capabilities`)).json();
  assert.equal(caps.features['assist.ask'].allowed, true);
  assert.equal(caps.features['assist.report'].allowed, false);
  assert.match(caps.features['assist.report'].reason, /Berichte nur von Hand/);
  assert.equal(caps.features['pl.agents'].allowed, false);
  assert.ok(caps.agents.some((a: any) => a.id === morton.id && a.run.allowed));
  const report = await t.api(max).post(`/projects/${web()}/ai/status-report`);
  assert.equal(report.statusCode, 403);
  assert.match(report.json().error, /Berichte nur von Hand/);
  const lc = (await t.api(leser).get(`/projects/${web()}/ai/capabilities`)).json();
  assert.match(lc.features['assist.summarize'].reason, /Leser stellen nur Fragen/);
  assert.match(lc.features['assist.ask'].reason, /KI nutzen/);
  await clearRules();
});

test('Gesperrte Agentenläufe: übersprungen mit Begründung, höchstens einmal je Arbeitspaket und Tag, nicht budgetwirksam', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  await rule(admin, { projectId: web(), userId: morton.id, feature: 'agent.run', effect: 'deny', note: 'Pause wegen Prüfung' });
  await t.db.query(`delete from agent_runs where task_id = $1 and status = 'skipped'`, [mortonTask]);
  const before = calls.length;
  const budget = await agentBudgetLeft(t.db, { id: morton.id, org_id: t.ids.org });
  await t.api(pl).post(`/tasks/${mortonTask}/comments`, { body: 'Neuer Stand.' });
  await flushAgentRuns();
  queueAgentRun(mortonTask, 'comment');
  await flushAgentRuns();
  // Fälliges Nachfassen und Wiedervorlage: der gesperrte Worker verbraucht sie nicht
  const past = new Date(Date.now() - 3600_000).toISOString();
  await t.db.query(`update tasks set agent_wait = $2, agent_next_check_at = $3 where id = $1`, [mortonTask, JSON.stringify({ kind: 'reply', reason: 'Antwort des Kunden', since: past, remindAt: past, reminded: false }), past]);
  const runs = await runAgents(t.db, t.mail, fakeFetch, new Date(Date.now() + 3600_000));
  assert.ok(runs.some((r) => r.taskId === mortonTask && r.status === 'skipped' && /Pause wegen Prüfung/.test(r.error ?? '')));
  const kept = await t.db.one(`select agent_wait, agent_next_check_at from tasks where id = $1`, [mortonTask]);
  assert.equal(kept.agent_wait.reminded, false, 'Nachfassen bleibt fällig');
  assert.ok(kept.agent_next_check_at, 'Wiedervorlage bleibt');
  const skipped = await t.db.query(`select error from agent_runs where task_id = $1 and status = 'skipped'`, [mortonTask]);
  assert.equal(skipped.rows.length, 1, 'einmal je Arbeitspaket und Tag');
  assert.match(skipped.rows[0].error, /Gesperrt durch Org-Admin \(Alex Admin\) für Morton in Projekt WEB Website-Relaunch, Agentenläufe: Pause wegen Prüfung/);
  assert.equal(calls.length, before, 'kein LLM-Aufruf');
  assert.equal(await agentBudgetLeft(t.db, { id: morton.id, org_id: t.ids.org }), budget);
  const listed = (await t.api(pl).get(`/projects/${web()}/agent-runs?taskId=${mortonTask}`)).json().runs;
  assert.equal(listed[0].status, 'skipped');
  const manual = await t.api(pl).post(`/tasks/${mortonTask}/agent-run`);
  assert.equal(manual.statusCode, 403);
  assert.match(manual.json().error, /Pause wegen Prüfung/);
  // Regel weg: der nächste Takt läuft wieder (der übersprungene Eintrag zählt nicht als letzter Lauf)
  await clearRules();
  const again = await runAgents(t.db, t.mail, fakeFetch, new Date(Date.now() + 2 * 3600_000));
  assert.ok(again.some((r) => r.taskId === mortonTask && r.status === 'ok'));
  assert.ok(calls.length > before);
  assert.equal((await t.db.one(`select trigger from agent_runs where task_id = $1 and status = 'ok' order by created_at desc limit 1`, [mortonTask])).trigger, 'reminder_due', 'nach der Sperre wird nachgefasst');
  await t.db.query(`update tasks set agent_wait = null, agent_next_check_at = null where id = $1`, [mortonTask]);
});

test('Chat: Absender und Agent werden geprüft; in Direktnachrichten nur Projekte mit „KI nutzen“ und Freigabe', async () => {
  const admin = await t.login('admin@demo.local');
  const max = await t.login('max@demo.local');
  const anna = await t.login('anna@demo.local');
  // Morton bekommt auch ein Arbeitspaket in ERP (PL Anna)
  await t.api(anna).put(`/projects/${erp()}/members/${morton.id}`, { role: 'member' });
  const erpTask = (await t.api(anna).post(`/projects/${erp()}/tasks`, { title: 'Schnittstellen sichten', responsibleUserId: morton.id })).json().task.id;
  assert.ok(erpTask);
  await flushAgentRuns();
  const cid = (await t.api(max).post('/chat/dm', { userId: morton.id })).json().channelId;
  const say = async (body: string) => { const n = calls.length; await t.api(max).post(`/chat/channels/${cid}/messages`, { body }); await flushAgentRuns(); return calls.slice(n).find((c) => (c.response_format?.json_schema?.schema?.required ?? []).includes('reply')); };
  const p1 = await say('Was steht an?');
  assert.ok(p1.messages[1].content.includes('Freigaben prüfen') && p1.messages[1].content.includes('Schnittstellen sichten'), 'beide Projekte');
  await rule(admin, { projectId: erp(), feature: 'agent.chat', effect: 'deny' });
  const p2 = await say('Und jetzt?');
  assert.ok(p2.messages[1].content.includes('Freigaben prüfen'));
  assert.ok(!p2.messages[1].content.includes('Schnittstellen sichten'), 'ERP gesperrt: keine Auskunft daraus');
  await clearRules();
  await t.db.query(`update project_members set can_use_ai = false where project_id = $1 and user_id = $2`, [erp(), t.ids.users.max]);
  const p3 = await say('Noch einmal?');
  assert.ok(!p3.messages[1].content.includes('Schnittstellen sichten'), 'ohne „KI nutzen“ in ERP keine Auskunft daraus');
  await t.db.query(`update project_members set can_use_ai = true where project_id = $1 and user_id = $2`, [erp(), t.ids.users.max]);
  const lastChatRun = () => t.db.one(`select status, error, channel_id from agent_runs where agent_user_id = $1 and trigger = 'chat' order by created_at desc limit 1`, [morton.id]);
  // Agent gesperrt (Regel für Morton): Begründung im Chat, übersprungener Lauf, kein LLM-Aufruf
  await rule(admin, { userId: morton.id, feature: 'agent.chat', effect: 'deny', note: 'Chat aus' });
  assert.equal(await say('Bist du da?'), undefined);
  assert.match((await t.api(max).get(`/chat/channels/${cid}/messages`)).json().messages.at(-1).body, /^Ich bin hier gesperrt: Gesperrt durch Org-Admin \(Alex Admin\) für Morton, Chat mit Agenten: Chat aus$/);
  assert.deepEqual([(await lastChatRun()).status, (await lastChatRun()).channel_id], ['skipped', cid]);
  await clearRules();
  // Morton nur in ERP für den Chat gesperrt, Absender frei: keine Auskunft aus ERP
  await rule(admin, { projectId: erp(), userId: morton.id, feature: 'agent.chat', effect: 'deny' });
  const p4 = await say('Und in ERP?');
  assert.ok(p4.messages[1].content.includes('Freigaben prüfen'));
  assert.ok(!p4.messages[1].content.includes('Schnittstellen sichten'), 'Morton in ERP gesperrt: keine Auskunft daraus');
  await clearRules();
  // Sperre der Läufe betrifft den Chat nicht
  await rule(admin, { userId: morton.id, feature: 'agent.run', effect: 'deny' });
  assert.ok(await say('Läufst du?'), 'Chat trotz gesperrter Läufe');
  await clearRules();
  // Absender gesperrt: Begründung im Chat (Direktnachricht: voll), übersprungener Lauf ohne Namen und Notiz, kein LLM-Aufruf
  await rule(admin, { userId: t.ids.users.max, feature: 'agent.chat', effect: 'deny', note: 'nur Mail' });
  assert.equal(await say('Hallo?'), undefined);
  const msgs = (await t.api(max).get(`/chat/channels/${cid}/messages`)).json().messages;
  assert.match(msgs.at(-1).body, /Ich kann dir hier nicht antworten: Gesperrt durch Org-Admin \(Alex Admin\) für Max Keller, Chat mit Agenten: nur Mail/);
  const run = await lastChatRun();
  assert.deepEqual([run.status, run.channel_id, run.error], ['skipped', cid, 'Absender: Gesperrt durch eine KI-Freigabe für diese Person, Chat mit Agenten']);
  await clearRules();
  // Projektkanal: Mitglied ohne „KI nutzen“ bekommt die Begründung statt einer Antwort
  await t.db.query(`update project_members set can_use_ai = false where project_id = $1 and user_id = $2`, [web(), t.ids.users.max]);
  const ch = (await t.api(max).get(`/projects/${web()}/chat`)).json().channel.id;
  const n = calls.length;
  const m = (await t.api(max).post(`/chat/channels/${ch}/messages`, { body: '@Morton wie ist der Stand?' })).json().message;
  await flushAgentRuns();
  assert.equal(calls.length, n);
  const thread = (await t.api(max).get(`/chat/channels/${ch}/messages?thread=${m.id}`)).json().messages;
  assert.match(thread[0].body, /Kein KI-Recht in diesem Projekt/);
  // Folgenachrichten im Thread ohne Erwähnung: keine weitere Ablehnung, kein Laufeintrag, keine Meldung
  const runsBefore = (await t.db.one(`select count(*)::int as c from agent_runs where agent_user_id = $1 and trigger = 'chat'`, [morton.id])).c;
  const notesBefore = (await t.db.one(`select count(*)::int as c from notifications where user_id = $1`, [t.ids.users.max])).c;
  await t.api(max).post(`/chat/channels/${ch}/messages`, { body: 'Ich kümmere mich drum', threadId: m.id });
  await t.api(max).post(`/chat/channels/${ch}/messages`, { body: 'Erledigt bis Freitag', threadId: m.id });
  await flushAgentRuns();
  const after = (await t.api(max).get(`/chat/channels/${ch}/messages?thread=${m.id}`)).json().messages;
  assert.equal(after.filter((x: any) => x.userId === morton.id).length, 1, 'nur die erste Ablehnung');
  assert.equal((await t.db.one(`select count(*)::int as c from agent_runs where agent_user_id = $1 and trigger = 'chat'`, [morton.id])).c, runsBefore);
  assert.equal((await t.db.one(`select count(*)::int as c from notifications where user_id = $1`, [t.ids.users.max])).c, notesBefore);
  await t.db.query(`update project_members set can_use_ai = true where project_id = $1 and user_id = $2`, [web(), t.ids.users.max]);
  // Persönliche Regel mit Notiz: im Projektkanal und in den Läufen ohne Namen und Notiz, die volle Begründung nur als Meldung an den Absender
  await rule(admin, { userId: t.ids.users.max, feature: '*', effect: 'deny', note: 'Abmahnung Datenschutz 10/2026' });
  const m2 = (await t.api(max).post(`/chat/channels/${ch}/messages`, { body: '@Morton wie ist der Stand?' })).json().message;
  await flushAgentRuns();
  const reply = (await t.api(max).get(`/chat/channels/${ch}/messages?thread=${m2.id}`)).json().messages.find((x: any) => x.userId === morton.id);
  assert.equal(reply.body, 'Ich kann dir hier nicht antworten: Gesperrt durch eine KI-Freigabe für diese Person');
  assert.doesNotMatch((await lastChatRun()).error, /Max Keller|Abmahnung/);
  const listed = (await t.api(await t.login('pl@demo.local')).get(`/projects/${web()}/agent-runs`)).json().runs;
  assert.ok(!listed.some((r: any) => /Abmahnung/.test(r.error ?? '')), 'Läufe zeigen die Notiz nicht');
  const note = await t.db.one(`select body from notifications where user_id = $1 and type = 'chat.reply' order by created_at desc limit 1`, [t.ids.users.max]);
  assert.match(note.body, /für Max Keller: Abmahnung Datenschutz 10\/2026/);
  await clearRules();
});

test('Eigene Agenten der PL: Regel pl.agents (Standard gesperrt), Prüfung auch im Lauf, Verwaltung zeigt gestoppte Agenten mit „erlauben“', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const before = (await t.api(pl).get(`/projects/${web()}/agents`)).json();
  assert.equal(before.canManage, false);
  assert.match(before.manageReason, /Standard: gesperrt/);
  assert.equal((await t.api(pl).post(`/projects/${web()}/agents`, { name: 'Assi', aiProfileId: profileId })).statusCode, 403);
  // Der frühere Schalter schreibt die Regel für den Mandanten
  assert.equal((await t.api(admin).put('/ai/settings', { plAgents: { enabled: true, maxBudget: 10 } })).json().plAgents.enabled, true);
  assert.ok((await t.api(admin).get('/ai/policies')).json().rules.some((r: any) => r.feature === 'pl.agents' && r.effect === 'allow' && !r.projectId && !r.userId));
  const a = (await t.api(pl).post(`/projects/${web()}/agents`, { name: 'Assi', aiProfileId: profileId, dailyBudget: 5 })).json().agent;
  const task = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Assi-Aufgabe', responsibleUserId: a.id })).json().task.id;
  await flushAgentRuns();
  assert.ok(await t.db.maybeOne(`select 1 from agent_runs where task_id = $1 and status = 'ok'`, [task]));
  // Persönliche Regel für die PL: ihr Agent stoppt; Mitglieder sehen die Begründung ohne Namen und Notiz, die Verwaltung voll
  await rule(admin, { userId: t.ids.users.pl, feature: 'pl.agents', effect: 'deny', note: 'Abmahnung Datenschutz' });
  const full = await aiAllowed(t.db, { userId: a.id, projectId: web(), feature: 'agent.run' });
  assert.match(full.reason, /^Eigener Agent der PL: Gesperrt durch Org-Admin \(Alex Admin\) für Petra Lenz, Eigene Agenten der PL: Abmahnung Datenschutz$/);
  assert.equal(full.publicReason, 'Eigener Agent der PL: Gesperrt durch eine KI-Freigabe für die PL, die ihn angelegt hat');
  const forMax = (await t.api(await t.login('max@demo.local')).get(`/projects/${web()}/ai/capabilities`)).json().agents.find((x: any) => x.id === a.id);
  assert.equal(forMax.run.allowed, false);
  assert.equal(forMax.run.reason, full.publicReason, 'TaskDrawer „Läuft nicht“ ohne Namen und Notiz');
  await t.api(pl).post(`/tasks/${task}/comments`, { body: 'Weiter?' });
  await flushAgentRuns();
  assert.equal((await t.db.one(`select error from agent_runs where task_id = $1 and status = 'skipped' order by created_at desc limit 1`, [task])).error, full.publicReason);
  const worker = await runAgents(t.db, t.mail, fakeFetch, new Date(Date.now() + 3600_000));
  assert.equal(worker.find((r) => r.taskId === task)?.error, full.publicReason, 'auch der Worker ohne Namen und Notiz');
  const manualPl = await t.api(pl).post(`/tasks/${task}/agent-run`);
  assert.equal(manualPl.statusCode, 403);
  assert.doesNotMatch(manualPl.json().error, /Abmahnung/);
  await rule(admin, { userId: t.ids.users.pl, feature: 'pl.agents', effect: null });
  // Sperre für den Mandanten: auch der laufende Agent der PL stoppt
  await rule(admin, { feature: 'pl.agents', effect: 'deny', note: 'neu prüfen' });
  const d = await aiAllowed(t.db, { userId: a.id, projectId: web(), feature: 'agent.run' });
  assert.equal(d.stage, 'project');
  assert.match(d.reason, /^Eigener Agent der PL: Gesperrt durch Org-Admin \(Alex Admin\) für den Mandanten, Eigene Agenten der PL: neu prüfen/);
  const listing = (await t.api(admin).get('/ai/policies')).json();
  const stopped = listing.stoppedAgents.find((x: any) => x.id === a.id);
  assert.ok(stopped, 'Verwaltung zeigt den gestoppten Agenten');
  assert.equal(stopped.createdById, t.ids.users.pl);
  // „erlauben“: Ausnahme für die PL in ihrem Projekt
  await rule(admin, { projectId: stopped.projectId, userId: stopped.createdById, feature: 'pl.agents', effect: 'allow', note: `Agent ${stopped.name} erlaubt` });
  assert.ok(!(await t.api(admin).get('/ai/policies')).json().stoppedAgents.some((x: any) => x.id === a.id));
  assert.equal((await aiAllowed(t.db, { userId: a.id, projectId: web(), feature: 'agent.run' })).allowed, true);
  await clearRules();
});

test('Mail-KI: mail.process und mail.triage über die Freigaben; gesperrte Läufe übersprungen mit Begründung', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  // Agent betreut die Projektansicht; Sperre für ihn: Lauf übersprungen
  assert.equal((await t.api(pl).patch(`/mail/views/${t.ids.views.project}`, { agentUserId: morton.id })).statusCode, 200);
  await rule(admin, { projectId: web(), userId: morton.id, feature: 'mail.triage', effect: 'deny', note: 'keine Mails' });
  t.mail.dev.inject(t.ids.accounts.project, { from: { address: 'kunde@extern.de', name: 'Kunde' }, to: ['projekt-web@demo.local'], subject: 'Frage zur Website', text: 'Wann geht es los?' } as any);
  await t.mail.syncAccount(t.ids.accounts.project);
  await flushAgentRuns();
  const mail = await t.db.one(`select id from mails where subject = 'Frage zur Website'`);
  const run = await t.db.one(`select status, error from mail_ai_runs where mail_id = $1`, [mail.id]);
  assert.equal(run.status, 'skipped');
  assert.match(run.error, /keine Mails/);
  await t.api(pl).patch(`/mail/views/${t.ids.views.project}`, { agentUserId: null });
  // Agent zuweisen (setViewAi): für mail.triage gesperrt → 403 mit Begründung
  const view = `/mail/views/${t.ids.views.project}`;
  const assign = await t.api(pl).patch(view, { agentUserId: morton.id });
  assert.equal(assign.statusCode, 403);
  assert.match(assign.json().error, /keine Mails/);
  await clearRules();
  assert.equal((await t.api(pl).patch(view, { agentUserId: morton.id })).statusCode, 200);
  await t.api(pl).patch(view, { agentUserId: null });
  // „KI bearbeiten“: Sperre für die PL → Ordner nicht einrichtbar und „Projekt-KI bearbeitet direkt“ nicht einschaltbar (403 mit Begründung)
  await rule(admin, { userId: t.ids.users.pl, feature: 'mail.process', effect: 'deny', note: 'nicht freigegeben' });
  const folder = await t.api(pl).post(`/projects/${web()}/mail/ai-folder`, { accountId: t.ids.accounts.project });
  assert.equal(folder.statusCode, 403);
  assert.match(folder.json().error, /nicht freigegeben/);
  const on = await t.api(pl).patch(view, { aiProcess: true });
  assert.equal(on.statusCode, 403);
  assert.match(on.json().error, /nicht freigegeben/);
  await clearRules();
  assert.equal((await t.api(pl).patch(view, { aiProcess: true })).statusCode, 200);
  // Sperre nach dem Einschalten: der Lauf wird übersprungen, ohne LLM-Aufruf; die Läufe sehen alle mit Zugriff auf die Ansicht, daher ohne Notiz
  await rule(admin, { userId: t.ids.users.pl, feature: 'mail.process', effect: 'deny', note: 'Datenschutz Kunde' });
  const n = calls.length;
  t.mail.dev.inject(t.ids.accounts.project, { from: { address: 'kunde@extern.de', name: 'Kunde' }, to: ['projekt-web@demo.local'], subject: 'Zweite Frage zur Website', text: 'Und die Preise?' } as any);
  await t.mail.syncAccount(t.ids.accounts.project);
  await flushAgentRuns();
  const second = await t.db.one(`select r.status, r.mode, r.error from mail_ai_runs r join mails m on m.id = r.mail_id where m.subject = 'Zweite Frage zur Website'`);
  assert.deepEqual([second.status, second.mode, second.error], ['skipped', 'process', 'Gesperrt durch eine KI-Freigabe für diese Person, Ordner „KI Bearbeiten“']);
  assert.equal(calls.length, n, 'kein LLM-Aufruf');
  await clearRules();
  assert.equal((await t.api(pl).patch(view, { aiProcess: false })).statusCode, 200);
});

test('Abschluss-Antwort mit KI über die Freigabe assist.final_reply; ohne KI weiter möglich', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const gf = (await t.api(pl).get(`/mail/views/${t.ids.views.project}/mails`)).json().mails.find((m: any) => m.fromAddr === 'gf@demo.local');
  const task = (await t.api(pl).post(`/mail/mails/${gf.id}/create-task`, { projectId: web(), title: 'Angebot beantworten' })).json().task.id;
  await rule(admin, { projectId: web(), feature: 'assist.final_reply', effect: 'deny', note: 'Antworten nur von Hand' });
  const blocked = await t.api(pl).get(`/tasks/${task}/final-reply?ai=1`);
  assert.equal(blocked.statusCode, 403);
  assert.match(blocked.json().error, /Antworten nur von Hand/);
  assert.equal((await t.api(pl).get(`/projects/${web()}/ai/capabilities`)).json().features['assist.final_reply'].allowed, false);
  assert.equal((await t.api(pl).get(`/tasks/${task}/final-reply`)).statusCode, 200, 'ohne KI');
  await clearRules();
  const ok = await t.api(pl).get(`/tasks/${task}/final-reply?ai=1`);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.match(ok.json().body, /Antwort der KI/);
});

test('Eigenes LLM: pl.own_llm sperrt Einbinden, Test, Umkonfigurieren und die Wahl als Projekt-KI; Einschränken bleibt möglich', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  await t.api(admin).put('/ai/settings', { ownLlm: 'all' });
  const base = `/projects/${web()}/llms`;
  const own = { name: 'WEB eigen', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'lokal' };
  const lid = (await t.api(pl).post(base, own)).json().llm.id;
  await rule(admin, { userId: t.ids.users.pl, feature: 'pl.own_llm', effect: 'deny', note: 'Datenschutz' });
  const add = await t.api(pl).post(base, { ...own, name: 'Noch eins' });
  assert.equal(add.statusCode, 403);
  assert.match(add.json().error, /Datenschutz/);
  const listing = (await t.api(pl).get(base)).json();
  assert.equal(listing.canAddOwn, false);
  assert.match(listing.addOwnReason, /Datenschutz/);
  assert.equal((await t.api(pl).post(`${base}/${lid}/test`)).statusCode, 403);
  const moved = await t.api(pl).patch(`${base}/${lid}`, { baseUrl: 'http://fremd.example/v1', active: true });
  assert.equal(moved.statusCode, 403, 'kein Umkonfigurieren ohne Freigabe');
  assert.match(moved.json().error, /Datenschutz/);
  assert.equal((await t.api(pl).patch(`${base}/${lid}`, { ...own, apiKey: 'neu' })).statusCode, 403, 'kein neuer Schlüssel');
  const pick = await t.api(pl).patch(`/projects/${web()}`, { aiProfileId: lid });
  assert.equal(pick.statusCode, 403, 'nicht als Projekt-KI wählbar');
  assert.equal((await t.db.one(`select ai_profile_id from projects where id = $1`, [web()])).ai_profile_id, profileId);
  // Einschränken: Formular mit unveränderten Feldern und „aktiv“ aus, Schlüssel entfernen
  assert.equal((await t.api(pl).patch(`${base}/${lid}`, { ...own, thinkingOff: false, active: false })).statusCode, 200);
  assert.equal((await t.api(pl).patch(`${base}/${lid}`, { apiKey: null })).statusCode, 200);
  assert.equal((await t.api(pl).patch(`${base}/${lid}`, { active: true })).statusCode, 403, 'wieder einschalten nur mit Freigabe');
  await clearRules();
  assert.equal((await t.api(pl).patch(`${base}/${lid}`, { active: true })).statusCode, 200);
  assert.equal((await t.api(pl).del(`${base}/${lid}`)).statusCode, 200);
  await t.api(admin).put('/ai/settings', { ownLlm: 'personal' });
});

test('Tagesbudget der KI-Assistenz je Projekt (assistDailyBudget); 0 sperrt', async () => {
  const admin = await t.login('admin@demo.local');
  const max = await t.login('max@demo.local');
  const used = (await t.db.one(`select count(*)::int as c from audit_log where project_id = $1 and action in ('ai.call','ai.final_reply') and created_at >= current_date`, [web()])).c;
  await t.api(admin).put('/ai/settings', { assistDailyBudget: used + 1 });
  assert.equal((await t.api(max).post(`/projects/${web()}/ai/ask`, { question: 'Wer liefert das Design?' })).statusCode, 200);
  const over = await t.api(max).post(`/projects/${web()}/ai/ask`, { question: 'Wer liefert das Design?' });
  assert.equal(over.statusCode, 400);
  assert.match(over.json().error, /Tagesbudget der KI-Assistenz/);
  await t.api(admin).put('/ai/settings', { assistDailyBudget: 0 });
  assert.equal((await t.api(max).get(`/projects/${web()}/ai/capabilities`)).json().features['assist.ask'].stage, 'budget');
  assert.equal((await t.api(admin).get('/ai/status')).json().assistDailyBudget, 0);
  await t.api(admin).put('/ai/settings', { assistDailyBudget: 200 });
});

test('Migration 043: Schalter „Eigene Agenten der PL“ wird Org-Regel mit Audit, Mail-KI behält „KI nutzen“', async () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const db = await createDb();
  try {
    await db.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql') && x < '043').sort()) {
      await db.exec(readFileSync(path.join(dir, f), 'utf8'));
      await db.query(`insert into schema_migrations (name) values ($1)`, [f]);
    }
    // Bestand: ein Mandant mit ausgeschaltetem Schalter und einem Agenten der PL, einer mit eingeschaltetem
    const off = (await db.one(`insert into orgs (name, settings) values ('Alt GmbH', '{"ai":{"plAgents":{"enabled":false}}}') returning id`)).id;
    const on = (await db.one(`insert into orgs (name, settings) values ('Offen GmbH', '{"ai":{"plAgents":{"enabled":true}}}') returning id`)).id;
    const pl = (await db.one(`insert into users (org_id, email, name, password_hash, global_role) values ($1,'pl@alt.local','Paula',' ','project_creator') returning id`, [off])).id;
    const mm = (await db.one(`insert into users (org_id, email, name, password_hash) values ($1,'mm@alt.local','Mia',' ') returning id`, [off])).id;
    const lr = (await db.one(`insert into users (org_id, email, name, password_hash) values ($1,'lr@alt.local','Lars',' ') returning id`, [off])).id;
    const p = (await db.one(`insert into projects (org_id, key, name, created_by) values ($1,'ALT','Alt',$2) returning id`, [off, pl])).id;
    const agent = (await db.one(`insert into users (org_id, email, name, password_hash, kind, agent_project_id, agent_created_by) values ($1,'assi@agent.local','Assi',' ','agent',$2,$3) returning id`, [off, p, pl])).id;
    await db.query(`insert into project_members (project_id, user_id, role, can_use_ai) values ($1,$2,'pl',false), ($1,$3,'member',false), ($1,$4,'member',true), ($1,$5,'reader',false)`, [p, pl, mm, agent, lr]);
    const acc = (await db.one(`insert into mail_accounts (org_id, type, project_id, name, address, provider) values ($1,'project',$2,'ALT','alt@alt.local','dev') returning id`, [off, p])).id;
    await db.query(`insert into mail_views (account_id, project_id, name, ai_process, ai_process_by) values ($1,$2,'KI Bearbeiten',true,$3)`, [acc, p, mm]);
    // Leser mit Mail-KI an seinem persönlichen Konto: sein Lauf wurde nie ausgeführt (Rolle), daher kein Bestandsschutz
    const lacc = (await db.one(`insert into mail_accounts (org_id, type, owner_user_id, name, address, provider) values ($1,'personal',$2,'Lars','lr@alt.local','dev') returning id`, [off, lr])).id;
    await db.query(`insert into mail_views (account_id, project_id, name, ai_process, ai_process_by) values ($1,$2,'Lars KI',true,$3)`, [lacc, p, lr]);
    assert.deepEqual(await runMigrations(db), readdirSync(dir).filter((x) => x.endsWith('.sql') && x >= '043').sort());
    const rules = await db.query(`select org_id, feature, effect, project_id, user_id, group_id, set_by, note from ai_policies order by effect`);
    assert.deepEqual(rules.rows.map((r: any) => [r.org_id, r.feature, r.effect, r.project_id, r.user_id, r.group_id, r.set_by]), [[on, 'pl.agents', 'allow', null, null, null, null], [off, 'pl.agents', 'deny', null, null, null, null]]);
    assert.match(rules.rows[0].note, /übernommen aus „Eigene Agenten der PL“/);
    const audits = await db.query(`select org_id, details from audit_log where action = 'ai.policy.migrated'`);
    assert.equal(audits.rows.length, 2);
    assert.deepEqual(audits.rows.find((x: any) => x.org_id === off).details.stoppedAgents.map((x: any) => x.name), ['Assi'], 'gestoppte Agenten der PL im Audit');
    assert.deepEqual(audits.rows.find((x: any) => x.org_id === on).details.stoppedAgents, []);
    assert.equal((await db.one(`select can_use_ai from project_members where project_id = $1 and user_id = $2`, [p, mm])).can_use_ai, true, 'Bestandsschutz Mail-KI');
    assert.equal((await db.one(`select can_use_ai from project_members where project_id = $1 and user_id = $2`, [p, pl])).can_use_ai, false, 'sonst keine stille Änderung');
    assert.equal((await db.one(`select can_use_ai from project_members where project_id = $1 and user_id = $2`, [p, lr])).can_use_ai, false, 'Leser bekommen nicht still Frage und Chat');
    // Gewollt: der Agent der PL stoppt, Begründung aus der übernommenen Regel
    const d = await aiAllowed(db, { userId: agent, projectId: p, feature: 'agent.run' });
    assert.equal(d.stage, 'project');
    assert.match(d.reason, /Eigener Agent der PL: Gesperrt durch Regel für den Mandanten, Eigene Agenten der PL: übernommen/);
    await assert.rejects(db.query(`update users set org_rights = '{root}' where id = $1`, [mm]));
  } finally {
    await db.close();
  }
});

test('Einziger Weg zur KI: aiConfigForProject, aiConfigForAgent und profileConfig nur in client.ts und policy.ts; complete() nur mit Konfiguration aus aiConfigFor', () => {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []; });
  const files = walk(src).map((f) => ({ rel: path.relative(src, f).split(path.sep).join('/'), text: readFileSync(f, 'utf8') }));
  const internal = files.filter((f) => /\baiConfigFor(Project|Agent|Profile)\s*\(/.test(f.text)).map((f) => f.rel).sort();
  assert.deepEqual(internal, ['ai/client.ts', 'ai/policy.ts']);
  // Auch profileConfig (Konfiguration aus einer Profilzeile) nur dort, sonst ließe sich die Prüfung mit einer eigenen Abfrage umgehen
  assert.deepEqual(files.filter((f) => /\bprofileConfig\s*\(/.test(f.text)).map((f) => f.rel).sort(), ['ai/client.ts', 'ai/policy.ts']);
  // Keine selbst gebaute Konfiguration außerhalb von client.ts: kein AiConfig-Literal, keine Typumwandlung, kein complete() mit Objekt
  for (const f of files.filter((x) => x.rel !== 'ai/client.ts')) {
    assert.ok(!/\bas AiConfig\b|<AiConfig>|:\s*AiConfig\s*=\s*\{|\bcomplete\(\s*\{/.test(f.text), `${f.rel} baut eine KI-Konfiguration selbst`);
  }
  // Wer complete() aufruft, holt die Konfiguration über aiConfigFor oder bekommt sie als Parameter von einem solchen Aufrufer
  for (const f of files.filter((x) => /\bcomplete\(\s*(cfg|c)\b/.test(x.text) && x.rel !== 'ai/client.ts')) {
    assert.ok(f.text.includes('aiConfigFor(') || /\bcfg: AiConfig\b/.test(f.text), `${f.rel} holt die KI-Konfiguration nicht über aiConfigFor`);
  }
  const viaParam = files.filter((x) => /\bcfg: AiConfig\b/.test(x.text) && /\bcomplete\(/.test(x.text) && !x.text.includes('aiConfigFor(')).map((f) => f.rel).sort();
  // outbound.ts: Neuformulierung nach außen (composeExternal) mit der Konfiguration des Agentenlaufs, nur über guardOutbound
  assert.deepEqual(viaParam, ['ai/service.ts', 'mail/origin.ts', 'outbound.ts']);
  assert.deepEqual(files.filter((x) => /\bcomposeExternal\(cfg/.test(x.text)).map((f) => f.rel), ['outbound.ts']);
  for (const fn of ['summarizeMail', 'essenceForTask', 'essenceForPage', 'statusReportDraft', 'askProject', 'aiFinalReply', 'guardOutbound']) {
    for (const f of files.filter((x) => new RegExp(`await ${fn}\\(db`).test(x.text))) assert.ok(f.text.includes('aiConfigFor('), `${f.rel} ruft ${fn} ohne aiConfigFor`);
  }
});
