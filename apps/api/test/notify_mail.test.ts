import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { runNotificationMails } from '../src/notifyMail.js';
import { notify } from '../src/notify.js';

const t = await testApp();
test.after(() => t.close());
const maxId = async () => (await t.db.one(`select id from users where email = 'max@demo.local'`)).id as string;
const mailsTo = (addr: string) => t.mail.dev.sent.filter((m) => m.msg.to.includes(addr));

test('Meldungen per Mail: sofort gesammelt, Digest einmal täglich ab 7 Uhr, aus = nichts', async () => {
  const max = await maxId();
  await t.db.query(`update users set settings = '{"mailNotifications":"immediate"}' where id = $1`, [max]);
  await notify(t.db, { userId: max, type: 'test', title: 'Erste Meldung', body: 'Details', link: '/dashboard' });
  await notify(t.db, { userId: max, type: 'test', title: 'Zweite Meldung' });
  const before = mailsTo('max@demo.local').length;
  const r1 = await runNotificationMails(t.db, t.mail, new Date('2026-10-17T03:00:00'));
  assert.ok(r1.sent >= 1);
  const sent = mailsTo('max@demo.local');
  assert.equal(sent.length, before + 1, 'eine gesammelte Mail');
  assert.match(String(sent[sent.length - 1].msg.subject), /2 neue Meldungen/);
  assert.match(String(sent[sent.length - 1].msg.text), /Erste Meldung – Details/);
  const r2 = await runNotificationMails(t.db, t.mail, new Date('2026-10-17T03:01:00'));
  assert.equal(mailsTo('max@demo.local').length, before + 1, 'nichts doppelt');
  void r2;

  await t.db.query(`update users set settings = '{"mailNotifications":"daily"}' where id = $1`, [max]);
  await notify(t.db, { userId: max, type: 'test', title: 'Dritte Meldung' });
  await runNotificationMails(t.db, t.mail, new Date('2026-10-18T06:00:00'));
  assert.equal(mailsTo('max@demo.local').length, before + 1, 'vor 7 Uhr kein Digest');
  await runNotificationMails(t.db, t.mail, new Date('2026-10-18T08:00:00'));
  assert.equal(mailsTo('max@demo.local').length, before + 2, 'Digest ab 7 Uhr');
  await notify(t.db, { userId: max, type: 'test', title: 'Vierte Meldung' });
  await runNotificationMails(t.db, t.mail, new Date('2026-10-18T09:00:00'));
  assert.equal(mailsTo('max@demo.local').length, before + 2, 'nur ein Digest am Tag');

  await t.db.query(`update users set settings = '{"mailNotifications":"off"}' where id = $1`, [max]);
  await runNotificationMails(t.db, t.mail, new Date('2026-10-19T09:00:00'));
  assert.equal(mailsTo('max@demo.local').length, before + 2, 'aus: keine Mail');
});

test('Gelesene Meldungen werden nicht per Mail verschickt', async () => {
  const max = await maxId();
  await t.db.query(`update users set settings = '{"mailNotifications":"immediate"}' where id = $1`, [max]);
  await t.db.query(`update notifications set mailed_at = now() where user_id = $1 and mailed_at is null`, [max]);
  await notify(t.db, { userId: max, type: 'test', title: 'Schon gelesen' });
  await t.db.query(`update notifications set read_at = now() where user_id = $1 and title = 'Schon gelesen'`, [max]);
  const before = mailsTo('max@demo.local').length;
  await runNotificationMails(t.db, t.mail, new Date('2026-10-20T09:00:00'));
  assert.equal(mailsTo('max@demo.local').length, before);
});

test('Erinnerungen an Externe: vor Fälligkeit und bei Verzug über das Projektkonto, höchstens einmal je Tag und Art', async () => {
  const { runReminders } = await import('../src/tasks/reminders.js');
  const web = t.ids.projects.web;
  await t.db.query(`update projects set reminders = '{"enabled":true,"daysBefore":[3,0],"overdueEveryDays":2}' where id = $1`, [web]);
  const pl = await t.login('pl@demo.local');
  const task = (await t.api(pl).post(`/projects/${web}/tasks`, { title: 'Externer Liefertermin', responsibleEmail: 'lieferant@extern.de', dueDate: '2026-11-10' })).json().task;
  const before = mailsTo('lieferant@extern.de').length;
  assert.equal((await runReminders(t.db, t.mail, '2026-11-07')).sent >= 1, true, '3 Tage vorher');
  assert.equal(mailsTo('lieferant@extern.de').length, before + 1);
  await runReminders(t.db, t.mail, '2026-11-07');
  assert.equal(mailsTo('lieferant@extern.de').length, before + 1, 'nicht doppelt am selben Tag');
  await runReminders(t.db, t.mail, '2026-11-08');
  assert.equal(mailsTo('lieferant@extern.de').length, before + 1, '2 Tage vorher ist nicht konfiguriert');
  await runReminders(t.db, t.mail, '2026-11-10');
  assert.equal(mailsTo('lieferant@extern.de').length, before + 2, 'am Fälligkeitstag');
  await runReminders(t.db, t.mail, '2026-11-11');
  assert.equal(mailsTo('lieferant@extern.de').length, before + 2, 'Verzug Tag 1: noch nicht (alle 2 Tage)');
  await runReminders(t.db, t.mail, '2026-11-12');
  assert.equal(mailsTo('lieferant@extern.de').length, before + 3, 'Verzug Tag 2');
  const last = mailsTo('lieferant@extern.de').at(-1)!;
  assert.match(String(last.msg.subject), /überfällig seit 2 Tag/);
  assert.ok(String(last.msg.replyTo ?? '').includes('+t'), 'Antwortadresse mit Task-Code');
  void task;
});
