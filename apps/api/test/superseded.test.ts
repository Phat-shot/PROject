import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { notify, supersedeStaleNotifications } from '../src/notify.js';
import { supersedeDrafts } from '../src/ai/agent.js';

const t = await testApp();
test.after(() => t.close());

test('Überholtes wird verworfen: neuere Meldung zum selben AP, Entwurf an dieselben Empfänger, Eskalation nach Erledigt', async () => {
  const pl = await t.login('pl@demo.local');
  const web = t.ids.projects.web;
  const task = await t.db.one(`select t.id, t.project_id from tasks t join board_columns c on c.id = t.column_id where t.project_id = $1 and t.parent_id is null and t.deleted_at is null and t.archived_at is null and not c.is_done order by t.number limit 1`, [web]);
  const other = await t.db.one(`select t.id from tasks t where t.project_id = $1 and t.parent_id is null and t.deleted_at is null and t.id <> $2 order by t.number limit 1`, [web, task.id]);
  const uid = t.ids.users.pl;
  // Zwischenstand: der neuere ersetzt den älteren zum selben AP, ein anderes AP bleibt
  const n1 = await notify(t.db, { userId: uid, projectId: web, type: 'task.progress', title: 'Zwischenstand alt', ref: { type: 'task', id: task.id } });
  const n2 = await notify(t.db, { userId: uid, projectId: web, type: 'task.progress', title: 'Zwischenstand anderes AP', ref: { type: 'task', id: other.id } });
  const n3 = await notify(t.db, { userId: uid, projectId: web, type: 'task.progress', title: 'Zwischenstand neu', ref: { type: 'task', id: task.id } });
  const list = (await t.api(pl).get('/notifications')).json();
  const ids = list.notifications.map((n: any) => n.id);
  assert.ok(!ids.includes(n1) && ids.includes(n2) && ids.includes(n3), 'alter Zwischenstand ausgeblendet');
  assert.ok((await t.db.one(`select read_at, superseded_at from notifications where id = $1`, [n1])).superseded_at);
  // Andere Art zum selben AP bleibt
  const info = await notify(t.db, { userId: uid, projectId: web, type: 'task.assigned', title: 'Zugewiesen', ref: { type: 'task', id: task.id } });
  await notify(t.db, { userId: uid, projectId: web, type: 'task.assigned', title: 'Zugewiesen 2', ref: { type: 'task', id: task.id } });
  assert.equal((await t.db.one(`select superseded_at from notifications where id = $1`, [info])).superseded_at, null);

  // Entwürfe: gleiche Empfänger (Groß-/Kleinschreibung, Reihenfolge egal) werden ersetzt, andere Empfänger und PDF-Lieferungen nicht
  const acc = await t.db.one(`select id from mail_accounts limit 1`);
  const agent = (await t.db.one(`insert into users (org_id, email, name, kind, password_hash) values ($1, 'agent-sup@demo.local', 'Supi', 'agent', '') returning id`, [t.ids.org])).id;
  const draft = (to: string[], status = 'pending_approval') => t.db.one(`insert into mail_drafts (account_id, task_id, project_id, user_id, to_addrs, cc_addrs, subject, body, status) values ($1,$2,$3,$4,$5,'[]','Termin','Text',$6) returning id`, [acc.id, task.id, web, agent, JSON.stringify(to), status]).then((r) => r.id as string);
  const old1 = await draft(['Sven@Airgpu.example', 'b@x.example']);
  const old2 = await draft(['sven@airgpu.example', 'b@x.example'], 'scheduled');
  const keepOther = await draft(['other@x.example']);
  const sent = await draft(['sven@airgpu.example', 'b@x.example'], 'sent');
  const fresh = await draft(['b@x.example', 'sven@airgpu.example']);
  assert.equal(await supersedeDrafts(t.db, { taskId: task.id, projectId: web, orgId: t.ids.org, authorId: agent, to: ['b@x.example', 'sven@airgpu.example'], keepId: fresh }), 2);
  const left = (await t.db.query(`select id from mail_drafts where task_id = $1 and user_id = $2`, [task.id, agent])).rows.map((r: any) => r.id).sort();
  assert.deepEqual(left, [keepOther, sent, fresh].sort());
  assert.ok(!left.includes(old1) && !left.includes(old2));
  assert.equal((await t.db.one(`select count(*)::int as n from task_comments where task_id = $1 and body like 'Älterer Entwurf an % verworfen (überholt): „Termin“'`, [task.id])).n, 2);

  // Entwurf zur Freigabe ohne wartenden Entwurf und Eskalation eines erledigten AP: der Worker blendet sie aus
  const rv = await notify(t.db, { userId: uid, projectId: web, type: 'draft.review', title: 'Mail-Entwurf zur Freigabe', ref: { type: 'task', id: other.id } });
  const esc = await notify(t.db, { userId: uid, projectId: web, type: 'escalation', title: 'Eskalation Stufe 1', ref: { type: 'task', id: task.id } });
  const rvLive = await notify(t.db, { userId: uid, projectId: web, type: 'draft.review', title: 'Mail-Entwurf zur Freigabe', ref: { type: 'task', id: task.id } });
  await supersedeStaleNotifications(t.db);
  assert.ok((await t.db.one(`select superseded_at from notifications where id = $1`, [rv])).superseded_at, 'kein wartender Entwurf mehr');
  assert.equal((await t.db.one(`select superseded_at from notifications where id = $1`, [rvLive])).superseded_at, null, 'Entwurf wartet noch');
  assert.equal((await t.db.one(`select superseded_at from notifications where id = $1`, [esc])).superseded_at, null, 'AP noch offen');
  const done = await t.db.one(`select id from board_columns where project_id = $1 and is_done limit 1`, [web]);
  await t.db.query(`update tasks set column_id = $2 where id = $1`, [task.id, done.id]);
  await supersedeStaleNotifications(t.db);
  assert.ok((await t.db.one(`select superseded_at from notifications where id = $1`, [esc])).superseded_at, 'AP erledigt');
});

test('Höhere Eskalation und überfällig ersetzen die ältere Meldung zum selben AP; blockiert bleibt eigene Klasse', async () => {
  const web = t.ids.projects.web;
  const uid = t.ids.users.pl;
  const task = await t.db.one(`select t.id from tasks t join board_columns c on c.id = t.column_id where t.project_id = $1 and t.parent_id is null and t.deleted_at is null and not c.is_done order by t.number desc limit 1`, [web]);
  const ref = { type: 'task' as const, id: task.id };
  const blocked = await notify(t.db, { userId: uid, projectId: web, type: 'escalation', event: 'blocked', title: 'Blockiert', ref });
  const e1 = await notify(t.db, { userId: uid, projectId: web, type: 'escalation', title: 'Eskalation Stufe 1', ref });
  const w = await notify(t.db, { userId: uid, projectId: web, type: 'task.wait_expired', event: 'escalation', title: 'Frist abgelaufen', ref });
  const e2 = await notify(t.db, { userId: uid, projectId: web, type: 'escalation', title: 'Eskalation Stufe 2', ref });
  const sup = async (id: string | null) => Boolean((await t.db.one(`select superseded_at from notifications where id = $1`, [id])).superseded_at);
  assert.equal(await sup(e1), true);
  assert.equal(await sup(w), true);
  assert.equal(await sup(e2), false);
  assert.equal(await sup(blocked), false, 'blockiert ist eine eigene Klasse');
  const soon = await notify(t.db, { userId: uid, projectId: web, type: 'task.due_soon', event: 'due', title: 'Bald fällig', ref });
  const over = await notify(t.db, { userId: uid, projectId: web, type: 'task.overdue', event: 'due', title: 'Überfällig', ref });
  assert.equal(await sup(soon), true);
  assert.equal(await sup(over), false);
});

test('Arbeitspaket automatisch erledigt, wenn die letzte Aufgabe erledigt ist; je AP und je Projekt abschaltbar', async () => {
  const pl = await t.login('pl@demo.local');
  const web = t.ids.projects.web;
  const done = await t.db.one(`select id from board_columns where project_id = $1 and is_done order by position limit 1`, [web]);
  const isDone = async (id: string) => (await t.db.one(`select c.is_done from tasks t join board_columns c on c.id = t.column_id where t.id = $1`, [id])).is_done as boolean;
  const mk = async (title: string, parentId?: string) => { const r = await t.api(pl).post(`/projects/${web}/tasks`, { title, ...(parentId ? { parentId } : {}) }); assert.equal(r.statusCode, 200, r.body); return r.json().task.id as string; };
  const ap = await mk('Auto-AP');
  const a = await mk('Teil A', ap);
  const b = await mk('Teil B', ap);
  assert.equal((await t.api(pl).get(`/tasks/${ap}`)).json().task.autoComplete, null);
  assert.equal((await t.api(pl).post(`/tasks/${a}/move`, { columnId: done.id })).statusCode, 200);
  assert.equal(await isDone(ap), false, 'B noch offen');
  assert.equal((await t.api(pl).post(`/tasks/${b}/move`, { columnId: done.id })).statusCode, 200);
  assert.equal(await isDone(ap), true, 'alle erledigt → AP erledigt');
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and body like 'Automatisch erledigt:%'`, [ap]));
  // Je AP abgeschaltet
  const ap2 = await mk('Manuell-AP');
  const c = await mk('Teil C', ap2);
  assert.equal((await t.api(pl).patch(`/tasks/${ap2}`, { autoComplete: false })).statusCode, 200);
  await t.api(pl).post(`/tasks/${c}/move`, { columnId: done.id });
  assert.equal(await isDone(ap2), false, 'AP-Schalter aus');
  // Projekt aus, AP ausdrücklich an
  assert.equal((await t.api(pl).patch(`/projects/${web}`, { autoCompleteParent: false })).json().project.autoCompleteParent, false);
  const ap3 = await mk('Projekt-aus-AP');
  const d = await mk('Teil D', ap3);
  await t.api(pl).post(`/tasks/${d}/move`, { columnId: done.id });
  assert.equal(await isDone(ap3), false, 'Projekt-Vorgabe aus');
  const ap4 = await mk('AP-an');
  const e = await mk('Teil E', ap4);
  await t.api(pl).patch(`/tasks/${ap4}`, { autoComplete: true });
  await t.api(pl).post(`/tasks/${e}/move`, { columnId: done.id });
  assert.equal(await isDone(ap4), true, 'AP übersteuert Projekt');
  await t.api(pl).patch(`/projects/${web}`, { autoCompleteParent: true });
});
