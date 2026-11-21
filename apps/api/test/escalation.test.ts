import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { criticality, targetLevel, DEFAULT_POLICY, runEscalations } from '../src/tasks/escalation.js';

let t: Awaited<ReturnType<typeof testApp>>;
before(async () => { t = await testApp(); });
after(async () => { await t.close(); });

test('Kritikalität und Stufenregel', () => {
  assert.equal(criticality({ priority: 'normal', overdueDays: 0, successors: 0, milestoneWithinDays: null, blocked: false }), 0);
  const high = criticality({ priority: 'critical', overdueDays: 3, successors: 2, milestoneWithinDays: 10, blocked: false });
  assert.ok(high >= 6);
  assert.equal(targetLevel({ overdueDays: 1, staleDays: 0, blocked: false, score: 0 }, DEFAULT_POLICY), 0);
  assert.equal(targetLevel({ overdueDays: 2, staleDays: 0, blocked: false, score: 0 }, DEFAULT_POLICY), 1);
  assert.equal(targetLevel({ overdueDays: 5, staleDays: 0, blocked: false, score: 0 }, DEFAULT_POLICY), 2);
  assert.equal(targetLevel({ overdueDays: 10, staleDays: 0, blocked: false, score: 0 }, DEFAULT_POLICY), 3);
  // Hohe Kritikalität halbiert die Fristen
  assert.equal(targetLevel({ overdueDays: 1, staleDays: 0, blocked: false, score: 7 }, DEFAULT_POLICY), 1);
  assert.equal(targetLevel({ overdueDays: 5, staleDays: 0, blocked: false, score: 7 }, DEFAULT_POLICY), 3);
  // Blockiert oder hängt → mindestens Stufe 1
  assert.equal(targetLevel({ overdueDays: 0, staleDays: 0, blocked: true, score: 2 }, DEFAULT_POLICY), 1);
  assert.equal(targetLevel({ overdueDays: 0, staleDays: 7, blocked: false, score: 0 }, DEFAULT_POLICY), 1);
});

test('Worker eskaliert entlang der Kette und setzt zurück, Blockiert-Flag informiert sofort', async () => {
  const pl = await t.login('pl@demo.local');
  // Aufgabe im Teilprojekt „Konzept & Design“ (Verantwortlich Max), zuständig Lea, Deadline in der Vergangenheit
  const detail = (await t.api(pl).get(`/projects/${t.ids.projects.web}`)).json();
  const konzept = detail.subprojects.find((s: any) => s.name.startsWith('Konzept'));
  const created = await t.api(pl).post(`/projects/${t.ids.projects.web}/tasks`, { title: 'Freigabe Bildrechte', subprojectId: konzept.id, dueDate: '2026-10-01', responsibleUserId: t.ids.users.leser, priority: 'normal' });
  const taskId = created.json().task.id;
  // Eskalationskontakt setzen (intern Admin, extern Auftraggeber)
  const pol = await t.api(pl).patch(`/projects/${t.ids.projects.web}`, { escalation: { contactUserId: t.ids.users.admin, contactEmail: 'gf@kunde.de', externalMode: 'proposal' } });
  assert.equal(pol.statusCode, 200, pol.body);
  assert.equal((await t.api(pl).patch(`/projects/${t.ids.projects.web}`, { escalation: { stageDays: [5, 2, 10] } })).statusCode, 400);

  // Tag 2 → Stufe 1 (Max als TP-Verantwortlicher)
  let r = await runEscalations(t.db, '2026-10-03');
  assert.ok(r.raised >= 1);
  let task = (await t.api(pl).get(`/tasks/${taskId}`)).json();
  assert.equal(task.task.escalationLevel, 1);
  const max = await t.login('max@demo.local');
  assert.ok((await t.api(max).get('/notifications')).json().notifications.some((n: any) => n.type === 'escalation' && n.title.includes('Stufe 1') && n.title.includes('Bildrechte')));
  // Tag 5 → Stufe 2 (PL)
  await runEscalations(t.db, '2026-10-06');
  task = (await t.api(pl).get(`/tasks/${taskId}`)).json();
  assert.equal(task.task.escalationLevel, 2);
  assert.ok((await t.api(pl).get('/notifications')).json().notifications.some((n: any) => n.type === 'escalation' && n.title.includes('Stufe 2')));
  // Tag 10 → Stufe 3: interner Kontakt benachrichtigt, externe Mail als Entwurf zur Freigabe
  await runEscalations(t.db, '2026-10-11');
  task = (await t.api(pl).get(`/tasks/${taskId}`)).json();
  assert.equal(task.task.escalationLevel, 3);
  const admin = await t.login('admin@demo.local');
  assert.ok((await t.api(admin).get('/notifications')).json().notifications.some((n: any) => n.type === 'escalation' && n.title.includes('Stufe 3')));
  const drafts = (await t.api(pl).get(`/projects/${t.ids.projects.web}/mail/drafts`)).json().drafts;
  const esc = drafts.find((d: any) => d.subject.startsWith('Eskalation WEB'));
  assert.ok(esc, 'Eskalationsmail-Entwurf');
  assert.equal(esc.status, 'pending_approval');
  assert.deepEqual(esc.toAddrs, ['gf@kunde.de']);
  assert.ok(task.comments.filter((c: any) => c.source === 'system').length >= 3, 'Log-Einträge je Stufe');
  // Warnungen-Endpunkt
  const w = await t.api(pl).get(`/projects/${t.ids.projects.web}/escalations`);
  assert.ok(w.json().escalations.some((e: any) => e.taskId === taskId && e.chain.length === 4));
  // Deadline in die Zukunft → Rücksetzung
  await t.api(pl).patch(`/tasks/${taskId}`, { dueDate: '2027-01-15' });
  const back = await runEscalations(t.db, '2026-10-12');
  assert.ok(back.reset >= 1);
  task = (await t.api(pl).get(`/tasks/${taskId}`)).json();
  assert.equal(task.task.escalationLevel, 0);

  // Blockiert-Flag: sofortige Meldung an TP-Verantwortung, Stufe 1 beim nächsten Lauf
  const lea = await t.login('leser@demo.local');
  assert.equal((await t.api(lea).patch(`/tasks/${taskId}`, { blocked: true, blockedReason: 'Lizenz unklar' })).statusCode, 403, 'Leser darf nicht ändern');
  const blk = await t.api(max).patch(`/tasks/${taskId}`, { blocked: true, blockedReason: 'Lizenz unklar' });
  assert.equal(blk.statusCode, 200, blk.body);
  assert.equal(blk.json().task.blocked, true);
  await runEscalations(t.db, '2026-10-13');
  task = (await t.api(pl).get(`/tasks/${taskId}`)).json();
  assert.equal(task.task.escalationLevel, 1);
  // Manuell auf Stufe 2, Reset durch PL
  const man = await t.api(max).post(`/tasks/${taskId}/escalate`, { level: 2, note: 'Entscheidung nötig' });
  assert.equal(man.statusCode, 200, man.body);
  assert.equal(man.json().task.escalationLevel, 2);
  assert.equal((await t.api(max).post(`/tasks/${taskId}/escalation/reset`)).statusCode, 403);
  assert.equal((await t.api(pl).post(`/tasks/${taskId}/escalation/reset`)).json().task.escalationLevel, 0);
});

test('Mandanten-Einstellungen für PDF-Stil', async () => {
  const pl = await t.login('pl@demo.local');
  assert.equal((await t.api(pl).put('/org/settings', { accentColor: '#aa0000' })).statusCode, 403);
  const admin = await t.login('admin@demo.local');
  assert.equal((await t.api(admin).put('/org/settings', { accentColor: 'rot' })).statusCode, 400);
  const ok = await t.api(admin).put('/org/settings', { company: 'Demo GmbH', accentColor: '#aa0000', footerText: 'Vertraulich' });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal((await t.api(pl).get('/org/settings')).json().settings.accentColor, '#aa0000');
  const docs = (await t.api(pl).get(`/projects/${t.ids.projects.web}/docs`)).json();
  const p = docs.pages.find((x: any) => x.title.startsWith('Projektauftrag'));
  const pdf = await t.api(pl).get(`/docs/pages/${p.id}/pdf`);
  assert.equal(pdf.statusCode, 200);
  assert.ok(pdf.rawPayload.length > 2000);
});

const day = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

async function freshProject(key: string) {
  const pl = await t.login('pl@demo.local');
  const p = (await t.api(pl).post('/projects', { key, name: `Eskalation ${key}` })).json().project;
  for (const u of [t.ids.users.anna, t.ids.users.max]) await t.db.query(`insert into project_members (project_id, user_id, role) values ($1,$2,'member') on conflict do nothing`, [p.id, u]);
  const cols = (await t.api(pl).get(`/projects/${p.id}`)).json().columns;
  const col = (name: string) => cols.find((c: any) => c.name === name).id as string;
  return { pl, id: p.id as string, col };
}

test('Stillstand erst ab Arbeitsbeginn: „Offen“ ohne Termin eskaliert nicht, nach „In Arbeit“ und 7 Tagen ohne Aktivität schon', async () => {
  const { evaluateProject } = await import('../src/tasks/escalation.js');
  const { pl, id, col } = await freshProject('ESA');
  const task = (await t.api(pl).post(`/projects/${id}/tasks`, { title: 'Neu und unbegonnen', columnId: col('Offen'), responsibleUserId: t.ids.users.anna })).json().task;
  assert.equal((await t.db.one(`select started_at from tasks where id = $1`, [task.id])).started_at, null);
  assert.ok(!(await evaluateProject(t.db, id, day(10))).some((r) => r.taskId === task.id), 'unbegonnen: kein Stillstand nach 10 Tagen');
  // Sortieren innerhalb der Anlage-Spalte ist kein Beginn
  await t.api(pl).post(`/tasks/${task.id}/move`, { columnId: col('Offen'), index: 0 });
  assert.equal((await t.db.one(`select started_at from tasks where id = $1`, [task.id])).started_at, null);
  // Wechsel nach „In Arbeit“ setzt den Arbeitsbeginn (auch über PATCH columnId)
  assert.equal((await t.api(pl).post(`/tasks/${task.id}/move`, { columnId: col('In Arbeit') })).statusCode, 200);
  assert.ok((await t.db.one(`select started_at from tasks where id = $1`, [task.id])).started_at);
  const other = (await t.api(pl).post(`/projects/${id}/tasks`, { title: 'Per PATCH', columnId: col('Offen') })).json().task;
  await t.api(pl).patch(`/tasks/${other.id}`, { columnId: col('In Prüfung') });
  assert.ok((await t.db.one(`select started_at from tasks where id = $1`, [other.id])).started_at, 'PATCH columnId setzt Arbeitsbeginn');
  const rows = await evaluateProject(t.db, id, day(8));
  const row = rows.find((r) => r.taskId === task.id);
  assert.ok(row && row.targetLevel === 1 && row.staleDays >= 7, JSON.stringify(row));
  await runEscalations(t.db, day(8));
  assert.equal((await t.db.one(`select escalation_level from tasks where id = $1`, [task.id])).escalation_level, 1);
});

test('Selbst angelegte Aufgabe: blockiert oder still → keine Eskalation, überfällig → Eskalation', async () => {
  const { evaluateProject } = await import('../src/tasks/escalation.js');
  const { id, col } = await freshProject('ESS');
  const anna = await t.login('anna@demo.local');
  const own = (await t.api(anna).post(`/projects/${id}/tasks`, { title: 'Eigene Notiz', columnId: col('Offen'), responsibleUserId: t.ids.users.anna })).json().task;
  await t.api(anna).post(`/tasks/${own.id}/move`, { columnId: col('In Arbeit') });
  assert.equal((await t.api(anna).patch(`/tasks/${own.id}`, { blocked: true, blockedReason: 'warte auf mich' })).statusCode, 200);
  assert.ok(!(await evaluateProject(t.db, id, day(30))).some((r) => r.taskId === own.id && r.targetLevel > 0), 'blockiert und 30 Tage still: keine Eskalation');
  assert.equal((await t.api(anna).get(`/tasks/${own.id}`)).json().task.blocked, true, 'Blockade bleibt sichtbar');
  await t.api(anna).patch(`/tasks/${own.id}`, { dueDate: day(1) });
  const row = (await evaluateProject(t.db, id, day(4))).find((r) => r.taskId === own.id);
  assert.ok(row && row.targetLevel === 1 && row.overdueDays === 3 && !row.selfOnly, JSON.stringify(row));
});

test('Aufgabe ohne Termin unter überfälligem Arbeitspaket: AP eskaliert, Aufgabe nicht doppelt; geerbter Termin zählt, wenn das AP erledigt ist', async () => {
  const { evaluateProject } = await import('../src/tasks/escalation.js');
  const { pl, id, col } = await freshProject('ESP');
  const ap = (await t.api(pl).post(`/projects/${id}/tasks`, { title: 'Arbeitspaket', columnId: col('In Arbeit'), dueDate: day(1), responsibleUserId: t.ids.users.max })).json().task;
  const child = (await t.api(pl).post(`/projects/${id}/tasks`, { title: 'Aufgabe ohne Termin', parentId: ap.id, responsibleUserId: t.ids.users.anna })).json().task;
  let rows = await evaluateProject(t.db, id, day(4));
  assert.ok(rows.find((r) => r.taskId === ap.id)?.targetLevel === 1, JSON.stringify(rows));
  assert.ok(!rows.some((r) => r.taskId === child.id), 'Aufgabe eskaliert nicht zusätzlich');
  await runEscalations(t.db, day(4));
  assert.equal((await t.db.one(`select escalation_level from tasks where id = $1`, [child.id])).escalation_level, 0);
  // AP erledigt, Aufgabe offen: jetzt trägt die Aufgabe den geerbten Termin
  await t.db.query(`update tasks set column_id = $2 where id = $1`, [ap.id, col('Erledigt')]);
  rows = await evaluateProject(t.db, id, day(4));
  const c = rows.find((r) => r.taskId === child.id);
  assert.ok(c && c.overdueDays === 3 && c.targetLevel === 1 && c.dueDate === day(1) && c.reason.includes('Termin des Arbeitspakets'), JSON.stringify(c));
});

test('Keine Eskalation an sich selbst: PL zuständig → einmalige Erinnerung; TP-Verantwortung zuständig → direkt an die PL', async () => {
  const { evaluateProject } = await import('../src/tasks/escalation.js');
  const { pl, id, col } = await freshProject('ESL');
  const task = (await t.api(pl).post(`/projects/${id}/tasks`, { title: 'Eigene PL-Aufgabe', columnId: col('In Arbeit'), dueDate: day(1), responsibleUserId: t.ids.users.pl })).json().task;
  const row = (await evaluateProject(t.db, id, day(8))).find((r) => r.taskId === task.id);
  assert.ok(row && row.selfOnly && row.targetLevel === 0, JSON.stringify(row));
  for (const d of [day(8), day(8), day(9)]) await runEscalations(t.db, d);
  assert.equal((await t.db.one(`select escalation_level from tasks where id = $1`, [task.id])).escalation_level, 0, 'keine Stufe');
  const notes = (await t.api(pl).get('/notifications')).json().notifications.filter((n: any) => n.title.includes('Eigene PL-Aufgabe'));
  assert.equal(notes.filter((n: any) => n.type === 'task.reminder').length, 1, JSON.stringify(notes));
  assert.ok(!notes.some((n: any) => n.type === 'escalation'), 'keine Eskalationsmeldung an sich selbst');
  const log = (await t.db.query(`select body from task_comments where task_id = $1 and source = 'system'`, [task.id])).rows;
  assert.equal(log.filter((c: any) => c.body.startsWith('Erinnerung statt Eskalation')).length, 1, 'Log-Eintrag nur einmal');
  assert.ok(!log.some((c: any) => c.body.startsWith('Eskalation')));
  // Grund entfällt → nächster Anlass erinnert wieder
  await t.api(pl).patch(`/tasks/${task.id}`, { dueDate: day(30) });
  await runEscalations(t.db, day(9));
  assert.equal((await t.db.one(`select escalation_reminded_at from tasks where id = $1`, [task.id])).escalation_reminded_at, null);

  // TP-Verantwortung (Max, Konzept & Design im Demoprojekt) selbst zuständig: Stufe 1 wäre sie selbst → gleich Stufe 2 (PL)
  const detail = (await t.api(pl).get(`/projects/${t.ids.projects.web}`)).json();
  const konzept = detail.subprojects.find((s: any) => s.name.startsWith('Konzept'));
  const tp = (await t.api(pl).post(`/projects/${t.ids.projects.web}/tasks`, { title: 'TP-eigene Aufgabe', subprojectId: konzept.id, dueDate: day(1), responsibleUserId: t.ids.users.max })).json().task;
  const tpRow = (await evaluateProject(t.db, t.ids.projects.web, day(4))).find((r) => r.taskId === tp.id);
  assert.ok(tpRow && tpRow.targetLevel === 2 && !tpRow.selfOnly, JSON.stringify(tpRow));
});

test('Migration 082: Eskalation in persönlichen Projekten aus, PL kann sie einschalten; Backfill des Arbeitsbeginns', async () => {
  const { readFile } = await import('node:fs/promises');
  const pl = await t.login('pl@demo.local');
  const { id, col } = await freshProject('ESM');
  const pers = await t.db.one(`insert into projects (org_id, key, name, created_by, personal, escalation) values ($1,'ESMP','Persönlich ESM',$2,true,'{"enabled":true}'::jsonb) returning id`, [t.ids.org, t.ids.users.pl]);
  await t.db.query(`insert into project_members (project_id, user_id, role) values ($1,$2,'pl')`, [pers.id, t.ids.users.pl]);
  const quiet = (await t.api(pl).post(`/projects/${id}/tasks`, { title: 'Unberührt', columnId: col('Offen') })).json().task;
  const talked = (await t.api(pl).post(`/projects/${id}/tasks`, { title: 'Mit Log', columnId: col('Offen') })).json().task;
  await t.api(pl).post(`/tasks/${talked.id}/comments`, { body: 'Schon angefangen' });
  const inWork = (await t.api(pl).post(`/projects/${id}/tasks`, { title: 'In Arbeit angelegt', columnId: col('In Arbeit') })).json().task;
  await t.db.query(`update tasks set started_at = null where project_id = $1`, [id]);
  await t.db.exec(await readFile(new URL('../migrations/082_task_started_escalation.sql', import.meta.url), 'utf8'));
  const started = async (tid: string) => (await t.db.one(`select started_at from tasks where id = $1`, [tid])).started_at;
  assert.equal(await started(quiet.id), null);
  assert.ok(await started(talked.id), 'Log-Aktivität → begonnen');
  assert.ok(await started(inWork.id), 'außerhalb der Anlage-Spalte → begonnen');
  assert.equal((await t.db.one(`select escalation from projects where id = $1`, [pers.id])).escalation.enabled, false);
  assert.equal((await t.db.one(`select escalation from projects where id = $1`, [id])).escalation?.enabled ?? true, true, 'normale Projekte unverändert');
  const on = await t.api(pl).patch(`/projects/${pers.id}`, { escalation: { enabled: true } });
  assert.equal(on.statusCode, 200, on.body);
  assert.equal((await t.db.one(`select escalation from projects where id = $1`, [pers.id])).escalation.enabled, true);
});
