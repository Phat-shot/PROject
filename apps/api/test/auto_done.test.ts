import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyItem, testApp } from './helpers.js';

/** Checklistenpunkte gehören zu Aufgaben; Aufgabe erledigt sich mit dem letzten Punkt, das Arbeitspaket mit der letzten Aufgabe. */
const t = await testApp();
test.after(() => t.close());

const web = () => t.ids.projects.web;
const logOf = async (id: string) => (await t.db.query(`select body from task_comments where task_id = $1 order by created_at`, [id])).rows.map((r: any) => String(r.body));
const col = async (name: string) => (await t.db.one(`select id from board_columns where project_id = $1 and name = $2`, [web(), name])).id as string;
const doneCol = async () => (await t.db.one(`select id from board_columns where project_id = $1 and is_done order by position limit 1`, [web()])).id as string;

async function aufgabe(pl: Record<string, string>, apId: string, title: string, items: string[]) {
  const a = (await t.api(pl).post(`/projects/${web()}/tasks`, { title, parentId: apId })).json().task;
  for (const it of items) await t.api(pl).post(`/tasks/${a.id}/checklist`, { title: it });
  return (await t.api(pl).get(`/tasks/${a.id}`)).json().task;
}
const check = (pl: Record<string, string>, taskId: string, itemId: string, done: boolean) => t.api(pl).patch(`/tasks/${taskId}/checklist/${itemId}`, { done });

test('Letzter Checklistenpunkt erledigt: Aufgabe erledigt (Log, Meldung), letzte Aufgabe: Arbeitspaket erledigt; Punkt wieder offen: Aufgabe zurück in die vorherige Spalte', async () => {
  const pl = await t.login('pl@demo.local');
  assert.equal((await t.api(pl).get(`/projects/${web()}`)).json().project.autoDoneAufgabe, true, 'Standard an');
  const ap = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Umzug Büro', responsibleUserId: t.ids.users.anna })).json().task;
  const a1 = await aufgabe(pl, ap.id, 'Kisten packen', ['Akten', 'Technik']);
  const a2 = await aufgabe(pl, ap.id, 'Transport', ['LKW buchen']);
  const inArbeit = await col('In Arbeit');
  await t.api(pl).patch(`/tasks/${a1.id}`, { columnId: inArbeit });

  let r = await check(pl, a1.id, a1.checklist[0].id, true);
  assert.equal(r.json().task.done, false, 'ein Punkt offen: Aufgabe offen');
  r = await check(pl, a1.id, a1.checklist[1].id, true);
  assert.equal(r.statusCode, 200, r.body);
  let x = r.json().task;
  assert.equal(x.done, true, 'letzter Punkt: Aufgabe erledigt');
  assert.ok(x.autoDoneAt);
  assert.ok((await logOf(a1.id)).some((b) => b.startsWith('Automatisch erledigt: alle Checklistenpunkte erledigt (Status → ')));
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and ref_id = $2 and type = 'task.auto_done'`, [t.ids.users.anna, a1.id]), 'Zuständige (geerbt vom AP) informiert');
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'task.move' and object_id = $1 and details->>'auto' = 'all_items_done'`, [a1.id]));
  assert.equal((await t.api(pl).get(`/tasks/${ap.id}`)).json().task.done, false, 'AP offen, solange eine Aufgabe offen ist');

  // Kette: letzte Aufgabe erledigt → Arbeitspaket erledigt
  r = await check(pl, a2.id, a2.checklist[0].id, true);
  assert.equal(r.json().task.done, true);
  assert.equal((await t.api(pl).get(`/tasks/${ap.id}`)).json().task.done, true, 'AP automatisch erledigt');
  assert.ok((await logOf(ap.id)).some((b) => b.startsWith('Automatisch erledigt: alle Aufgaben sind erledigt')));

  // Punkt wieder öffnen: Aufgabe zurück in „In Arbeit“
  r = await check(pl, a1.id, a1.checklist[0].id, false);
  x = r.json().task;
  assert.equal(x.done, false); assert.equal(x.columnId, inArbeit, 'zurück in die vorherige Spalte'); assert.equal(x.autoDoneAt, null);
  assert.ok((await logOf(a1.id)).some((b) => b === 'Wieder offen: Checklistenpunkt „Akten“ ist offen (Status → In Arbeit)'));
  // Neuer offener Punkt an einer automatisch erledigten Aufgabe: ohne gemerkte Spalte die erste aktive
  await t.db.query(`update tasks set auto_done_from_column_id = null where id = $1`, [a2.id]);
  r = await t.api(pl).post(`/tasks/${a2.id}/checklist`, { title: 'Schlüssel abholen' });
  assert.equal(r.json().task.done, false);
  const firstActive = (await t.db.one(`select id from board_columns where project_id = $1 and kind = 'active' and not is_done order by position limit 1`, [web()])).id;
  assert.equal(r.json().task.columnId, firstActive);
});

test('Einstellung aus: nichts; je Aufgabe übersteuerbar (autoComplete bzw. autoDone); von Hand erledigt mit offenen Punkten bleibt erledigt', async () => {
  const pl = await t.login('pl@demo.local');
  const ap = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Messe vorbereiten' })).json().task;
  assert.equal((await t.api(pl).patch(`/projects/${web()}`, { autoDoneAufgabe: 'ja' })).statusCode, 400);
  assert.equal((await t.api(pl).patch(`/projects/${web()}`, { autoDoneAufgabe: false })).json().project.autoDoneAufgabe, false);
  const b = await aufgabe(pl, ap.id, 'Stand', ['Wand bestellen']);
  let r = await check(pl, b.id, b.checklist[0].id, true);
  assert.equal(r.json().task.done, false, 'Projekt-Einstellung aus');
  // Je Aufgabe an: schon alle Punkte erledigt → sofort erledigt
  r = await t.api(pl).patch(`/tasks/${b.id}`, { autoComplete: true });
  assert.equal(r.json().task.done, true, 'Übersteuerung je Aufgabe');
  await t.api(pl).patch(`/projects/${web()}`, { autoDoneAufgabe: true });
  // Je Aufgabe aus (Alias autoDone) bei Projekt an
  const c = await aufgabe(pl, ap.id, 'Flyer', ['Text']);
  assert.equal((await t.api(pl).patch(`/tasks/${c.id}`, { autoDone: false })).json().task.autoComplete, false);
  assert.equal((await check(pl, c.id, c.checklist[0].id, true)).json().task.done, false);

  // Von Hand erledigt mit offenen Punkten: Punkte bleiben, Aufgabe bleibt erledigt, auch beim Abhaken und Öffnen
  const d = await aufgabe(pl, ap.id, 'Catering', ['Angebot', 'Bestellung']);
  await t.api(pl).patch(`/tasks/${d.id}`, { columnId: await doneCol() });
  r = await check(pl, d.id, d.checklist[0].id, true);
  assert.equal(r.json().task.done, true); assert.equal(r.json().task.checklistTotal, 2); assert.equal(r.json().task.autoDoneAt, null);
  r = await check(pl, d.id, d.checklist[0].id, false);
  assert.equal(r.json().task.done, true, 'von Hand erledigt: kein Zurückholen');
  // Automatisch erledigt, dann von Hand verschoben und wieder erledigt: zählt als von Hand
  const e = await aufgabe(pl, ap.id, 'Anreise', ['Bahn']);
  assert.equal((await check(pl, e.id, e.checklist[0].id, true)).json().task.autoDoneAt != null, true);
  await t.api(pl).post(`/tasks/${e.id}/move`, { columnId: await col('In Arbeit') });
  await t.api(pl).patch(`/tasks/${e.id}`, { columnId: await doneCol() });
  r = await check(pl, e.id, e.checklist[0].id, false);
  assert.equal(r.json().task.done, true);
});

test('Arbeitspaket ohne Checkliste: POST 400, Altbestand bleibt abhakbar und löschbar, convert überführt ihn in eine Aufgabe', async () => {
  const pl = await t.login('pl@demo.local');
  const ap = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Altes AP' })).json().task;
  const no = await t.api(pl).post(`/tasks/${ap.id}/checklist`, { title: 'neu' });
  assert.equal(no.statusCode, 400);
  assert.equal(no.json().error, 'Checklistenpunkte gehören zu Aufgaben. Lege eine Aufgabe an oder wandle vorhandene Punkte um.');
  const i1 = await legacyItem(t.db, ap.id, 'Alt eins');
  const i2 = await legacyItem(t.db, ap.id, 'Alt zwei');
  const i3 = await legacyItem(t.db, ap.id, 'Alt drei');
  let r = await t.api(pl).patch(`/tasks/${ap.id}/checklist/${i1}`, { done: true });
  assert.equal(r.statusCode, 200); assert.equal(r.json().task.checklistDone, 1);
  assert.equal(r.json().task.done, false, 'keine Automatik am Arbeitspaket');
  assert.equal((await t.api(pl).del(`/tasks/${ap.id}/checklist/${i3}`)).statusCode, 200);
  // Kennzahl: offene Checklistenpunkte zählen weiter alle (Altbestand und Aufgaben)
  assert.equal((await t.api(pl).get(`/tasks/${ap.id}`)).json().task.checklistTotal, 2);

  r = await t.api(pl).post(`/tasks/${ap.id}/checklist/convert`, { title: 'Vorbereitung' });
  assert.equal(r.statusCode, 200, r.body);
  const a = r.json().aufgabe;
  assert.equal(a.parentId, ap.id); assert.equal(a.title, 'Vorbereitung'); assert.equal(a.checklistTotal, 2); assert.equal(a.checklistDone, 1);
  assert.equal(r.json().task.checklistTotal, 0);
  assert.deepEqual((await t.api(pl).get(`/tasks/${a.id}`)).json().task.checklist.map((i: any) => i.id), [i1, i2]);
  assert.ok((await logOf(ap.id)).some((b) => b.startsWith('2 Checklistenpunkte in die Aufgabe WEB-') && b.includes('„Vorbereitung“')));
  assert.ok((await logOf(a.id)).some((b) => b.startsWith('Entstanden aus der Checkliste von WEB-')));
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'checklist.convert' and object_id = $1`, [a.id]));
  assert.equal((await t.api(pl).post(`/tasks/${ap.id}/checklist/convert`, {})).statusCode, 400, 'keine Punkte mehr');
  assert.equal((await t.api(pl).post(`/tasks/${a.id}/checklist/convert`, {})).statusCode, 400, 'nur am Arbeitspaket');
  // Ohne Titel: „Checkliste“; die Aufgabe erledigt sich danach mit ihrem letzten Punkt
  const ap2 = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Altes AP 2' })).json().task;
  await legacyItem(t.db, ap2.id, 'Eins');
  const c = (await t.api(pl).post(`/tasks/${ap2.id}/checklist/convert`)).json().aufgabe;
  assert.equal(c.title, 'Checkliste');
  const it = (await t.api(pl).get(`/tasks/${c.id}`)).json().task.checklist[0];
  assert.equal((await check(pl, c.id, it.id, true)).json().task.done, true);
  assert.equal((await t.api(pl).get(`/tasks/${ap2.id}`)).json().task.done, true, 'und mit ihr das Arbeitspaket');
  // Leser dürfen nicht
  const leser = await t.login('leser@demo.local');
  const ap3 = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Altes AP 3' })).json().task;
  await legacyItem(t.db, ap3.id, 'Eins');
  assert.equal((await t.api(leser).post(`/tasks/${ap3.id}/checklist/convert`)).statusCode, 403);
});
