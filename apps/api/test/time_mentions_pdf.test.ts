import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { extractMentions } from '../src/tasks/mentions.js';
import { markdownToPdf } from '../src/docs/pdf.js';

let t: Awaited<ReturnType<typeof testApp>>;
before(async () => { t = await testApp(); });
after(async () => { await t.close(); });

test('Erwähnungen: längster Name gewinnt, Groß-/Kleinschreibung egal', () => {
  const members = [{ userId: 'a', name: 'Max Keller' }, { userId: 'b', name: 'Max' }, { userId: 'c', name: 'Anna Berger' }];
  assert.deepEqual(extractMentions('Bitte @Max Keller prüfen, danke @anna berger', members).sort(), ['a', 'c']);
  assert.deepEqual(extractMentions('@Max bitte', members), ['b']);
  assert.deepEqual(extractMentions('mail an max@keller.de', members), []);
});

test('Kommentar mit @-Erwähnung benachrichtigt die erwähnte Person', async () => {
  const pl = await t.login('pl@demo.local');
  const r = await t.api(pl).post(`/tasks/${t.ids.tasks.t2}/comments`, { body: '@Lea Reuter bitte gegenlesen, @Max Keller kennt den Stand.' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().comment.mentions.length, 2);
  const lea = await t.login('leser@demo.local');
  const n = (await t.api(lea).get('/notifications')).json();
  assert.ok(n.notifications.some((x: any) => x.type === 'mention' && x.title.includes('erwähnt')));
});

test('Zeiterfassung: buchen, auswerten, Rechte, Schätzung', async () => {
  const max = await t.login('max@demo.local');
  const book = await t.api(max).post(`/projects/${t.ids.projects.web}/time`, { taskId: t.ids.tasks.t2, date: '2026-10-15', minutes: 120, note: 'Review' });
  assert.equal(book.statusCode, 200, book.body);
  assert.equal(book.json().entry.minutes, 120);
  assert.equal((await t.api(max).post(`/projects/${t.ids.projects.web}/time`, { minutes: 0 })).statusCode, 400);
  const task = (await t.api(max).get(`/tasks/${t.ids.tasks.t2}`)).json().task;
  assert.equal(task.loggedMinutes, 240 + 180 + 120);
  assert.equal(task.estimateMinutes, 960);
  // Mitglied sieht nur eigene Buchungen, PL alle
  const mine = (await t.api(max).get(`/projects/${t.ids.projects.web}/time`)).json();
  assert.ok(mine.entries.every((e: any) => e.userName === 'Max Keller'));
  assert.equal(mine.totalMinutes, null);
  const pl = await t.login('pl@demo.local');
  const all = (await t.api(pl).get(`/projects/${t.ids.projects.web}/time`)).json();
  assert.equal(all.totalMinutes, 240 + 180 + 120 + 90);
  assert.equal(all.budgetHours, 1200);
  assert.ok(all.byUser.length >= 2);
  // Fremde Buchung: Mitglied darf nicht löschen, PL schon
  const plEntry = all.entries.find((e: any) => e.userName === 'Petra Lenz');
  assert.equal((await t.api(max).del(`/time/${plEntry.id}`)).statusCode, 403);
  assert.equal((await t.api(pl).del(`/time/${plEntry.id}`)).statusCode, 200);
  // Meine Woche über Projekte
  const my = (await t.api(max).get('/my/time?from=2026-01-01&to=2027-12-31')).json();
  assert.ok(my.totalMinutes >= 540);
  // Modul aus → Buchen abgelehnt
  await t.api(pl).patch(`/projects/${t.ids.projects.web}`, { timeTrackingEnabled: false });
  assert.equal((await t.api(max).post(`/projects/${t.ids.projects.web}/time`, { minutes: 30 })).statusCode, 400);
  await t.api(pl).patch(`/projects/${t.ids.projects.web}`, { timeTrackingEnabled: true, budgetHours: 1000 });
  const o = (await t.api(pl).get(`/projects/${t.ids.projects.web}/overview`)).json();
  assert.equal(o.time.budgetHours, 1000);
  assert.ok(o.time.loggedMinutes > 0);
});

test('PDF: Markdown wird zu gültigem PDF, Versand hängt PDF an und legt es an der Seite ab', async () => {
  const pdf = await markdownToPdf('# Titel\n\nAbsatz mit **fett** und Umlauten äöü.\n\n## Tabelle\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- Punkt eins\n- Punkt zwei\n\n> Zitat', { title: 'Test', project: 'Demo', version: 1, status: 'final' });
  assert.ok(pdf.length > 1000);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const pl = await t.login('pl@demo.local');
  const docs = (await t.api(pl).get(`/projects/${t.ids.projects.web}/docs`)).json();
  const proto = docs.pages.find((p: any) => p.title.includes('02.10.2026'));
  const dl = await t.api(pl).get(`/docs/pages/${proto.id}/pdf`);
  assert.equal(dl.statusCode, 200);
  assert.equal(dl.headers['content-type'], 'application/pdf');
  const dist = await t.api(pl).post(`/docs/pages/${proto.id}/distribute`, {});
  assert.equal(dist.statusCode, 200, dist.body);
  assert.match(dist.json().filename, /\.pdf$/);
  const sent = t.mail.dev.sent.at(-1)!;
  assert.equal(sent.msg.attachments?.length, 1);
  assert.equal(sent.msg.attachments![0].contentType, 'application/pdf');
  const detail = (await t.api(pl).get(`/docs/pages/${proto.id}`)).json();
  assert.ok(detail.attachments.some((a: any) => a.filename.endsWith('.pdf')));
  const leser = await t.login('leser@demo.local');
  assert.equal((await t.api(leser).get(`/docs/pages/${proto.id}/pdf`)).statusCode, 200);
});
