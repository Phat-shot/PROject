import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { runNotificationMails } from '../src/notifyMail.js';
import { notify } from '../src/notify.js';

const t = await testApp();
test.after(() => t.close());
const maxId = async () => (await t.db.one(`select id from users where email = 'max@demo.local'`)).id as string;
const mailsTo = (addr: string) => t.mail.dev.sent.filter((m) => m.msg.to.includes(addr));
/** Entstehungszeit einer Meldung auf die simulierte Uhr setzen (der Digest nimmt nur, was vor der Digest-Zeit des Tages entstand). */
const createdAt = (id: string | null, iso: string) => t.db.query(`update notifications set created_at = $2 where id = $1`, [id, iso]);

test('Meldungen per Mail: Modus je Meldung nach Regel N, sofort gesammelt, Digest zur Stunde der Org (Europe/Berlin), aus = nichts', async () => {
  const max = await maxId();
  const maxC = await t.login('max@demo.local');
  const admin = await t.login('admin@demo.local');
  // Übergang: PATCH /me mit mailNotifications schreibt die Benutzerregel „*“ (immediate = sofort)
  assert.equal((await t.api(maxC).patch('/me', { settings: { mailNotifications: 'immediate' } })).statusCode, 200);
  await notify(t.db, { userId: max, type: 'test', title: 'Erste Meldung', body: 'Details', link: '/dashboard' });
  await notify(t.db, { userId: max, type: 'test', title: 'Zweite Meldung' });
  assert.deepEqual((await t.db.query(`select mail from notifications where user_id = $1 and title like '%Meldung'`, [max])).rows.map((r: any) => r.mail), ['now', 'now'], 'Modus beim Erzeugen festgeschrieben');
  const before = mailsTo('max@demo.local').length;
  const r1 = await runNotificationMails(t.db, t.mail, new Date('2026-10-17T01:00:00Z'));
  assert.ok(r1.sent >= 1);
  const sent = mailsTo('max@demo.local');
  assert.equal(sent.length, before + 1, 'eine gesammelte Mail');
  assert.match(String(sent[sent.length - 1].msg.subject), /2 neue Meldungen/);
  assert.match(String(sent[sent.length - 1].msg.text), /Erste Meldung – Details/);
  await runNotificationMails(t.db, t.mail, new Date('2026-10-17T01:01:00Z'));
  assert.equal(mailsTo('max@demo.local').length, before + 1, 'nichts doppelt');

  // Digest: Stunde der Org (Standard 7 Uhr in Europe/Berlin, im Oktober 05:00 UTC)
  await t.api(maxC).patch('/me', { settings: { mailNotifications: 'daily' } });
  await createdAt(await notify(t.db, { userId: max, type: 'test', title: 'Dritte Meldung' }), '2026-10-18T04:00:00Z');
  await runNotificationMails(t.db, t.mail, new Date('2026-10-18T04:30:00Z'));
  assert.equal(mailsTo('max@demo.local').length, before + 1, 'vor 7 Uhr Berlin kein Digest');
  await runNotificationMails(t.db, t.mail, new Date('2026-10-18T05:05:00Z'));
  assert.equal(mailsTo('max@demo.local').length, before + 2, 'Digest ab 7 Uhr Berlin');
  await createdAt(await notify(t.db, { userId: max, type: 'test', title: 'Vierte Meldung' }), '2026-10-18T06:00:00Z');
  await runNotificationMails(t.db, t.mail, new Date('2026-10-18T09:00:00Z'));
  assert.equal(mailsTo('max@demo.local').length, before + 2, 'nur ein Digest am Tag');
  // Die Org verlegt den Digest auf 9 Uhr
  assert.equal((await t.api(maxC).put('/org/notification-rules', { digestHour: 9 })).statusCode, 403, 'Digest-Stunde setzt nur der Org-Admin');
  assert.equal((await t.api(admin).put('/org/notification-rules', { digestHour: 24 })).statusCode, 400);
  assert.equal((await t.api(admin).put('/org/notification-rules', { digestHour: 9 })).json().digestHour, 9);
  await runNotificationMails(t.db, t.mail, new Date('2026-10-19T05:30:00Z'));
  assert.equal(mailsTo('max@demo.local').length, before + 2, '7:30 Uhr: noch nicht');
  await runNotificationMails(t.db, t.mail, new Date('2026-10-19T07:01:00Z'));
  assert.equal(mailsTo('max@demo.local').length, before + 3, '9:01 Uhr Berlin: Digest');
  assert.match(String(mailsTo('max@demo.local').at(-1)!.msg.subject), /Vierte Meldung/);

  // Eine Meldung behält ihren Modus: „sofort“ geht auch nach dem Umstellen auf „aus“ noch raus, neue Meldungen nicht mehr
  await t.api(maxC).patch('/me', { settings: { mailNotifications: 'immediate' } });
  await notify(t.db, { userId: max, type: 'test', title: 'Fünfte Meldung' });
  await t.api(maxC).patch('/me', { settings: { mailNotifications: 'off' } });
  await notify(t.db, { userId: max, type: 'test', title: 'Sechste Meldung' });
  await runNotificationMails(t.db, t.mail, new Date('2026-10-20T08:00:00Z'));
  assert.equal(mailsTo('max@demo.local').length, before + 4);
  assert.match(String(mailsTo('max@demo.local').at(-1)!.msg.subject), /Fünfte Meldung/);
  await runNotificationMails(t.db, t.mail, new Date('2026-10-21T08:00:00Z'));
  assert.equal(mailsTo('max@demo.local').length, before + 4, 'aus: keine Mail');
});

test('Digest-Fenster: war zur Digest-Stunde nichts offen, warten spätere Digest-Meldungen bis zur nächsten Digest-Stunde', async () => {
  const max = await maxId();
  const maxC = await t.login('max@demo.local');
  await t.api(await t.login('admin@demo.local')).put('/org/notification-rules', { digestHour: 7 });
  await t.api(maxC).patch('/me', { settings: { mailNotifications: 'daily' } });
  await t.db.query(`update notifications set mailed_at = now() where user_id = $1 and mailed_at is null`, [max]);
  // Digest am Vortag 07:05 Berlin
  await createdAt(await notify(t.db, { userId: max, type: 'test', title: 'Vortag' }), '2026-10-21T04:00:00Z');
  const before = mailsTo('max@demo.local').length;
  await runNotificationMails(t.db, t.mail, new Date('2026-10-21T05:05:00Z'));
  assert.equal(mailsTo('max@demo.local').length, before + 1);
  // Heute um 7 Uhr war nichts offen; um 10:13 Berlin entsteht eine Digest-Meldung: der Lauf um 10:14 verschickt sie nicht
  await createdAt(await notify(t.db, { userId: max, type: 'test', title: 'Nach der Digest-Stunde' }), '2026-10-22T08:13:00Z');
  await runNotificationMails(t.db, t.mail, new Date('2026-10-22T08:14:00Z'));
  assert.equal(mailsTo('max@demo.local').length, before + 1, 'Digest nur zur Digest-Stunde');
  // Eine „sofort“-Meldung geht trotzdem, die Digest-Meldung bleibt liegen
  const d2 = await notify(t.db, { userId: max, type: 'test', title: 'Sofort dazwischen', event: 'decision' });
  await t.db.query(`update notifications set mail = 'now', created_at = '2026-10-22T08:20:00Z' where id = $1`, [d2]);
  await runNotificationMails(t.db, t.mail, new Date('2026-10-22T08:21:00Z'));
  assert.equal(mailsTo('max@demo.local').length, before + 2);
  assert.doesNotMatch(String(mailsTo('max@demo.local').at(-1)!.msg.text), /Nach der Digest-Stunde/);
  // Nächster Tag 07:01 Berlin: Digest mit der liegengebliebenen Meldung
  await runNotificationMails(t.db, t.mail, new Date('2026-10-23T05:01:00Z'));
  assert.equal(mailsTo('max@demo.local').length, before + 3);
  assert.match(String(mailsTo('max@demo.local').at(-1)!.msg.subject), /Nach der Digest-Stunde/);
});

test('Gelesene Meldungen werden nicht per Mail verschickt', async () => {
  const max = await maxId();
  await t.api(await t.login('max@demo.local')).patch('/me', { settings: { mailNotifications: 'immediate' } });
  await t.db.query(`update notifications set mailed_at = now() where user_id = $1 and mailed_at is null`, [max]);
  await notify(t.db, { userId: max, type: 'test', title: 'Schon gelesen' });
  assert.equal((await t.db.one(`select mail from notifications where title = 'Schon gelesen'`)).mail, 'now');
  await t.db.query(`update notifications set read_at = now() where user_id = $1 and title = 'Schon gelesen'`, [max]);
  const before = mailsTo('max@demo.local').length;
  await runNotificationMails(t.db, t.mail, new Date('2026-10-22T09:00:00Z'));
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
