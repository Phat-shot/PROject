import test from 'node:test';
import assert from 'node:assert/strict';
import { composeEcho, testApp } from './helpers.js';
import { agentBudgetLeft, runAgents } from '../src/ai/agent.js';
import { flushAgentRuns, queueAgentRun } from '../src/ai/agentEvents.js';

/** Lokales LLM (OpenAI-kompatibel wie vLLM): antwortet mit Aktionen je nach Prompt. */
const calls: { url: string; body: any }[] = [];
let nextActions: any[] = [];
/** Antworten für mehrere Modellaufrufe in einem Lauf (Leserunden); leer = nextActions */
let queue: any[][] = [];
/** Solange gesetzt, wartet ein Agentenlauf nach dem Prompt auf die Freigabe (Lauf „läuft gerade“). */
let gate: Promise<void> | null = null;
const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const echo = composeEcho(body);
  if (echo) return echo;
  calls.push({ url, body });
  if (url === 'http://llm.local:8000/v1/chat/completions') {
    if (body.model !== 'qwen3') return new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 });
    if (gate && body.response_format) await gate;
    const content = body.response_format ? JSON.stringify({ note: 'Stand unklar, Lieferant gefragt.', actions: queue.length ? queue.shift() : nextActions }) : 'bereit';
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
  const s = await t.api(admin).put('/ai/settings', { agentDailyBudget: 5 });
  assert.equal(s.json().agentDailyBudget, 5);
});

test('Agent: nur Org-Admin legt an; kein Login; Mitgliedschaft wird Mitglied mit Stellvertretung; Zuweisung nur durch PL', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  assert.equal((await t.api(pl).post('/agents', { name: 'Nachfasser', aiProfileId: profileId })).statusCode, 403);
  const a = (await t.api(admin).post('/agents', { name: 'Nachfasser', aiProfileId: profileId })).json().agent;
  assert.match(a.email, /@agent\.local$/);
  assert.equal(a.aiProfileId, profileId, 'gehört zum gewählten LLM');
  assert.equal((await t.api(admin).post('/agents', { name: 'Ohne LLM' })).statusCode, 400, 'bei mehreren LLMs muss eines gewählt werden');
  const wrong = (await t.api(admin).get('/ai/profiles')).json().profiles.find((p: any) => p.name === 'Kaputt');
  assert.equal((await t.api(admin).patch(`/agents/${a.id}`, { aiProfileId: wrong.id })).json().agent.aiProfileId, wrong.id);
  assert.equal((await t.api(admin).patch(`/agents/${a.id}`, { aiProfileId: profileId })).json().agent.aiProfileId, profileId);
  const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: a.email, password: 'irgendwas' } });
  assert.equal(login.statusCode, 401);
  const forgot = await t.app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: a.email } });
  assert.ok([200, 400, 404].includes(forgot.statusCode));
  const pid = t.ids.projects.web;
  // Agent als PL nur Stellvertretung: die verantwortliche PL bleibt, KI-Freigaben nie
  const asPl = await t.api(pl).put(`/projects/${pid}/members/${a.id}`, { role: 'pl', isDeputy: false, canApprove: true, agentCanMail: false });
  assert.equal(asPl.statusCode, 200, asPl.body);
  assert.equal(asPl.json().membership.role, 'pl');
  assert.equal(asPl.json().membership.isDeputy, true);
  assert.equal(asPl.json().membership.canApprove, false);
  assert.equal((await t.db.one(`select user_id from project_members where project_id = $1 and role = 'pl' and not is_deputy`, [pid])).user_id, t.ids.users.pl);
  const mem = await t.api(pl).put(`/projects/${pid}/members/${a.id}`, { role: 'reader', agentCanMail: false });
  assert.equal(mem.statusCode, 200, mem.body);
  assert.equal(mem.json().membership.role, 'member', 'Leser gibt es für Agenten nicht');
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
  await flushAgentRuns();
  const runsBefore = (await t.api(pl).get(`/projects/${pid}/agent-runs?taskId=${taskId}`)).json().runs.length;
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
  assert.equal(runs.length, runsBefore + 1);
  assert.equal(runs[0].trigger, 'manual');
  assert.equal(runs[0].inputTokens, 500);
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'agent.run' and user_id = $1`, [a.id]));

  // Mit Mail-Recht: direkter Versand über das Projektkonto, sobald die Adresse Bezug zum AP hat (hier externe Zuständigkeit für einen Task);
  // der erste Kontakt zu einer Adresse ohne Bezug geht immer als Entwurf (external_scope.test.ts)
  await t.api(pl).put(`/projects/${pid}/members/${a.id}`, { role: 'member', agentCanMail: true });
  assert.equal((await t.api(pl).patch(`/tasks/${taskId}/checklist/${itemId}`, { responsibleEmail: 'k.mueller@mueller-design.de' })).statusCode, 200);
  const before = t.mail.dev.sent.length;
  nextActions = [{ type: 'mail', to: ['k.mueller@mueller-design.de'], subject: 'Erinnerung', text: 'Kurze Erinnerung. Nachfasser (KI-Agent, Projekt WEB)' }];
  await t.api(pl).post(`/tasks/${taskId}/agent-run`);
  assert.equal(t.mail.dev.sent.length, before + 1);
  assert.equal(t.mail.dev.sent[before].msg.subject, 'Erinnerung');

  // Worker: nur bei Anlass; Pause stoppt; Budget deckelt
  nextActions = [{ type: 'none', reason: 'nichts Neues' }];
  // Simulierte Zeiten bleiben am selben UTC-Tag (Tagesbudget): spät am Tag alles um 5 h zurückschieben
  const shift = new Date().getUTCHours() >= 19 ? 5 * 3600_000 : 0;
  if (shift) await t.db.query(`update agent_runs set created_at = created_at - interval '5 hours'`);
  const T0 = Date.now() - shift;
  const r1 = await runAgents(t.db, t.mail, fakeFetch, new Date(T0));
  assert.equal(r1.length, 0, 'kein Anlass direkt nach dem letzten Lauf');
  await t.api(pl).post(`/tasks/${taskId}/comments`, { body: 'Bitte auch Hosting klären.' });
  const r2 = await runAgents(t.db, t.mail, fakeFetch, new Date(T0 + 3600_000));
  assert.equal(r2.length, 1);
  assert.equal(r2[0].trigger ?? 'changed', 'changed');
  await t.api(pl).post(`/tasks/${taskId}/agent-pause`, { paused: true });
  await t.api(pl).post(`/tasks/${taskId}/comments`, { body: 'Noch etwas.' });
  const r3 = await runAgents(t.db, t.mail, fakeFetch, new Date(T0 + 2 * 3600_000));
  assert.equal(r3.length, 0, 'pausiert');
  await t.api(pl).post(`/tasks/${taskId}/agent-pause`, { paused: false });
  await t.api(admin).put('/ai/settings', { agentDailyBudget: 3 });
  const r4 = await runAgents(t.db, t.mail, fakeFetch, new Date(T0 + 4 * 3600_000));
  assert.equal(r4.length, 0, 'Tagesbudget (3) durch die bisherigen Läufe aufgebraucht');
  // Deaktivieren nimmt die Zuweisung weg
  await t.api(admin).patch(`/agents/${a.id}`, { active: false });
  const after = await t.db.one(`select responsible_user_id from tasks where id = $1`, [taskId]);
  assert.equal(after.responsible_user_id, null);
});

test('Sofortlauf bei Zuweisung und Kommentar; Wartezustand mit Wiedervorlage, Nachfassen und Eskalation nach Frist', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const pid = t.ids.projects.web;
  await t.api(admin).put('/ai/settings', { agentDailyBudget: 100 });
  const agent = (await t.api(admin).post('/agents', { name: 'Prüfer', aiProfileId: profileId })).json().agent;
  await t.api(pl).put(`/projects/${pid}/members/${agent.id}`, { role: 'member', agentCanMail: true });
  // Agent wartet auf Rückmeldung: Nachfassen nach 2 h, Eskalation nach 5 h, Prüfung nach 1 h
  nextActions = [{ type: 'mail', to: ['lieferant@example.com'], subject: 'Stand?', text: 'Bitte Rückmeldung. Prüfer (KI-Agent, Projekt WEB)' }, { type: 'wait', kind: 'reply', reason: 'Antwort des Lieferanten', checkAfterHours: 1, remindAfterHours: 2, escalateAfterHours: 5 }];
  const n0 = calls.length;
  const created = await t.api(pl).post(`/projects/${pid}/tasks`, { title: 'Lieferung klären', responsibleUserId: agent.id });
  assert.equal(created.statusCode, 200, created.body);
  const taskId = created.json().task.id;
  await flushAgentRuns();
  const runs1 = (await t.api(pl).get(`/projects/${pid}/agent-runs?taskId=${taskId}`)).json().runs;
  assert.equal(runs1.length, 1, 'sofortiger Lauf bei Zuweisung');
  assert.equal(runs1[0].trigger, 'assigned');
  assert.match(calls[calls.length - 1].body.messages[1].content, /gerade zugewiesen/);
  assert.ok(calls.length > n0);
  const t1 = (await t.api(pl).get(`/tasks/${taskId}`)).json().task;
  assert.equal(t1.agentWait.kind, 'reply');
  assert.ok(t1.agentWait.remindAt && t1.agentWait.escalateAt && t1.agentNextCheckAt);
  const since = new Date(t1.agentWait.since).getTime();
  assert.ok(Math.abs(new Date(t1.agentWait.remindAt).getTime() - (since + 2 * 3600_000)) < 5000);
  assert.ok(Math.abs(new Date(t1.agentWait.escalateAt).getTime() - (since + 5 * 3600_000)) < 5000);
  assert.ok(Math.abs(new Date(t1.agentNextCheckAt).getTime() - (since + 1 * 3600_000)) < 5000, 'nächste Prüfung = frühester Termin');
  // Erster Kontakt zum Lieferanten (ohne Bezug zum AP) wartet als Entwurf; die PL sendet ihn, danach hat die Adresse Bezug (Mail am AP)
  const first = await t.db.one(`select id, status from mail_drafts where task_id = $1`, [taskId]);
  assert.equal(first.status, 'pending_approval');
  assert.equal((await t.api(pl).post(`/mail/drafts/${first.id}/send`)).statusCode, 200);

  // Nach 1 h: Wiedervorlage (check); Agent wartet weiter, Nachfass-/Eskalationsfristen bleiben
  nextActions = [{ type: 'wait', kind: 'reply', reason: 'Antwort des Lieferanten', checkAfterHours: 1, remindAfterHours: 2, escalateAfterHours: 5 }];
  const r1 = await runAgents(t.db, t.mail, fakeFetch, new Date(since + 61 * 60_000));
  assert.equal(r1.filter((x) => x.taskId === taskId).length, 1);
  assert.match(calls[calls.length - 1].body.messages[1].content, /Wiedervorlage/);
  assert.match(calls[calls.length - 1].body.messages[1].content, /Du wartest seit/);
  const t2 = (await t.api(pl).get(`/tasks/${taskId}`)).json().task;
  assert.equal(new Date(t2.agentWait.since).getTime(), since, 'Wartebeginn bleibt');
  assert.equal(t2.agentWait.remindAt, t1.agentWait.remindAt);

  // Nach 2 h: Nachfassen fällig
  nextActions = [{ type: 'mail', to: ['lieferant@example.com'], subject: 'Erinnerung: Stand?', text: 'Erinnerung. Prüfer (KI-Agent, Projekt WEB)' }, { type: 'wait', kind: 'reply', reason: 'Antwort des Lieferanten', checkAfterHours: 2, remindAfterHours: 2, escalateAfterHours: 5 }];
  const before = t.mail.dev.sent.length;
  const r2 = await runAgents(t.db, t.mail, fakeFetch, new Date(since + 2 * 3600_000 + 60_000));
  assert.equal(r2.filter((x) => x.taskId === taskId).length, 1);
  assert.match(calls[calls.length - 1].body.messages[1].content, /Nachfassen fällig/);
  assert.match(calls[calls.length - 1].body.messages[1].content, /bei Projektmitgliedern per Chat, nur bei Externen per Mail/);
  assert.equal(t.mail.dev.sent.length, before + 1);
  const t3 = (await t.api(pl).get(`/tasks/${taskId}`)).json().task;
  assert.equal(t3.agentWait.reminded, true);
  assert.equal(t3.agentWait.escalateAt, t1.agentWait.escalateAt, 'Eskalationsfrist bleibt ab Wartebeginn');
  const r2b = await runAgents(t.db, t.mail, fakeFetch, new Date(since + 2 * 3600_000 + 120_000));
  assert.equal(r2b.filter((x) => x.taskId === taskId).length, 0, 'Nachfassen nur einmal');

  // Nach 5 h: Eskalation fällig
  nextActions = [{ type: 'escalate', text: 'Lieferant antwortet seit 5 h nicht.' }, { type: 'wait', kind: 'reply', reason: 'Entscheidung der PL', checkAfterHours: 24 }];
  const r3 = await runAgents(t.db, t.mail, fakeFetch, new Date(since + 5 * 3600_000 + 60_000));
  assert.equal(r3.filter((x) => x.taskId === taskId).length, 1);
  assert.match(calls[calls.length - 1].body.messages[1].content, /Eskalation fällig/);
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and title like 'Prüfer braucht eine Entscheidung%'`, [t.ids.users.pl]));

  // Rückmeldung als Kommentar: Sofortlauf, Agent beendet das Warten
  nextActions = [{ type: 'comment', text: 'Lieferung bestätigt für KW 47.' }, { type: 'set_status', column: 'In Arbeit' }];
  await t.api(pl).post(`/tasks/${taskId}/comments`, { body: 'Lieferant hat angerufen: KW 47.' });
  await flushAgentRuns();
  const runs = (await t.api(pl).get(`/projects/${pid}/agent-runs?taskId=${taskId}`)).json().runs;
  assert.equal(runs[0].trigger, 'comment');
  // Die Entscheidung der PL ist noch offen (Frage): das Warten zeigt auf die Frage; erst die Antwort beendet es
  const t4a = (await t.api(pl).get(`/tasks/${taskId}`)).json().task;
  const openQ = (await t.api(pl).get(`/tasks/${taskId}/questions`)).json().questions.find((q: any) => q.kind === 'decision' && q.status === 'open');
  assert.ok(openQ, 'Entscheidung als offene Frage');
  assert.equal(t4a.agentWait?.questionId, openQ.id, 'Warten hängt an der Frage');
  assert.equal((await t.api(pl).post(`/questions/${openQ.id}/answer`, { text: 'Weiter warten, Lieferant kommt KW 47.' })).statusCode, 200);
  await flushAgentRuns();
  const t4 = (await t.api(pl).get(`/tasks/${taskId}`)).json().task;
  assert.equal(t4.agentWait, null, 'kein Warten mehr');
  assert.equal(t4.agentNextCheckAt, null);
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and body = 'Weiter warten, Lieferant kommt KW 47.' and question_id = $2`, [taskId, openQ.id]), 'Antwort steht im Log');
  assert.ok(await t.db.maybeOne(`select 1 from agent_runs where task_id = $1 and trigger = 'answer'`, [taskId]), 'Agent läuft mit Anlass answer');
  // Eigener Kommentar des Agenten löst keinen Lauf aus
  const countBefore = (await t.api(pl).get(`/projects/${pid}/agent-runs?taskId=${taskId}`)).json().runs.length;
  await flushAgentRuns();
  assert.equal((await t.api(pl).get(`/projects/${pid}/agent-runs?taskId=${taskId}`)).json().runs.length, countBefore);
});

test('Doku-Aktionen (Seite anlegen, ergänzen, PDF senden), Tasks ergänzen/umformulieren, Termin mit Uhrzeit, Task-Änderung als Auslöser', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const pid = t.ids.projects.web;
  await t.api(admin).put('/ai/settings', { agentDailyBudget: 100 });
  const agent = (await t.api(admin).post('/agents', { name: 'Schreiber', aiProfileId: profileId })).json().agent;
  await t.api(pl).put(`/projects/${pid}/members/${agent.id}`, { role: 'member', agentCanMail: true });
  nextActions = [{ type: 'none', reason: 'erst lesen' }];
  const created = await t.api(pl).post(`/projects/${pid}/tasks`, { title: 'Jour fixe dokumentieren', responsibleUserId: agent.id });
  const taskId = created.json().task.id;
  await flushAgentRuns();
  assert.match(calls[calls.length - 1].body.messages[1].content, /Doku-Ordner: .*Protokolle/);

  // Task-Änderung durch Person löst Lauf aus; Agent legt Seite im Ordner an, ergänzt Tasks, wartet bis 20:20
  const now = new Date();
  nextActions = [
    { type: 'doc_create', title: 'JF 2026-10-17', folder: 'protokolle', text: '# Jour fixe\n\n- Thema A\n- Thema B' },
    { type: 'add_item', text: 'PDF an Teilnehmer senden' },
    { type: 'wait', kind: 'date', reason: 'Versand um 20:20', until: '20:20' }
  ];
  const n0 = (await t.api(pl).get(`/projects/${pid}/agent-runs?taskId=${taskId}`)).json().runs.length;
  await t.api(pl).post(`/tasks/${taskId}/checklist`, { title: 'Protokoll anlegen' });
  await flushAgentRuns();
  const runs = (await t.api(pl).get(`/projects/${pid}/agent-runs?taskId=${taskId}`)).json().runs;
  assert.equal(runs.length, n0 + 1, 'Lauf nach Task-Änderung');
  assert.equal(runs[0].trigger, 'task_changed');
  assert.match(calls[calls.length - 1].body.messages[1].content, /Arbeitspaket oder seine Tasks geändert/);
  const page = await t.db.one(`select p.*, f.name as folder from doc_pages p left join doc_folders f on f.id = p.folder_id where p.project_id = $1 and p.title = 'JF 2026-10-17'`, [pid]);
  assert.equal(page.folder, 'Protokolle');
  assert.equal(page.created_by, agent.id);
  assert.match(page.content_html, /<h1>Jour fixe<\/h1>/);
  assert.equal((await t.db.one(`select count(*)::int as n from doc_page_versions where page_id = $1`, [page.id])).n, 1);
  const items = await t.db.query(`select id, title from checklist_items where task_id = $1 order by position`, [taskId]);
  assert.deepEqual(items.rows.map((i: any) => i.title), ['Protokoll anlegen', 'PDF an Teilnehmer senden']);
  const t1 = (await t.api(pl).get(`/tasks/${taskId}`)).json().task;
  assert.equal(t1.agentWait.kind, 'date');
  const check = new Date(t1.agentNextCheckAt);
  assert.ok(check.getTime() > now.getTime() && check.getTime() < now.getTime() + 24 * 3600_000 + 60_000, 'Prüfung innerhalb 24 h');
  const berlin = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(check);
  assert.equal(berlin, '20:20', 'Uhrzeit in Europe/Berlin');
  assert.ok(t1.agentWait.reason.includes('20:20'));
  assert.ok((await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and body like 'Doku-Seite angelegt%'`, [taskId])));

  // Zum Termin: Seite ergänzen, Task umformulieren, PDF der Entwurfsseite wird abgelehnt (nur finale Seiten), Seitenliste enthält die neue Seite
  const itemId = items.rows[1].id;
  nextActions = [
    { type: 'doc_append', pageId: page.id, text: '## Beschlüsse\n\nAlles klar.' },
    { type: 'update_item', itemId, text: 'PDF an Teilnehmer gesendet' },
    { type: 'doc_send_pdf', pageId: page.id, to: ['gf@demo.local'], subject: 'Protokoll JF', text: 'Anbei das Protokoll. Schreiber (KI-Agent, Projekt WEB)' },
    { type: 'check_item', itemId }
  ];
  const before = t.mail.dev.sent.length;
  const r = await runAgents(t.db, t.mail, fakeFetch, new Date(check.getTime() + 60_000));
  assert.equal(r.filter((x) => x.taskId === taskId).length, 1, 'Lauf zum Termin');
  assert.match(String(r.find((x) => x.taskId === taskId)!.error), /PDF-Versand nur für finale Seiten/, 'auch an genannte Empfänger nur finale Seiten');
  assert.equal(t.mail.dev.sent.length, before, 'Entwurf geht nicht hinaus');
  assert.match(calls[calls.length - 1].body.messages[1].content, new RegExp(`„JF 2026-10-17“ \\(pageId ${page.id}`));
  const p2 = await t.db.one(`select * from doc_pages where id = $1`, [page.id]);
  assert.equal(p2.version, 2);
  assert.match(p2.content_html, /<h2>Beschlüsse<\/h2>/);
  assert.equal((await t.db.one(`select count(*)::int as n from doc_page_versions where page_id = $1`, [page.id])).n, 2);
  assert.equal((await t.db.one(`select title, done from checklist_items where id = $1`, [itemId])).title, 'PDF an Teilnehmer gesendet');
  // Final gesetzt (von einer Person mit Recht): PDF an ein Projektmitglied mit Anhang (Verteiler-Adressen erst mit „Final setzen / Versand“)
  await t.db.query(`update doc_pages set status = 'final' where id = $1`, [page.id]);
  nextActions = [{ type: 'doc_send_pdf', pageId: page.id, to: ['max@demo.local'], subject: 'Protokoll JF', text: 'Anbei das Protokoll. Schreiber (KI-Agent, Projekt WEB)' }];
  assert.equal((await t.api(pl).post(`/tasks/${taskId}/agent-run`)).statusCode, 200);
  assert.equal(t.mail.dev.sent.length, before + 1);
  const sent = t.mail.dev.sent[before].msg;
  assert.equal(sent.subject, 'Protokoll JF');
  assert.equal(sent.attachments?.length, 1);
  assert.match(sent.attachments![0].filename, /^JF_2026-10-17_v2\.pdf$/);
  assert.equal(sent.attachments![0].content.subarray(0, 4).toString(), '%PDF');
  assert.ok(await t.db.maybeOne(`select 1 from attachments where page_id = $1 and uploaded_by = $2`, [page.id, agent.id]), 'PDF liegt an der Seite');
  const t2 = (await t.api(pl).get(`/tasks/${taskId}`)).json().task;
  assert.equal(t2.agentWait, null);

  // Finale Seite wird nicht ergänzt; unbekannter Ordner fällt auf Protokolle zurück
  await t.db.query(`update doc_pages set status = 'final' where id = $1`, [page.id]);
  nextActions = [{ type: 'doc_append', pageId: page.id, text: 'Nachtrag' }, { type: 'doc_create', title: 'Notiz', folder: 'Gibtsnicht', text: 'Text' }];
  const rr = await t.api(pl).post(`/tasks/${taskId}/agent-run`);
  assert.equal(rr.statusCode, 200, rr.body);
  assert.deepEqual(rr.json().actions.map((x: any) => x.type), ['doc_create']);
  assert.match(String(rr.json().error), /final/);
  assert.equal((await t.db.one(`select version from doc_pages where id = $1`, [page.id])).version, 2);
  const note = await t.db.one(`select f.name as folder from doc_pages p join doc_folders f on f.id = p.folder_id where p.project_id = $1 and p.title = 'Notiz'`, [pid]);
  assert.equal(note.folder, 'Protokolle');
});

test('Doku wie ein Mitglied: Seite lesen (Leserunde), Inhalt ersetzen, Status mit Prüfbenachrichtigung, Final nur mit Recht, Verteiler-Versand, Ordner anlegen, verschieben', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const pid = t.ids.projects.web;
  const agent = (await t.api(pl).get('/agents')).json().agents.find((a: any) => a.name === 'Schreiber');
  const taskId = (await t.db.one(`select id from tasks where project_id = $1 and responsible_user_id = $2 order by created_at desc limit 1`, [pid, agent.id])).id;
  const page = await t.db.one(`select id, title from doc_pages where project_id = $1 and title = 'JF 2026-10-17'`, [pid]);
  await t.db.query(`update doc_pages set status = 'draft' where id = $1`, [page.id]);
  await t.db.query(`delete from agent_runs where task_id = $1`, [taskId]);

  // Runde 1: Modell liest die Seite (übrige Aktionen werden verworfen); Runde 2: ersetzt Inhalt und setzt In Prüfung
  queue = [
    [{ type: 'read_page', pageId: page.id }, { type: 'comment', text: 'darf nicht ausgeführt werden' }],
    [{ type: 'doc_update', pageId: page.id, title: 'JF 17.10.2026', text: '# Jour fixe 17.10.\n\n- Thema A\n- Thema B\n\n## Beschlüsse\n\nAlles klar.' }, { type: 'doc_status', pageId: page.id, status: 'review' }, { type: 'doc_status', pageId: page.id, status: 'final' }]
  ];
  const n0 = calls.length;
  const r = await t.api(pl).post(`/tasks/${taskId}/agent-run`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(calls.length - n0, 2, 'zwei Modellaufrufe');
  assert.match(calls[calls.length - 1].body.messages[1].content, /Gelesene Seiten \(Markdown\) und Recherche-Ergebnisse:\n### „JF 2026-10-17“ \(pageId/);
  assert.match(calls[calls.length - 1].body.messages[1].content, /# Jour fixe[\s\S]*Beschlüsse/);
  assert.match(calls[calls.length - 1].body.messages[1].content, /wurden NICHT ausgeführt/);
  assert.deepEqual(r.json().actions.map((x: any) => x.type), ['doc_update', 'doc_status']);
  assert.match(String(r.json().error), /Recht „Final setzen“/);
  assert.ok(!(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and body like 'darf nicht%'`, [taskId])), 'Aktionen der Leserunde nicht ausgeführt');
  const p2 = await t.db.one(`select * from doc_pages where id = $1`, [page.id]);
  assert.equal(p2.title, 'JF 17.10.2026');
  assert.equal(p2.status, 'review');
  assert.equal(p2.version, 3);
  assert.match(p2.content_html, /<h1>Jour fixe 17\.10\.<\/h1>/);
  assert.equal((await t.db.one(`select count(*)::int as n from doc_page_versions where page_id = $1`, [page.id])).n, 3);
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'page.review' and title = 'Zur Prüfung: JF 17.10.2026'`, [t.ids.users.pl]), 'PL wird zur Prüfung benachrichtigt');
  const runs = (await t.api(pl).get(`/projects/${pid}/agent-runs?taskId=${taskId}`)).json().runs;
  assert.equal(runs.length, 1, 'eine Leserunde ergibt einen Lauf');
  assert.equal(runs[0].inputTokens, 1000, 'Token beider Aufrufe summiert');

  // Mit Recht „Final setzen“: final, dann PDF an den Verteiler des Ordners Protokolle
  const mem = await t.api(pl).put(`/projects/${pid}/members/${agent.id}`, { role: 'member', agentCanMail: true, canFinalize: true });
  assert.equal(mem.json().membership.canFinalize, true);
  queue = [];
  nextActions = [{ type: 'doc_status', pageId: page.id, status: 'final' }, { type: 'doc_send_pdf', pageId: page.id, to: null, subject: 'Protokoll JF 17.10.', text: 'Anbei das finale Protokoll. Schreiber (KI-Agent, Projekt WEB)' }];
  const before = t.mail.dev.sent.length;
  const r2 = await t.api(pl).post(`/tasks/${taskId}/agent-run`);
  assert.equal(r2.statusCode, 200, r2.body);
  assert.deepEqual(r2.json().actions.map((x: any) => x.type), ['doc_status', 'doc_send_pdf']);
  assert.deepEqual(r2.json().actions[1].to, ['gf@demo.local', 'k.mueller@mueller-design.de'], 'Verteiler des Ordners');
  assert.equal((await t.db.one(`select status from doc_pages where id = $1`, [page.id])).status, 'final');
  assert.equal(t.mail.dev.sent.length, before + 1);
  assert.deepEqual(t.mail.dev.sent[before].msg.to, ['gf@demo.local', 'k.mueller@mueller-design.de']);
  assert.equal(t.mail.dev.sent[before].msg.attachments?.[0].filename, 'JF_17.10.2026_v3.pdf');
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'page.final' and user_id = $1`, [agent.id]));

  // Ordner anlegen und Seite verschieben; finale Seite bleibt strukturell änderbar; Verteiler-Versand an nicht-finale Seite wird abgelehnt
  nextActions = [{ type: 'folder_create', folder: 'JF-Protokolle' }, { type: 'doc_move', pageId: page.id, folder: 'jf-protokolle' }, { type: 'folder_create', folder: 'Protokolle' }];
  const r3 = await t.api(pl).post(`/tasks/${taskId}/agent-run`);
  assert.deepEqual(r3.json().actions.map((x: any) => x.type), ['folder_create', 'doc_move']);
  assert.match(String(r3.json().error), /gibt es schon/);
  const moved = await t.db.one(`select f.name from doc_pages p join doc_folders f on f.id = p.folder_id where p.id = $1`, [page.id]);
  assert.equal(moved.name, 'JF-Protokolle');
  await t.db.query(`update doc_pages set status = 'draft' where id = $1`, [page.id]);
  nextActions = [{ type: 'doc_send_pdf', pageId: page.id, to: null, subject: 'x', text: 'y' }];
  const r4 = await t.api(pl).post(`/tasks/${taskId}/agent-run`);
  assert.match(String(r4.json().error), /nur für finale Seiten/);
  assert.equal(t.mail.dev.sent.length, before + 1);
});

test('PDF-Versand an genannte Empfänger: Projektmitglieder, Verteiler oder Adressen mit aktiver Freigabe der Seite, sonst nicht', async () => {
  const pl = await t.login('pl@demo.local');
  const pid = t.ids.projects.web;
  const agent = (await t.api(pl).get('/agents')).json().agents.find((a: any) => a.name === 'Schreiber');
  const taskId = (await t.db.one(`select id from tasks where project_id = $1 and responsible_user_id = $2 order by created_at desc limit 1`, [pid, agent.id])).id;
  const page = await t.db.one(`select id from doc_pages where project_id = $1 and title = 'JF 17.10.2026'`, [pid]);
  // Seite liegt wieder im Ordner Protokolle (Verteiler gf@ und k.mueller@) und ist final
  await t.db.query(`update doc_pages set status = 'final', folder_id = (select id from doc_folders where project_id = $2 and name = 'Protokolle') where id = $1`, [page.id, pid]);
  const send = async (to: string[]) => {
    nextActions = [{ type: 'doc_send_pdf', pageId: page.id, to, subject: 'Protokoll', text: 'Anbei das Protokoll. Schreiber (KI-Agent, Projekt WEB)' }];
    const before = t.mail.dev.sent.length;
    // Lauf ohne ausgeführte Aktion: die Route meldet den Fehler mit 400
    const r = await t.api(pl).post(`/tasks/${taskId}/agent-run`);
    return { error: String(r.json().error ?? ''), sent: t.mail.dev.sent.slice(before).map((x: any) => x.msg.to) };
  };
  // Fremde Adresse (weder Mitglied noch Verteiler noch Freigabe): nichts geht hinaus, auch nicht an die übrigen Empfänger
  const a = await send(['fremd@example.com', 'max@demo.local']);
  assert.deepEqual(a.sent, []);
  assert.match(a.error, /fremd@example\.com ist weder Projektmitglied noch im Verteiler/);
  // Projektmitglied und Adresse aus dem Verteiler des Ordners
  assert.deepEqual((await send(['max@demo.local', 'k.mueller@mueller-design.de'])).sent, [['max@demo.local', 'k.mueller@mueller-design.de']]);
  // Aktive Freigabe der Seite für die Adresse: erlaubt; widerrufen: wieder gesperrt
  const share = await t.api(pl).post(`/docs/pages/${page.id}/shares`, { email: 'fremd@example.com', mode: 'read' });
  assert.equal(share.statusCode, 200, share.body);
  assert.deepEqual((await send(['fremd@example.com'])).sent, [['fremd@example.com']]);
  await t.api(pl).del(`/docs/shares/${share.json().share.id}`);
  assert.deepEqual((await send(['fremd@example.com'])).sent, []);
  // Agenten und deaktivierte Personen zählen nicht als Mitglieder
  assert.match((await send([agent.email])).error, /ist weder Projektmitglied/);
  assert.match(calls[calls.length - 1].body.messages[1].content, /PDF einer finalen Seite per Mail senden \(doc_send_pdf: an Projektmitglieder, Adressen aus dem Verteiler oder mit Freigabe der Seite/);
  await t.db.query(`update users set active = false where id = $1`, [t.ids.users.max]);
  const inactive = await send(['max@demo.local']);
  await t.db.query(`update users set active = true where id = $1`, [t.ids.users.max]);
  assert.deepEqual(inactive.sent, []);
  assert.match(inactive.error, /max@demo\.local ist weder Projektmitglied/);
  // Freigabe über die Oberseite nur mit „inkl. Unterseiten“; abgelaufene Freigaben zählen nicht
  const top = await t.db.one(`select id from doc_pages where project_id = $1 and title = 'JF Auftraggeber'`, [pid]);
  await t.db.query(`update doc_pages set parent_page_id = $2 where id = $1`, [page.id, top.id]);
  assert.equal((await t.api(pl).post(`/docs/pages/${top.id}/shares`, { email: 'reihe@example.com', mode: 'read', includeChildren: true })).statusCode, 200);
  assert.equal((await t.api(pl).post(`/docs/pages/${top.id}/shares`, { email: 'nurober@example.com', mode: 'read', includeChildren: false })).statusCode, 200);
  assert.deepEqual((await send(['reihe@example.com'])).sent, [['reihe@example.com']]);
  assert.match((await send(['nurober@example.com'])).error, /nurober@example\.com ist weder Projektmitglied/);
  const old = (await t.api(pl).post(`/docs/pages/${page.id}/shares`, { email: 'abgelaufen@example.com', mode: 'read', expiresDays: 1 })).json().share;
  await t.db.query(`update doc_shares set expires_at = now() - interval '1 hour' where id = $1`, [old.id]);
  assert.match((await send(['abgelaufen@example.com'])).error, /abgelaufen@example\.com ist weder Projektmitglied/);
  await t.db.query(`update doc_pages set parent_page_id = null where id = $1`, [page.id]);
  // Ohne „Final setzen / Versand“ auch keine einzelnen Adressen aus dem Verteiler; Projektmitglieder bleiben erlaubt
  await t.api(pl).put(`/projects/${pid}/members/${agent.id}`, { role: 'member', agentCanMail: true, canFinalize: false });
  const listed = await send(['k.mueller@mueller-design.de']);
  assert.deepEqual(listed.sent, []);
  assert.match(listed.error, /k\.mueller@mueller-design\.de ist kein Projektmitglied.*Adressen aus dem Verteiler nur mit Recht „Final setzen \/ Versand“/);
  assert.match(calls[calls.length - 1].body.messages[1].content, /doc_send_pdf: an Projektmitglieder oder Adressen mit Freigabe der Seite; Verteiler nur mit Recht „Final setzen“, das du nicht hast/);
  assert.deepEqual((await send(['max@demo.local'])).sent, [['max@demo.local']]);
  await t.api(pl).put(`/projects/${pid}/members/${agent.id}`, { role: 'member', agentCanMail: true, canFinalize: true });
});

test('Lauf von Hand beachtet Pause und Tagesbudget; Budget 0 sperrt; übersprungene Läufe zählen nicht', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const pid = t.ids.projects.web;
  await t.api(admin).put('/ai/settings', { agentDailyBudget: 100 });
  const agent = (await t.api(pl).get('/agents')).json().agents.find((a: any) => a.name === 'Schreiber');
  const taskId = (await t.db.one(`select id from tasks where project_id = $1 and responsible_user_id = $2 order by created_at desc limit 1`, [pid, agent.id])).id;
  nextActions = [{ type: 'none', reason: 'nichts zu tun' }];
  await t.api(pl).post(`/tasks/${taskId}/agent-pause`, { paused: true });
  const paused = await t.api(pl).post(`/tasks/${taskId}/agent-run`);
  assert.equal(paused.statusCode, 400);
  assert.match(paused.json().error, /pausiert/);
  await t.api(pl).post(`/tasks/${taskId}/agent-pause`, { paused: false });
  assert.equal((await t.api(pl).post(`/tasks/${taskId}/agent-run`)).statusCode, 200);
  // Übersprungene Läufe (ohne LLM-Aufruf) verbrauchen kein Budget
  const who = await t.db.one(`select id, org_id from users where id = $1`, [agent.id]);
  const left = await agentBudgetLeft(t.db, who);
  await t.db.query(`insert into agent_runs (org_id, agent_user_id, project_id, task_id, trigger, status, error) values ($1,$2,$3,$4,'manual','skipped','Test')`, [who.org_id, who.id, pid, taskId]);
  assert.equal(await agentBudgetLeft(t.db, who), left);
  // Budget 0 gilt (früher fiel 0 auf 50 zurück): kein Lauf von Hand, keiner im Worker
  assert.equal((await t.api(admin).put('/ai/settings', { agentDailyBudget: 0 })).json().agentDailyBudget, 0);
  const none = await t.api(pl).post(`/tasks/${taskId}/agent-run`);
  assert.equal(none.statusCode, 400);
  assert.match(none.json().error, /Tagesbudget von Schreiber ist aufgebraucht/);
  await t.api(pl).post(`/tasks/${taskId}/comments`, { body: 'Neuer Stand.' });
  await flushAgentRuns();
  assert.equal((await runAgents(t.db, t.mail, fakeFetch, new Date(Date.now() + 3600_000))).length, 0);
  await t.api(admin).put('/ai/settings', { agentDailyBudget: 100 });
});

test('Ereignisse am Arbeitspaket gehen nicht verloren: vor dem Start bleibt der erste Anlass, während eines Laufs folgt genau ein Folgelauf', async () => {
  const pl = await t.login('pl@demo.local');
  const pid = t.ids.projects.web;
  const agent = (await t.api(pl).get('/agents')).json().agents.find((a: any) => a.name === 'Prüfer');
  nextActions = [{ type: 'none', reason: 'nichts zu tun' }];
  queue = [];
  const taskId = (await t.api(pl).post(`/projects/${pid}/tasks`, { title: 'Folgelauf prüfen', responsibleUserId: agent.id })).json().task.id;
  await flushAgentRuns();
  const runs = async () => (await t.db.query(`select trigger from agent_runs where task_id = $1 order by created_at`, [taskId])).rows.map((r: any) => r.trigger);
  assert.deepEqual(await runs(), ['assigned']);
  // Zwei Ereignisse, bevor der Lauf startet: ein Lauf, der erste Anlass bleibt (Zuweisung vor dem folgenden Kommentar)
  queueAgentRun(taskId, 'assigned');
  queueAgentRun(taskId, 'comment');
  await flushAgentRuns();
  assert.deepEqual(await runs(), ['assigned', 'assigned']);
  // Während eines Laufs: zwei Kommentare setzen das Dirty-Flag, danach genau ein Folgelauf mit dem neuen Stand
  let release!: () => void;
  gate = new Promise<void>((r) => { release = r; });
  const n0 = calls.length;
  await t.api(pl).post(`/tasks/${taskId}/comments`, { body: 'Erster Hinweis.' });
  for (let i = 0; i < 400 && calls.length === n0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, n0 + 1, 'erster Lauf wartet auf das Modell');
  await t.api(pl).post(`/tasks/${taskId}/comments`, { body: 'Zweiter Hinweis.' });
  await t.api(pl).post(`/tasks/${taskId}/comments`, { body: 'Dritter Hinweis.' });
  gate = null;
  release();
  await flushAgentRuns();
  assert.deepEqual(await runs(), ['assigned', 'assigned', 'comment', 'comment']);
  assert.ok(!calls[n0].body.messages[1].content.includes('Zweiter Hinweis'));
  assert.match(calls[calls.length - 1].body.messages[1].content, /Dritter Hinweis/, 'Folgelauf liest den Stand neu');
});

test('Seitenstatus durch eine Person: Arbeitspakete, deren Log die Seite nennt, bekommen den Eintrag und der Agent läuft', async () => {
  const pl = await t.login('pl@demo.local');
  const pid = t.ids.projects.web;
  const agent = (await t.api(pl).get('/agents')).json().agents.find((a: any) => a.name === 'Schreiber');
  const task = (await t.api(pl).post(`/projects/${pid}/tasks`, { title: 'Freigabe abwarten', responsibleUserId: agent.id })).json().task;
  const page = (await t.api(pl).post(`/projects/${pid}/docs/pages`, { title: 'Abnahmekonzept Annahmen', contentMd: 'Entwurf' })).json().page;
  await flushAgentRuns();
  await t.db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [task.id, agent.id, 'Seite „Abnahmekonzept Annahmen“ (Entwurf, Ordner Konzepte) angelegt. Warte auf Freigabe der PL.']);
  await t.db.query(`delete from agent_runs where task_id = $1`, [task.id]);
  nextActions = [{ type: 'none', reason: 'x' }];
  assert.equal((await t.api(pl).post(`/docs/pages/${page.id}/status`, { status: 'review' })).statusCode, 200);
  assert.equal((await t.api(pl).post(`/docs/pages/${page.id}/status`, { status: 'final' })).statusCode, 200);
  await flushAgentRuns();
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and source = 'system' and body = 'Doku-Seite „Abnahmekonzept Annahmen“ → Final (durch Petra Lenz)'`, [task.id]));
  assert.ok(await t.db.maybeOne(`select 1 from agent_runs where task_id = $1 and trigger = 'task_changed'`, [task.id]), 'Agent läuft nach dem Statuswechsel');
});
