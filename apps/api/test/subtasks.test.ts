import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';

const t = await testApp();
test.after(() => t.close());

test('Aufgabe: hängt am Arbeitspaket, erbt Zuständigkeit und Teilprojekt, eigenes Log, eine Ebene tief', async () => {
  const pl = await t.login('pl@demo.local');
  const web = t.ids.projects.web;
  const sp = (await t.db.one(`select id from subprojects where project_id = $1 and not restricted order by position limit 1`, [web])).id;
  const ap = (await t.api(pl).post(`/projects/${web}/tasks`, { title: 'AP mit Aufgaben', subprojectId: sp, responsibleUserId: t.ids.users.anna })).json().task;
  const r = await t.api(pl).post(`/projects/${web}/tasks`, { title: 'Texte liefern', parentId: ap.id });
  assert.equal(r.statusCode, 200, r.body);
  const a = r.json().task;
  assert.equal(a.parentId, ap.id);
  assert.equal(a.parent.title, 'AP mit Aufgaben');
  assert.equal(a.subprojectId, ap.subprojectId, 'Teilprojekt folgt dem Arbeitspaket');
  assert.equal(a.responsible.inherited, true);
  assert.equal(a.responsible.inheritedFrom, 'task');
  assert.equal(a.responsible.userId, t.ids.users.anna);
  assert.ok(a.number > ap.number, 'eigene Kennung');

  // Eigenes Log und eigene Zuständigkeit
  const c = await t.api(pl).post(`/tasks/${a.id}/comments`, { body: 'Erster Stand' });
  assert.equal(c.statusCode, 200);
  const p = await t.api(pl).patch(`/tasks/${a.id}`, { responsibleUserId: t.ids.users.max });
  assert.equal(p.json().task.responsible.inherited, false);

  // Detail des Arbeitspakets listet die Aufgabe, Zähler am Arbeitspaket
  const d = (await t.api(pl).get(`/tasks/${ap.id}`)).json();
  assert.equal(d.subtasks.length, 1);
  assert.equal(d.subtasks[0].id, a.id);
  assert.equal(d.task.subtaskTotal, 1);
  assert.equal(d.task.subtaskDone, 0);
  assert.ok(d.comments.some((x: any) => x.body.includes('Aufgabe angelegt')), 'Anlage im Log des Arbeitspakets');
  const done = await t.db.one(`select id from board_columns where project_id = $1 and is_done order by position limit 1`, [web]);
  await t.api(pl).patch(`/tasks/${a.id}`, { columnId: done.id });
  assert.equal((await t.api(pl).get(`/tasks/${ap.id}`)).json().task.subtaskDone, 1);

  // Keine zweite Ebene, kein fremdes Projekt
  const deep = await t.api(pl).post(`/projects/${web}/tasks`, { title: 'zu tief', parentId: a.id });
  assert.equal(deep.statusCode, 400);
  const foreign = await t.api(pl).post(`/projects/${t.ids.projects.erp}/tasks`, { title: 'fremd', parentId: ap.id });
  assert.equal(foreign.statusCode, 400);

  // Teilprojekt-Wechsel am Arbeitspaket nimmt die Aufgabe mit, an der Aufgabe selbst wird er ignoriert
  await t.api(pl).patch(`/tasks/${ap.id}`, { subprojectId: null });
  assert.equal((await t.api(pl).get(`/tasks/${a.id}`)).json().task.subprojectId, null);
  await t.api(pl).patch(`/tasks/${a.id}`, { subprojectId: sp });
  assert.equal((await t.api(pl).get(`/tasks/${a.id}`)).json().task.subprojectId, null);

  // Portfolio und Projektliste zählen nur Arbeitspakete
  const list = (await t.api(pl).get('/projects')).json().projects.find((x: any) => x.id === web);
  const top = await t.db.one(`select count(*)::int as n from tasks t join board_columns c on c.id = t.column_id where t.project_id = $1 and t.parent_id is null and t.archived_at is null and not c.is_done`, [web]);
  assert.equal(list.stats.open, top.n);
});

test('Aufgabe: Archiv und Papierkorb gehen mit dem Arbeitspaket, Kopie und Verschieben nehmen Aufgaben mit', async () => {
  const pl = await t.login('pl@demo.local');
  const anna = await t.login('anna@demo.local');
  const web = t.ids.projects.web;
  const erp = t.ids.projects.erp;
  const ap = (await t.api(pl).post(`/projects/${web}/tasks`, { title: 'AP Kaskade' })).json().task;
  const a = (await t.api(pl).post(`/projects/${web}/tasks`, { title: 'Aufgabe Kaskade', parentId: ap.id })).json().task;

  await t.api(pl).post(`/tasks/${ap.id}/archive`);
  assert.ok((await t.api(pl).get(`/tasks/${a.id}`)).json().task.archivedAt);
  await t.api(pl).post(`/tasks/${ap.id}/unarchive`);
  assert.equal((await t.api(pl).get(`/tasks/${a.id}`)).json().task.archivedAt, null);

  await t.api(pl).del(`/tasks/${ap.id}`);
  assert.ok((await t.api(pl).get(`/tasks/${a.id}`)).json().task.deletedAt);
  const trash = (await t.api(pl).get(`/projects/${web}/trash`)).json();
  assert.ok(trash.tasks.some((x: any) => x.id === ap.id));
  assert.ok(!trash.tasks.some((x: any) => x.id === a.id), 'Aufgabe steht nicht einzeln im Papierkorb');
  await t.api(pl).post(`/tasks/${ap.id}/restore`);
  assert.equal((await t.api(pl).get(`/tasks/${a.id}`)).json().task.deletedAt, null);

  // Kopie im Projekt: Aufgabe kommt mit, hängt an der Kopie
  const k = (await t.api(pl).post(`/tasks/${ap.id}/copy`, {})).json().task;
  assert.equal(k.subtaskTotal, 1);
  const kd = (await t.api(pl).get(`/tasks/${k.id}`)).json();
  assert.equal(kd.subtasks[0].title, 'Aufgabe Kaskade');
  assert.notEqual(kd.subtasks[0].id, a.id);
  // Ohne Teil „Aufgaben“ keine Aufgabe
  const k2 = (await t.api(pl).post(`/tasks/${ap.id}/copy`, { parts: ['checklist'] })).json().task;
  assert.equal(k2.subtaskTotal, 0);
  // Kopie einer Aufgabe bleibt am selben Arbeitspaket
  const ak = (await t.api(pl).post(`/tasks/${a.id}/copy`, {})).json().task;
  assert.equal(ak.parentId, ap.id);

  // Verschieben ins andere Projekt: Aufgaben gehen immer mit
  const mv = await t.api(anna).post(`/tasks/${ap.id}/move-to-project`, { targetProjectId: erp, parts: ['comments'] });
  assert.equal(mv.statusCode, 200, mv.body);
  const moved = (await t.api(anna).get(`/tasks/${a.id}`)).json().task;
  assert.equal(moved.projectId, erp);
  assert.equal(moved.parentId, ap.id);
  assert.equal((await t.api(anna).get(`/tasks/${ap.id}`)).json().subtasks.length, 2);
});
