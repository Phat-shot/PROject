import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';

const t = await testApp();
test.after(() => t.close());

test('Auswertung je Projekt: Durchsatz je Woche, Durchlaufzeit, Verzug nach Alter, Eskalationen, Teilprojekte; Zeitraum prüfbar', async () => {
  const pl = await t.login('pl@demo.local');
  const pid = t.ids.projects.web;
  const bad = await t.api(pl).get(`/projects/${pid}/analytics?from=2026-10-20&to=2026-10-01`);
  assert.equal(bad.statusCode, 400);
  await t.db.query(`update tasks set due_date = current_date - 10 where id = $1`, [t.ids.tasks.t2]);
  const r = await t.api(pl).get(`/projects/${pid}/analytics`);
  assert.equal(r.statusCode, 200, r.body);
  const a = r.json();
  assert.ok(a.weeks.length >= 12 && a.weeks.length <= 14, 'rund 12 Wochen');
  assert.match(a.weeks[0].week, /^\d{4}-W\d{2}$/);
  assert.ok(a.throughput.created >= 1, 'Demo-Arbeitspakete wurden im Zeitraum angelegt');
  assert.equal(a.throughput.created, a.weeks.reduce((s: number, w: any) => s + w.created, 0));
  assert.ok(a.overdue.total >= 1);
  assert.ok(a.overdue.list.some((o: any) => o.id === t.ids.tasks.t2 && o.days === 10));
  assert.ok(a.overdue.aging.d8_30 >= 1);
  assert.equal(a.overdue.total, a.overdue.aging.d1_7 + a.overdue.aging.d8_30 + a.overdue.aging.d31);
  assert.ok(a.overdue.list.every((o: any) => o.days >= 1 && o.dueDate < new Date().toISOString().slice(0, 10)));
  assert.ok(a.bySubproject.length >= 1);
  assert.ok(typeof a.cycleTime.count === 'number');
  // Eskalation erzeugen und im Zeitraum zählen
  const task = a.overdue.list[0];
  await t.db.query(`insert into audit_log (org_id, project_id, user_id, action, object_type, object_id, details) values ($1,$2,null,'escalation.raise','task',$3,'{"level":2,"reason":"Test"}'::jsonb)`, [t.ids.org, pid, task.id]);
  const r2 = await t.api(pl).get(`/projects/${pid}/analytics`);
  assert.equal(r2.json().escalations.total, a.escalations.total + 1);
  assert.ok(r2.json().escalations.byLevel.some((l: any) => l.level === 2 && l.label === 'Projektleitung'));
  // Leser darf lesen, Fremde nicht
  assert.equal((await t.api(await t.login('leser@demo.local')).get(`/projects/${pid}/analytics`)).statusCode, 200);
  assert.equal((await t.api(await t.login('admin@demo.local')).get(`/projects/${pid}/analytics`)).statusCode, 403);
});

test('Zeiten über Projekte: PL sieht alle Personen seiner Projekte, Mitglied nur sich; Summen stimmen', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const pid = t.ids.projects.web;
  await t.db.query(`update projects set time_tracking_enabled = true where id = $1`, [pid]);
  const today = new Date().toISOString().slice(0, 10);
  await t.db.query(`insert into time_entries (project_id, user_id, date, minutes) values ($1,$2,$3,90), ($1,$4,$3,30)`, [pid, t.ids.users.pl, today, t.ids.users.max]);
  const r = await t.api(pl).get('/portfolio/time');
  assert.equal(r.statusCode, 200, r.body);
  const web = r.json().projects.find((p: any) => p.key === 'WEB');
  assert.ok(web);
  assert.ok(web.minutes >= 120);
  assert.ok(web.people.length >= 2);
  const rm = await t.api(max).get('/portfolio/time');
  const webMax = rm.json().projects.find((p: any) => p.key === 'WEB');
  assert.ok(webMax, 'Max sieht sein Projekt');
  assert.ok(webMax.people.every((p: any) => p.userId === t.ids.users.max), 'nur eigene Buchungen');
  const empty = await t.api(pl).get('/portfolio/time?from=2020-01-01&to=2020-01-31');
  assert.equal(empty.json().total, 0);
});
