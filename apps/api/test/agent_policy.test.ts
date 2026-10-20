import test from 'node:test';
import assert from 'node:assert/strict';
import { composeEcho, testApp } from './helpers.js';
import { flushAgentRuns } from '../src/ai/agentEvents.js';
import { runAgentOnTask } from '../src/ai/agent.js';

/** Lokales LLM: Agentenläufe liefern `nextActions`. */
let nextActions: any[] = [];
const prompts: string[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const echo = composeEcho(body);
  if (echo) return echo;
  if (String(input) !== 'http://llm.local:8000/v1/chat/completions') return new Response('{}', { status: 404 });
  prompts.push(String(body.messages?.at(-1)?.content ?? ''));
  const content = body.response_format ? JSON.stringify({ note: 'Policy-Test', actions: nextActions }) : 'bereit';
  return new Response(JSON.stringify({ model: 'qwen', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
};
delete process.env.ANTHROPIC_API_KEY;
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());

const web = () => t.ids.projects.web;
let agent: any; let page: any; let task: any;
const agentRow = () => ({ id: agent.id, name: agent.name, org_id: t.ids.org, persona: null });
const openApproval = () => t.db.maybeOne(`select * from questions where task_id = $1 and kind = 'approval' and status = 'open'`, [task.id]);

test('Vorbereitung und wirksame Policy: Standard, Mandant, Projekt, Agent, AP mit Herkunft; Grenzen maxMode und lockedConfirm', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const p = (await t.api(admin).post('/ai/profiles', { name: 'Qwen', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'qwen' })).json().profile;
  await t.api(admin).put('/ai/settings', { defaultProfileId: p.id, agentDailyBudget: 50 });
  agent = (await t.api(admin).post('/agents', { name: 'Schreiber' })).json().agent;
  await t.api(pl).put(`/projects/${web()}/members/${agent.id}`, { role: 'pl', agentCanMail: true, canFinalize: true });
  // Demo-Projekt verhält sich wie Bestand: auto
  let e = (await t.api(pl).get(`/projects/${web()}/agent-policy?agentId=${agent.id}`)).json();
  assert.equal(e.effective.mode, 'auto'); assert.equal(e.effective.origin.mode, 'Projekt WEB');
  // Projekt zurück auf Vorgabe → Standard „Rückfrage bei wichtigen Schritten“
  assert.equal((await t.api(pl).put(`/projects/${web()}/agent-policy`, {})).statusCode, 200);
  e = (await t.api(pl).get(`/projects/${web()}/agent-policy?agentId=${agent.id}`)).json();
  assert.equal(e.effective.mode, 'confirm_critical'); assert.equal(e.effective.origin.mode, 'Standard');
  assert.deepEqual(e.effective.confirm.sort(), ['close', 'distribute', 'finalize', 'restructure', 'send_external']);
  // Mandant erzwingt mindestens confirm_critical und immer finalize; Projekt will auto → angehoben
  assert.equal((await t.api(admin).put('/ai/settings', { agentPolicy: { maxMode: 'confirm_critical', lockedConfirm: ['finalize'] } })).statusCode, 200);
  assert.equal((await t.api(admin).get('/ai/status')).json().agentPolicy.maxMode, 'confirm_critical');
  assert.equal((await t.api(pl).put(`/projects/${web()}/agent-policy`, { mode: 'auto', confirm: [] })).statusCode, 200);
  e = (await t.api(pl).get(`/projects/${web()}/agent-policy?agentId=${agent.id}`)).json();
  assert.equal(e.effective.mode, 'confirm_critical', 'Grenze des Mandanten');
  assert.equal(e.effective.origin.mode, 'Mandant erzwungen');
  assert.deepEqual(e.effective.confirm, ['finalize'], 'gewählte Liste leer, gesperrte Klasse bleibt');
  assert.equal(e.effective.origin.confirm.finalize, 'Mandant erzwungen');
  assert.equal((await t.api(pl).put(`/projects/${web()}/agent-policy`, { mode: 'sofort' })).statusCode, 400);
  assert.equal((await t.api(admin).put('/ai/settings', { agentPolicy: {} })).statusCode, 200);
  // Agent im Projekt: confirm_all; AP: zurück auf confirm_critical mit eigener Liste
  assert.equal((await t.api(pl).put(`/projects/${web()}/members/${agent.id}/agent-policy`, { mode: 'confirm_all' })).statusCode, 200);
  e = (await t.api(pl).get(`/projects/${web()}/agent-policy?agentId=${agent.id}`)).json();
  assert.equal(e.effective.mode, 'confirm_all'); assert.equal(e.effective.confirm.length, 9);
  assert.equal(e.agents.find((a: any) => a.userId === agent.id).policy.mode, 'confirm_all');
  assert.equal((await t.api(pl).put(`/projects/${web()}/members/${agent.id}/agent-policy`, null)).statusCode, 200);
  assert.equal((await t.api(pl).put(`/projects/${web()}/members/${t.ids.users.max}/agent-policy`, { mode: 'auto' })).statusCode, 404, 'nur Agenten');
});

test('Rückfrage bei wichtigen Schritten: Final setzen und PDF-Versand werden angehalten (Vorschläge, Frage approval mit Karte), freie Aktionen laufen', async () => {
  const pl = await t.login('pl@demo.local');
  await t.api(pl).put(`/projects/${web()}/agent-policy`, { mode: 'confirm_critical' });
  const r = await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Protokoll Jour fixe', columnId: (await t.db.one(`select id from board_columns where project_id = $1 and name = 'Offen'`, [web()])).id, responsibleUserId: agent.id });
  assert.equal(r.statusCode, 200, r.body);
  task = r.json().task;
  await flushAgentRuns();
  const folder = await t.db.one(`select id from doc_folders where project_id = $1 and name = 'Protokolle'`, [web()]);
  page = await t.db.one(`insert into doc_pages (project_id, folder_id, title, content_md, content_html, status, created_by, updated_by) values ($1,$2,'JF 20.10.','# JF','<h1>JF</h1>','review',$3,$3) returning *`, [web(), folder.id, t.ids.users.pl]);
  nextActions = [
    { type: 'comment', text: 'Protokoll fertig, setze es final und verteile es.' },
    { type: 'doc_status', pageId: page.id, status: 'final' },
    { type: 'doc_send_pdf', pageId: page.id, to: null, subject: 'Protokoll JF 20.10.', text: 'Anbei das Protokoll.' }
  ];
  const run = await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow(), task.id, 'manual');
  assert.equal(run.status, 'ok', run.error ?? '');
  assert.deepEqual(run.actions.map((a: any) => a.type), ['comment'], 'nur die freie Aktion lief');
  assert.ok(prompts.at(-1)?.includes('Agenten-Policy: Selbstständigkeit: Rückfrage bei wichtigen Schritten'), 'Policy im Prompt');
  assert.equal((await t.db.one(`select status from doc_pages where id = $1`, [page.id])).status, 'review', 'nicht final gesetzt');
  const q = await openApproval();
  assert.ok(q, 'Frage approval');
  assert.equal(q.addressee_id, t.ids.users.pl);
  assert.match(q.body, /1\) „JF 20.10.“ → Final/);
  assert.match(q.body, /2\) PDF „JF 20.10.“ an Verteiler/);
  const props = (await t.db.query(`select * from ai_proposals where question_id = $1 order by seq`, [q.id])).rows;
  assert.equal(props.length, 2);
  assert.equal(props[0].action_class, 'finalize'); assert.equal(props[1].action_class, 'distribute');
  assert.equal(props[1].depends_on, props[0].id, 'PDF hängt am Final-Setzen');
  assert.equal(props[0].payload.base.pageStatus, 'review');
  const tk = await t.db.one(`select agent_wait from tasks where id = $1`, [task.id]);
  assert.equal(tk.agent_wait.questionId, q.id, 'Agent wartet auf die Bestätigung');
  const qd = (await t.api(pl).get(`/questions/${q.id}`)).json().question;
  assert.equal(qd.kind, 'approval'); assert.equal(qd.proposals.length, 2); assert.equal(qd.proposals[0].label, '„JF 20.10.“ → Final');
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and ref_type = 'question' and ref_id = $2`, [t.ids.users.pl, q.id]));
  const list = (await t.api(pl).get(`/projects/${web()}/ai/proposals`)).json().proposals;
  assert.equal(list.filter((p: any) => p.kind === 'agent_action').length, 2);
});

test('Bestätigen führt mit den Rechten des Agenten in Reihenfolge aus (Final, dann PDF), Log „Ausgeführt nach Bestätigung“, Frage erledigt, Agent läuft mit Anlass approved', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const q = await openApproval();
  assert.equal((await t.api(max).post(`/questions/${q.id}/decide`, { approve: 'all' })).statusCode, 403, 'Mitglied ohne Freigaberecht');
  nextActions = [{ type: 'none', reason: 'fertig' }];
  const r = await t.api(pl).post(`/questions/${q.id}/decide`, { approve: 'all' });
  assert.equal(r.statusCode, 200, r.body);
  await flushAgentRuns();
  assert.equal(r.json().question.status, 'answered');
  const props = (await t.db.query(`select * from ai_proposals where question_id = $1 order by seq`, [q.id])).rows;
  assert.deepEqual(props.map((p: any) => p.status), ['approved', 'approved'], props.map((p: any) => p.result).join(' | '));
  assert.equal((await t.db.one(`select status from doc_pages where id = $1`, [page.id])).status, 'final');
  const sent = t.mail.dev.sent.filter((m: any) => m.msg.subject === 'Protokoll JF 20.10.');
  assert.equal(sent.length, 1, 'PDF an den Verteiler des Ordners gesendet');
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and body like 'Ausgeführt nach Bestätigung durch Petra%Final%'`, [task.id]), 'Log');
  assert.ok(await t.db.maybeOne(`select 1 from agent_runs where task_id = $1 and trigger = 'approved' and status = 'ok'`, [task.id]), 'Ausführung protokolliert');
  assert.ok(await t.db.maybeOne(`select 1 from agent_runs where task_id = $1 and trigger = 'approved' and reasoning like 'Policy-Test%'`, [task.id]), 'Folgelauf des Agenten mit Anlass approved');
  assert.equal((await t.db.one(`select agent_wait from tasks where id = $1`, [task.id])).agent_wait, null);
});

test('Ablehnen mit Grund: Vorschlag und Abhängige abgelehnt, Log, 14 Tage nicht erneut vorschlagen; Freitext im Thread ist keine Bestätigung', async () => {
  const pl = await t.login('pl@demo.local');
  await t.db.query(`update doc_pages set status = 'review' where id = $1`, [page.id]);
  nextActions = [{ type: 'doc_status', pageId: page.id, status: 'final' }, { type: 'doc_send_pdf', pageId: page.id, to: null, subject: 'Protokoll v2', text: 'Anbei.' }];
  await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow(), task.id, 'manual');
  const q = await openApproval();
  assert.ok(q);
  assert.equal((await t.api(pl).post(`/questions/${q.id}/decide`, { reject: 'all' })).statusCode, 400, 'Grund ist Pflicht');
  // Freitext im Thread: keine Entscheidung (approval ist keine Freitext-Frage)
  await t.api(pl).post(`/chat/channels/${q.channel_id}/messages`, { body: 'ok passt', threadId: q.message_id });
  assert.equal((await t.db.one(`select status from questions where id = $1`, [q.id])).status, 'open');
  const first = (await t.db.query(`select id from ai_proposals where question_id = $1 order by seq`, [q.id])).rows[0].id;
  nextActions = [{ type: 'none', reason: 'ok' }];
  const r = await t.api(pl).post(`/questions/${q.id}/decide`, { reject: [first], reason: 'Noch nicht abgestimmt' });
  assert.equal(r.statusCode, 200, r.body);
  await flushAgentRuns();
  const props = (await t.db.query(`select status, result from ai_proposals where question_id = $1 order by seq`, [q.id])).rows;
  assert.deepEqual(props.map((p: any) => p.status), ['rejected', 'rejected']);
  assert.equal(props[1].result, 'Voraussetzung abgelehnt');
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and body like 'Abgelehnt von Petra%Noch nicht abgestimmt%'`, [task.id]));
  assert.equal((await t.db.one(`select status, answer_option from questions where id = $1`, [q.id])).answer_option, 'rejected');
  assert.ok(await t.db.maybeOne(`select 1 from agent_runs where task_id = $1 and trigger = 'rejected'`, [task.id]), 'Lauf mit Anlass rejected');
  // Erneuter Vorschlag derselben Aktion: Gate lehnt ab, keine neue Frage
  nextActions = [{ type: 'doc_status', pageId: page.id, status: 'final' }];
  const run = await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow(), task.id, 'manual');
  assert.equal(run.status, 'error');
  assert.match(run.error ?? '', /abgelehnt; nicht erneut vorschlagen/);
  assert.equal(await openApproval(), null);
});

test('KI-Freigabe sperrt eine Klasse (agent.close): nicht ausgeführt, nicht vorgeschlagen; selbstständig (auto) läuft Erledigt direkt; Ordner mit Agentenzugriff „nur lesen“ sperrt Schreiben', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  await t.api(pl).put(`/projects/${web()}/agent-policy`, { mode: 'auto' });
  assert.equal((await t.api(admin).put('/ai/policies', { projectId: web(), userId: null, groupId: null, note: null, feature: 'agent.close', effect: 'deny' })).statusCode, 200);
  nextActions = [{ type: 'set_status', column: 'Erledigt' }];
  let run = await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow(), task.id, 'manual');
  assert.match(run.error ?? '', /gesperrt durch KI-Freigabe „Erledigt setzen“/);
  assert.ok(prompts.at(-1)?.includes('Gesperrt (KI-Freigaben, nicht vorschlagen): Erledigt setzen'), 'Sperre im Prompt');
  assert.notEqual((await t.db.one(`select c.name from tasks t join board_columns c on c.id = t.column_id where t.id = $1`, [task.id])).name, 'Erledigt');
  assert.equal(await openApproval(), null, 'gesperrt wird nicht vorgelegt');
  await t.api(admin).put('/ai/policies', { projectId: web(), userId: null, groupId: null, note: null, feature: 'agent.close', effect: null });
  // Ordnerzugriff: Protokolle nur lesen → doc_update verworfen, read_page bleibt
  const folder = await t.db.one(`select id from doc_folders where project_id = $1 and name = 'Protokolle'`, [web()]);
  assert.equal((await t.api(pl).patch(`/projects/${web()}/docs/folders/${folder.id}`, { agentAccess: 'read' })).statusCode, 200);
  nextActions = [{ type: 'doc_update', pageId: page.id, text: 'Neu' }];
  run = await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow(), task.id, 'manual');
  assert.match(run.error ?? '', /Agenten dürfen im Ordner „Protokolle“ nicht schreiben/);
  await t.api(pl).patch(`/projects/${web()}/docs/folders/${folder.id}`, { agentAccess: 'none' });
  nextActions = [{ type: 'none', reason: 'nichts' }];
  run = await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow(), task.id, 'manual');
  assert.ok(!prompts.at(-1)?.includes(`pageId ${page.id}`), 'Seite im gesperrten Ordner nicht in der Seitenliste');
  assert.ok(!prompts.at(-1)?.includes('Doku-Ordner: Protokolle') && !/Doku-Ordner:.*Protokolle/.test(prompts.at(-1) ?? ''), 'gesperrter Ordner nicht in der Ordnerliste');
  await t.api(pl).patch(`/projects/${web()}/docs/folders/${folder.id}`, { agentAccess: 'write' });
  // auto: Erledigt läuft direkt
  nextActions = [{ type: 'set_status', column: 'Erledigt' }];
  run = await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow(), task.id, 'manual');
  assert.equal(run.status, 'ok', run.error ?? '');
  assert.equal((await t.db.one(`select c.name from tasks t join board_columns c on c.id = t.column_id where t.id = $1`, [task.id])).name, 'Erledigt');
});

test('Mails nach außen unter Rückfrage: als Entwurf zur Freigabe statt direkt; Policy je AP nur verschärfen mit „Projektplan ändern“', async () => {
  const pl = await t.login('pl@demo.local');
  const anna = await t.login('anna@demo.local');
  await t.api(pl).put(`/projects/${web()}/agent-policy`, { mode: 'confirm_critical' });
  const r = await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Lieferant anfragen', columnId: (await t.db.one(`select id from board_columns where project_id = $1 and name = 'Offen'`, [web()])).id, responsibleUserId: agent.id });
  const t2 = r.json().task;
  await flushAgentRuns();
  nextActions = [{ type: 'mail', to: ['lieferant@extern.de'], subject: 'Anfrage Kabel', text: 'Guten Tag,\n\nbitte ein Angebot.\n\nSchreiber (KI-Agent, Projekt WEB)' }];
  const run = await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow(), t2.id, 'manual');
  assert.equal(run.status, 'ok', run.error ?? '');
  const d = await t.db.one(`select status from mail_drafts where task_id = $1 and subject = 'Anfrage Kabel'`, [t2.id]);
  assert.equal(d.status, 'pending_approval');
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and body like '%Agenten-Policy: Mails nach außen gibt eine Person frei%'`, [t2.id]));
  assert.equal(t.mail.dev.sent.filter((m: any) => m.msg.subject === 'Anfrage Kabel').length, 0);
  // AP-Policy: Anna (Projektplan ändern) darf nur verschärfen
  await t.api(pl).put(`/projects/${web()}/members/${t.ids.users.anna}`, { role: 'member', canEditPlan: true });
  assert.equal((await t.api(anna).put(`/tasks/${t2.id}/agent-policy`, { mode: 'auto' })).statusCode, 403);
  assert.equal((await t.api(anna).put(`/tasks/${t2.id}/agent-policy`, { mode: 'confirm_all' })).statusCode, 200);
  const e = (await t.api(pl).get(`/projects/${web()}/agent-policy?agentId=${agent.id}&taskId=${t2.id}`)).json().effective;
  assert.equal(e.mode, 'confirm_all'); assert.equal(e.origin.mode, `WEB-${t2.number}`);
  assert.equal((await t.api(pl).put(`/tasks/${t2.id}/agent-policy`, null)).statusCode, 200);
  assert.equal((await t.api(pl).get(`/tasks/${t2.id}`)).json().task.agentPolicy, null);
});

test('Workflow-Schritt an einen KI-Agenten: Agent wird zuständig und läuft; gesperrt (agent.workflow oder Policy) fällt der Schritt an die PL mit Hinweis', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const def = await t.api(pl).post('/workflows', { name: 'Agentenablauf', steps: [{ key: 's1', type: 'task', title: 'Recherche {{kunde}}', responsible: 'agent', responsibleUserId: agent.id, waitForDone: false }, { key: 's2', type: 'task', title: 'Prüfung', responsible: 'pl' }] });
  assert.equal(def.statusCode, 200, def.body);
  assert.equal((await t.api(pl).post('/workflows', { name: 'Kaputt', steps: [{ key: 's1', type: 'task', title: 'x', responsible: 'agent' }] })).statusCode, 400, 'Agent wählen');
  nextActions = [{ type: 'comment', text: 'Recherche gestartet.' }];
  const run1 = await t.api(pl).post(`/projects/${web()}/workflows/${def.json().definition.id}/start`, { name: 'Lauf A', vars: { kunde: 'Meier' } });
  assert.equal(run1.statusCode, 200, run1.body);
  await flushAgentRuns();
  const t1 = await t.db.one(`select * from tasks where title = 'Recherche Meier'`);
  assert.equal(t1.responsible_user_id, agent.id);
  assert.ok(await t.db.maybeOne(`select 1 from agent_runs where task_id = $1 and trigger = 'assigned'`, [t1.id]), 'Agent läuft sofort');
  // Sperre über KI-Freigabe
  await t.api(admin).put('/ai/policies', { projectId: null, userId: agent.id, groupId: null, note: null, feature: 'agent.workflow', effect: 'deny' });
  const run2 = await t.api(pl).post(`/projects/${web()}/workflows/${def.json().definition.id}/start`, { name: 'Lauf B', vars: { kunde: 'Huber' } });
  assert.equal(run2.statusCode, 200, run2.body);
  await flushAgentRuns();
  const t2 = await t.db.one(`select * from tasks where title = 'Recherche Huber'`);
  assert.equal(t2.responsible_user_id, null, 'an die PL (geerbt)');
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and body like 'Der Schritt war für Schreiber (KI-Agent) vorgesehen%'`, [t2.id]));
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and title like 'Workflow-Schritt an dich%'`, [t.ids.users.pl]));
  await t.api(admin).put('/ai/policies', { projectId: null, userId: agent.id, groupId: null, note: null, feature: 'agent.workflow', effect: null });
  // Sperre über die Agenten-Policy des Projekts
  await t.api(pl).put(`/projects/${web()}/agent-policy`, { mode: 'confirm_critical', workflows: false });
  const run3 = await t.api(pl).post(`/projects/${web()}/workflows/${def.json().definition.id}/start`, { name: 'Lauf C', vars: { kunde: 'Schulz' } });
  assert.equal(run3.statusCode, 200, run3.body);
  const t3 = await t.db.one(`select * from tasks where title = 'Recherche Schulz'`);
  assert.equal(t3.responsible_user_id, null);
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and body like '%Agenten-Policy%Workflow-Schritte nicht zu%'`, [t3.id]));
});
