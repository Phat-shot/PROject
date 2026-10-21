import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { runWorkflows } from '../src/workflows/engine.js';

const t = await testApp();
test.after(() => t.close());

const STEPS = [
  { key: 'a', type: 'task', title: 'Kickoff {{kunde}} vorbereiten', description: 'Für {{projekt}}, gestartet von {{starter}}', responsible: 'starter', dueDays: 3, checklist: ['Agenda', 'Einladung'] },
  { key: 't', type: 'timer', hours: 2 },
  { key: 'b', type: 'task', title: 'Kickoff {{kunde}} durchführen', responsible: 'email', responsibleEmail: 'kunde@firma.de', waitForDone: true },
  { key: 'w', type: 'wait', waitKind: 'approval', title: 'Freigabe Protokoll' },
  { key: 'm', type: 'wait', waitKind: 'mail', title: 'Bestätigung des Kunden', mailSubject: 'Bestätigung' },
  { key: 'c', type: 'task', title: 'Nachbereitung', responsible: 'previous', waitForDone: false },
  { key: 'z', type: 'mail', title: 'Abschlussmail', toPl: true, toPrevious: true, to: ['chef@demo.local'], subject: 'Workflow {{workflow}} abgeschlossen', text: 'Lauf {{lauf}} ist durch.' }
];

test('Workflow: Definition prüfen und anlegen; Lauf: Arbeitspaket → Timer → Arbeitspaket → Freigabe → Mail-Eingang → Arbeitspaket → Abschlussmail', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const leser = await t.login('leser@demo.local');
  const web = t.ids.projects.web;
  assert.equal((await t.api(leser).post('/workflows', { name: 'x', steps: STEPS })).statusCode, 403);
  assert.equal((await t.api(admin).post('/workflows', { name: 'Kaputt', steps: [{ type: 'timer', title: 'ohne Dauer' }] })).statusCode, 400);
  assert.equal((await t.api(admin).post('/workflows', { name: 'Kaputt', steps: [{ type: 'mail', title: 'ohne Empfänger', subject: 's', text: 't' }] })).statusCode, 400);
  const d = await t.api(admin).post('/workflows', { name: 'Kickoff-Ablauf', description: 'Standard für neue Kunden', steps: STEPS });
  assert.equal(d.statusCode, 200, d.body);
  const def = d.json().definition;
  assert.equal(def.steps.length, 7);
  assert.equal(def.steps[0].key, 'a');

  // Start im Board: Arbeitspakete in Spalte „Offen“, Teilprojekt Konzept
  const col = await t.db.one(`select id from board_columns where project_id = $1 and name = 'Offen'`, [web]);
  const sp = await t.db.one(`select id from subprojects where project_id = $1 and name = 'Konzept & Design'`, [web]);
  const before = t.mail.dev.sent.length;
  const s = await t.api(max).post(`/projects/${web}/workflows/${def.id}/start`, { name: 'Kickoff Müller', columnId: col.id, subprojectId: sp.id, vars: { kunde: 'Müller GmbH' } });
  assert.equal(s.statusCode, 200, s.body);
  let run = s.json().run;
  assert.equal(run.status, 'active');
  assert.equal(run.currentStep, 0);
  assert.equal(run.state[0].status, 'active');
  assert.match(run.waitingOn, /Arbeitspaket „Kickoff/);
  const t1 = (await t.api(max).get(`/tasks/${run.state[0].taskId}`)).json().task;
  assert.equal(t1.title, 'Kickoff Müller GmbH vorbereiten', 'Platzhalter aus Lauf-Variablen');
  assert.match(t1.description, /Für Website-Relaunch, gestartet von Max Keller/);
  assert.equal(t1.responsibleUserId, t.ids.users.max, 'Starter ist zuständig');
  assert.equal(t1.columnId, col.id);
  assert.equal(t1.subprojectId, sp.id);
  assert.equal(t1.workflowRunId, run.id);
  assert.equal(t1.checklistTotal, 2);
  assert.ok(t1.dueDate);
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and body like 'Aus Workflow%'`, [t1.id]));
  // Timer startet erst nach Erledigung
  const done = await t.db.one(`select id from board_columns where project_id = $1 and is_done`, [web]);
  await t.api(max).post(`/tasks/${t1.id}/move`, { columnId: done.id });
  run = (await t.api(max).get(`/projects/${web}/workflow-runs/${run.id}`)).json().run;
  assert.equal(run.currentStep, 1, 'nach Erledigung läuft der Timer');
  assert.equal(run.state[0].status, 'done');
  assert.match(run.waitingOn, /Timer bis/);
  assert.equal(await runWorkflows(t.db, t.mail, new Date(Date.now() + 3600_000)), 0, 'Timer noch nicht abgelaufen');
  assert.equal(await runWorkflows(t.db, t.mail, new Date(Date.now() + 2 * 3600_000 + 60_000)), 1, 'Timer abgelaufen → nächstes Arbeitspaket');
  run = (await t.api(max).get(`/projects/${web}/workflow-runs/${run.id}`)).json().run;
  assert.equal(run.currentStep, 2);
  const t2 = (await t.api(max).get(`/tasks/${run.state[2].taskId}`)).json().task;
  assert.equal(t2.responsibleEmail, 'kunde@firma.de');
  assert.ok((await t.api(pl).get(`/projects/${web}/contacts`)).json().contacts.some((c: any) => c.email === 'kunde@firma.de'), 'externe Zuständige wird Kontakt');
  await t.api(pl).post(`/tasks/${t2.id}/move`, { columnId: done.id });
  run = (await t.api(max).get(`/projects/${web}/workflow-runs/${run.id}`)).json().run;
  assert.equal(run.currentStep, 3);
  assert.match(run.waitingOn, /Freigabe/);
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'workflow.approval'`, [t.ids.users.pl]));
  assert.equal((await t.api(max).post(`/workflow-runs/${run.id}/approve`)).statusCode, 403, 'Mitglied darf nicht freigeben');
  run = (await t.api(pl).post(`/workflow-runs/${run.id}/approve`)).json().run;
  assert.equal(run.currentStep, 4);
  assert.equal(run.state[3].approvedBy, t.ids.users.pl);
  assert.match(run.waitingOn, /Mail „Bestätigung“/);
  // Mail am Projektkonto mit Stichwort im Betreff
  assert.equal(await runWorkflows(t.db, t.mail), 0);
  t.mail.dev.inject(t.ids.accounts.project, { from: { address: 'kunde@firma.de', name: 'Kunde' }, subject: 'Re: Bestätigung Kickoff', text: 'Passt.' });
  await t.mail.syncAccount(t.ids.accounts.project);
  assert.equal(await runWorkflows(t.db, t.mail), 1);
  run = (await t.api(max).get(`/projects/${web}/workflow-runs/${run.id}`)).json().run;
  assert.match(run.state[4].note, /Mail von kunde@firma.de/);
  // Schritt c wartet nicht (waitForDone false), Abschlussmail geht sofort raus, Lauf ist fertig
  assert.equal(run.status, 'done', JSON.stringify(run.state));
  assert.equal(run.state[5].status, 'done');
  const t3 = (await t.api(max).get(`/tasks/${run.state[5].taskId}`)).json().task;
  assert.equal(t3.responsibleEmail, 'kunde@firma.de', 'Zuständige des vorigen Arbeitspakets');
  assert.equal(t.mail.dev.sent.length, before + 1);
  const sent = t.mail.dev.sent[before].msg;
  assert.equal(sent.subject, 'Workflow Kickoff-Ablauf abgeschlossen');
  assert.deepEqual([...sent.to].sort(), ['chef@demo.local', 'kunde@firma.de', 'pl@demo.local']);
  assert.equal(sent.text, 'Lauf Kickoff Müller ist durch.');
  const detail = (await t.api(max).get(`/projects/${web}/workflow-runs/${run.id}`)).json();
  assert.equal(detail.tasks.length, 3);
  const list = (await t.api(max).get(`/projects/${web}/workflows`)).json();
  assert.equal(list.definitions.find((x: any) => x.id === def.id).runCount, 1);
  assert.equal(list.runs[0].doneSteps, 7);
});

test('Isolierte Instanz: eigenes Mini-Projekt (kind workflow, unsichtbar in Listen), Schritt überspringen, abbrechen; Vorlage mit aktiven Läufen nicht löschbar', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const def = (await t.api(admin).post('/workflows', { name: 'Kurz', steps: [{ type: 'timer', title: 'Warten', days: 1 }, { type: 'task', title: 'Danach', responsible: 'pl' }, { type: 'mail', title: 'Info', toStarter: true, subject: 'Fertig {{lauf}}', text: 'ok' }] })).json().definition;
  assert.equal(def.projectId, null, 'mandantenweite Vorlage');
  assert.equal((await t.api(max).post(`/workflows/${def.id}/start`, { name: 'Mein Lauf' })).statusCode, 200);
  const run = (await t.api(pl).post(`/workflows/${def.id}/start`, { name: 'Isoliert 1' })).json().run;
  assert.equal(run.standalone, true);
  assert.equal(run.projectKind, 'workflow');
  assert.match(run.projectKey, /^WF\d+$/);
  assert.equal(run.projectName, 'Isoliert 1');
  const mini = (await t.api(pl).get(`/projects/${run.projectId}`)).json();
  assert.equal(mini.project.myMembership.role, 'pl', 'Starter ist PL des Mini-Projekts');
  assert.equal(mini.columns.length, 7);
  assert.ok(!(await t.api(pl).get('/projects')).json().projects.some((p: any) => p.id === run.projectId), 'Mini-Projekt nicht in der Projektliste');
  assert.ok(!(await t.api(pl).get('/portfolio')).json().projects?.some((p: any) => p.id === run.projectId), 'nicht im Portfolio');
  assert.equal((await t.api(max).get(`/workflow-runs/${run.id}`)).statusCode, 403, 'kein Mitglied des Mini-Projekts');
  const mine = (await t.api(pl).get('/workflows')).json();
  assert.ok(mine.runs.some((r: any) => r.id === run.id));
  assert.ok(!mine.runs.some((r: any) => r.name === 'Mein Lauf'), 'fremde isolierte Läufe nicht sichtbar');
  const leser = await t.login('leser@demo.local');
  assert.equal((await t.api(leser).get('/workflows')).json().canBuild, false, 'Rolle user baut keine Vorlagen');
  assert.equal((await t.api(leser).post('/workflows', { name: 'x', steps: STEPS })).statusCode, 403);
  assert.ok((await t.api(admin).get('/workflows')).json().runs.some((r: any) => r.name === 'Mein Lauf'), 'Org-Admin sieht alle');
  assert.equal((await t.api(admin).del(`/workflows/${def.id}`)).statusCode, 400, 'aktiver Lauf');
  const skipped = (await t.api(pl).post(`/workflow-runs/${run.id}/skip`, { note: 'Termin vorgezogen' })).json().run;
  assert.equal(skipped.state[0].status, 'skipped');
  assert.equal(skipped.currentStep, 1);
  const task = (await t.api(pl).get(`/tasks/${skipped.state[1].taskId}`)).json().task;
  assert.equal(task.projectId, run.projectId, 'Arbeitspaket im Mini-Projekt');
  assert.equal(task.responsibleUserId, null, 'pl = geerbt');
  // Erledigen → Mail über das Mandantenkonto (kein Projektkonto am Mini-Projekt)
  const before = t.mail.dev.sent.length;
  const done = mini.columns.find((c: any) => c.isDone).id;
  await t.api(pl).post(`/tasks/${task.id}/move`, { columnId: done });
  const finished = (await t.api(pl).get(`/workflow-runs/${run.id}`)).json().run;
  if (finished.status === 'done') { assert.equal(t.mail.dev.sent.length, before + 1); assert.equal(t.mail.dev.sent[before].msg.subject, 'Fertig Isoliert 1'); }
  else assert.match(String(finished.lastError), /Konto/, 'ohne Mandantenkonto bleibt der Mail-Schritt mit Fehler stehen');
  const cancelled = (await t.api(pl).post(`/workflow-runs/${run.id}/cancel`)).json();
  assert.ok(['cancelled', 'done'].includes(cancelled.run?.status ?? 'done'));
  await t.db.query(`update workflow_runs set status = 'cancelled' where def_id = $1 and status = 'active'`, [def.id]);
  assert.equal((await t.api(admin).del(`/workflows/${def.id}`)).statusCode, 200);
  assert.equal((await t.api(pl).get(`/workflow-runs/${run.id}`)).json().run.defId, null, 'Lauf bleibt als Historie');
});
