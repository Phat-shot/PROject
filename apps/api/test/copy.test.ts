import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';

const t = await testApp();
test.after(() => t.close());

test('Arbeitspaket kopieren: im Projekt mit allem; in anderes Projekt nur mit ausgewählten Teilen; Rechte im Ziel', async () => {
  const pl = await t.login('pl@demo.local');
  const anna = await t.login('anna@demo.local');
  const web = t.ids.projects.web;
  const erp = t.ids.projects.erp;
  const src = (await t.api(pl).get(`/tasks/${t.ids.tasks.t4}`)).json().task;
  await t.api(pl).post(`/tasks/${src.id}/checklist`, { title: 'Preis vergleichen' });
  await t.api(pl).post(`/tasks/${src.id}/comments`, { body: 'Angebot liegt vor.' });
  const items = await t.db.query(`select id from checklist_items where task_id = $1`, [src.id]);
  await t.db.query(`update checklist_items set done = true where id = $1`, [items.rows[0].id]);

  // Im selben Projekt: alles
  const c1 = await t.api(pl).post(`/tasks/${src.id}/copy`, {});
  assert.equal(c1.statusCode, 200, c1.body);
  const k = c1.json().task;
  assert.equal(k.title, `${src.title} (Kopie)`);
  assert.equal(k.projectId, web);
  assert.notEqual(k.number, src.number);
  assert.notEqual(k.mailCode, src.mailCode);
  assert.equal(k.subprojectId, src.subprojectId);
  assert.equal(k.dueDate, src.dueDate);
  assert.equal(k.responsibleUserId, src.responsibleUserId);
  assert.deepEqual([...k.labelIds].sort(), [...src.labelIds].sort());
  assert.equal(k.checklistTotal, items.rows.length);
  assert.equal(k.checklistDone, 0, 'Tasks werden offen kopiert');
  assert.equal(k.commentCount, src.commentCount + 1);
  assert.deepEqual(k.predecessorIds, src.predecessorIds, 'Vorgänger bleiben im selben Projekt');

  // In anderes Projekt: Petra ist dort nur Mitglied ohne Planrecht
  const forbidden = await t.api(pl).post(`/tasks/${src.id}/copy`, { targetProjectId: erp });
  assert.equal(forbidden.statusCode, 403);
  // Anna ist PL in ERP: nur Checkliste und Termine, Zuständigkeit und Labels nicht
  const c2 = await t.api(anna).post(`/tasks/${src.id}/copy`, { targetProjectId: erp, parts: ['checklist', 'dates'] });
  assert.equal(c2.statusCode, 200, c2.body);
  const k2 = c2.json().task;
  assert.equal(c2.json().projectKey, 'ERP');
  assert.equal(k2.projectId, erp);
  assert.equal(k2.title, src.title);
  assert.equal(k2.number, 4, 'nächste Nummer im Zielprojekt');
  assert.equal(k2.responsibleUserId, null);
  assert.deepEqual(k2.labelIds, []);
  assert.equal(k2.commentCount, 0);
  assert.equal(k2.checklistTotal, items.rows.length);
  assert.equal(k2.dueDate, src.dueDate);
  assert.deepEqual(k2.predecessorIds, []);
  const col = await t.db.one(`select name from board_columns where id = $1`, [k2.columnId]);
  assert.equal(col.name, 'Backlog', 'keine gleichnamige Spalte → erste Spalte');
  // Mit Labels: gleichnamiges Label wird im Ziel angelegt
  const c3 = await t.api(anna).post(`/tasks/${src.id}/copy`, { targetProjectId: erp, parts: ['labels', 'responsible'] });
  const k3 = c3.json().task;
  assert.equal(k3.labelIds.length, src.labelIds.length);
  const names = await t.db.query(`select l.name from task_labels tl join labels l on l.id = tl.label_id where tl.task_id = $1 order by l.name`, [k3.id]);
  const srcNames = await t.db.query(`select l.name from task_labels tl join labels l on l.id = tl.label_id where tl.task_id = $1 order by l.name`, [src.id]);
  assert.deepEqual(names.rows.map((x: any) => x.name), srcNames.rows.map((x: any) => x.name));
  assert.equal(k3.responsibleUserId, src.responsibleUserId, 'Petra ist Mitglied in ERP, Zuständigkeit bleibt');
});

test('Arbeitspaket in anderes Projekt verschieben: Nummer neu, Spalte abgeglichen, Historie bleibt, Abhängigkeiten nach außen fallen weg', async () => {
  const pl = await t.login('pl@demo.local');
  const anna = await t.login('anna@demo.local');
  const web = t.ids.projects.web;
  const erp = t.ids.projects.erp;
  const created = (await t.api(pl).post(`/projects/${web}/tasks`, { title: 'Wandert nach ERP', responsibleUserId: t.ids.users.leser, predecessorIds: [t.ids.tasks.t2], columnId: (await t.db.one(`select id from board_columns where project_id = $1 and name = 'In Arbeit'`, [web])).id })).json().task;
  await t.api(pl).post(`/tasks/${created.id}/comments`, { body: 'Historie' });
  assert.equal((await t.api(pl).post(`/tasks/${created.id}/move-to-project`, { targetProjectId: erp })).statusCode, 403, 'Petra ohne Planrecht in ERP');
  assert.equal((await t.api(anna).post(`/tasks/${created.id}/move-to-project`, { targetProjectId: web })).statusCode, 400, 'gleiches Projekt');
  const r = await t.api(anna).post(`/tasks/${created.id}/move-to-project`, { targetProjectId: erp, parts: ['checklist', 'comments', 'responsible', 'dates', 'labels', 'dependencies'] });
  assert.equal(r.statusCode, 200, r.body);
  const m = r.json().task;
  assert.equal(m.id, created.id, 'gleiche ID, Links bleiben gültig');
  assert.equal(m.projectId, erp);
  assert.equal(m.number, 6);
  assert.equal(m.responsibleUserId, null, 'Leser ist in ERP kein Mitglied');
  assert.deepEqual(m.predecessorIds, [], 'Vorgänger im Quellprojekt entfällt');
  assert.ok(m.commentCount >= 2, 'Historie plus Verschiebe-Vermerk');
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and source = 'system' and body like 'Aus Projekt WEB-% hierher verschoben'`, [created.id]));
  assert.equal((await t.api(pl).get(`/projects/${web}/tasks`)).json().tasks.some((x: any) => x.id === created.id), false);
  assert.ok((await t.api(anna).get(`/projects/${erp}/tasks`)).json().tasks.some((x: any) => x.id === created.id));
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'task.move_project' and project_id = $1`, [web]));
});

test('Teilprojekt kopieren mit ausgewählten Arbeitspaketen und Meilensteinen; verschieben in anderes Projekt lässt abgewählte Arbeitspakete zurück', async () => {
  const pl = await t.login('pl@demo.local');
  const anna = await t.login('anna@demo.local');
  const max = await t.login('max@demo.local');
  const web = t.ids.projects.web;
  const erp = t.ids.projects.erp;
  const sp = (await t.api(pl).get(`/projects/${web}`)).json().subprojects.find((s: any) => s.name === 'Konzept & Design');
  const spTasks = (await t.api(pl).get(`/projects/${web}/tasks`)).json().tasks.filter((x: any) => x.subprojectId === sp.id && !x.archivedAt);
  assert.ok(spTasks.length >= 2);
  // Kopie im Projekt: nur ein Arbeitspaket, mit Meilensteinen, ohne Termine
  const c = await t.api(max).post(`/projects/${web}/subprojects/${sp.id}/copy`, { parts: ['tasks', 'milestones', 'checklist', 'labels'], taskIds: [spTasks[0].id] });
  assert.equal(c.statusCode, 200, c.body);
  assert.equal(c.json().tasks, 1);
  const ns = c.json().subproject;
  assert.equal(ns.name, 'Konzept & Design (Kopie)');
  assert.equal(ns.startDate, null);
  assert.equal(ns.responsibleUserId, null);
  const copied = (await t.api(pl).get(`/projects/${web}/tasks`)).json().tasks.filter((x: any) => x.subprojectId === ns.id);
  assert.equal(copied.length, 1);
  assert.equal(copied[0].title, spTasks[0].title);
  assert.equal(copied[0].dueDate, null, 'Termine abgewählt');
  const ms = await t.db.query(`select name from milestones where subproject_id = $1`, [ns.id]);
  assert.deepEqual(ms.rows.map((x: any) => x.name), ['Design-Freigabe']);
  const reader = await t.login('leser@demo.local');
  assert.equal((await t.api(reader).post(`/projects/${web}/subprojects/${sp.id}/copy`, {})).statusCode, 403);

  // Verschieben nach ERP (Anna: PL dort): ein Arbeitspaket bleibt zurück, ohne Teilprojekt
  const keep = spTasks[0]; const stay = spTasks[1];
  const mv = await t.api(anna).post(`/projects/${web}/subprojects/${sp.id}/move-to-project`, { targetProjectId: erp, taskIds: [keep.id], parts: ['tasks', 'milestones', 'dates', 'responsible', 'checklist', 'comments', 'labels', 'dependencies'] });
  assert.equal(mv.statusCode, 200, mv.body);
  assert.equal(mv.json().tasks, 1);
  const erpDetail = (await t.api(anna).get(`/projects/${erp}`)).json();
  const moved = erpDetail.subprojects.find((s: any) => s.id === sp.id);
  assert.ok(moved, 'Teilprojekt jetzt in ERP');
  assert.equal(moved.responsibleUserId, t.ids.users.max, 'Max ist Mitglied in ERP');
  assert.ok(erpDetail.milestones.some((m: any) => m.name === 'Design-Freigabe' && m.subprojectId === sp.id));
  const erpTasks = (await t.api(anna).get(`/projects/${erp}/tasks`)).json().tasks;
  assert.ok(erpTasks.some((x: any) => x.id === keep.id && x.subprojectId === sp.id));
  const left = (await t.api(pl).get(`/tasks/${stay.id}`)).json().task;
  assert.equal(left.projectId, web);
  assert.equal(left.subprojectId, null, 'abgewähltes Arbeitspaket bleibt ohne Teilprojekt');
  const webDetail = (await t.api(pl).get(`/projects/${web}`)).json();
  assert.equal(webDetail.subprojects.some((s: any) => s.id === sp.id), false);
});
