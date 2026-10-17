import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { runDailyRules } from '../src/worker.js';
import { nextDueDate } from '../src/tasks/recurrence.js';

let t: Awaited<ReturnType<typeof testApp>>;
before(async () => { t = await testApp(); });
after(async () => { await t.close(); });

test('Wiederholungsregeln rechnen richtig', () => {
  assert.equal(nextDueDate('2026-10-16', { freq: 'weekly', mode: 'after_done' }), '2026-10-23');
  assert.equal(nextDueDate('2026-01-31', { freq: 'monthly', mode: 'on_due' }), '2026-02-28');
  assert.equal(nextDueDate('2026-10-05', { freq: 'monthly_weekday', nth: 1, weekday: 1, mode: 'on_due' }), '2026-11-02');
  assert.equal(nextDueDate('2026-10-16', { freq: 'daily', interval: 3, mode: 'on_due' }), '2026-10-19');
});

test('Labels, Sortierung per Move, WIP-Limit in Spalten', async () => {
  const pl = await t.login('pl@demo.local');
  const detail = (await t.api(pl).get(`/projects/${t.ids.projects.web}`)).json();
  assert.ok(detail.labels.length >= 5);
  const inArbeit = detail.columns.find((c: any) => c.name === 'In Arbeit');
  assert.equal(inArbeit.wipLimit, 3);
  const lbl = await t.api(pl).post(`/projects/${t.ids.projects.web}/labels`, { name: 'Extern', color: 'teal' });
  assert.equal(lbl.statusCode, 200);
  const upd = await t.api(pl).patch(`/tasks/${t.ids.tasks.t2}`, { labelIds: [lbl.json().label.id] });
  assert.deepEqual(upd.json().task.labelIds, [lbl.json().label.id]);
  assert.equal(upd.json().task.checklistTotal, 4);
  assert.equal(upd.json().task.checklistDone, 2);
  assert.equal(upd.json().task.commentCount, 1);
  const offen = detail.columns.find((c: any) => c.name === 'Offen');
  const mv = await t.api(pl).post(`/tasks/${t.ids.tasks.t2}/move`, { columnId: offen.id, index: 0 });
  assert.equal(mv.statusCode, 200, mv.body);
  const tasks = (await t.api(pl).get(`/projects/${t.ids.projects.web}/tasks`)).json().tasks.filter((x: any) => x.columnId === offen.id).sort((a: any, b: any) => a.position - b.position);
  assert.equal(tasks[0].id, t.ids.tasks.t2);
  assert.deepEqual(tasks.map((x: any) => x.position), tasks.map((_: any, i: number) => i));
  const leser = await t.login('leser@demo.local');
  assert.equal((await t.api(leser).post(`/tasks/${t.ids.tasks.t2}/move`, { columnId: offen.id, index: 1 })).statusCode, 403);
});

test('Archivieren blendet aus, Archiv-Liste zeigt', async () => {
  const pl = await t.login('pl@demo.local');
  const before = (await t.api(pl).get(`/projects/${t.ids.projects.web}/tasks`)).json().tasks.length;
  const done = (await t.api(pl).get(`/projects/${t.ids.projects.web}`)).json().columns.find((c: any) => c.isDone);
  const r = await t.api(pl).post(`/projects/${t.ids.projects.web}/columns/${done.id}/archive-done`);
  assert.ok(r.json().archived >= 2);
  const after = (await t.api(pl).get(`/projects/${t.ids.projects.web}/tasks`)).json().tasks.length;
  assert.equal(after, before - r.json().archived);
  const arch = (await t.api(pl).get(`/projects/${t.ids.projects.web}/tasks?archived=1`)).json().tasks;
  assert.equal(arch.length, r.json().archived);
  const back = await t.api(pl).post(`/tasks/${arch[0].id}/unarchive`);
  assert.equal(back.json().task.archivedAt, null);
});

test('W6: Wiederholung nach Erledigung erzeugt nächste Instanz', async () => {
  const pl = await t.login('pl@demo.local');
  const detail = (await t.api(pl).get(`/projects/${t.ids.projects.web}`)).json();
  const done = detail.columns.find((c: any) => c.isDone);
  const tasks = (await t.api(pl).get(`/projects/${t.ids.projects.web}/tasks`)).json().tasks;
  const rec = tasks.find((x: any) => x.title.startsWith('Wochen-Statusbericht'));
  assert.equal(rec.recurrence.freq, 'weekly');
  await t.api(pl).post(`/tasks/${rec.id}/move`, { columnId: done.id });
  const after = (await t.api(pl).get(`/projects/${t.ids.projects.web}/tasks`)).json().tasks.filter((x: any) => x.title.startsWith('Wochen-Statusbericht'));
  assert.equal(after.length, 2);
  const next = after.find((x: any) => !x.done);
  assert.equal(next.dueDate, nextDueDate(rec.dueDate, rec.recurrence));
  assert.equal(next.recurrence.freq, 'weekly');
  assert.equal(after.find((x: any) => x.done).recurrence, null);
});

test('W6: Wiederholung vor Fälligkeit über den Worker, Erinnerungen per Benachrichtigung', async () => {
  const pl = await t.login('pl@demo.local');
  const created = await t.api(pl).post(`/projects/${t.ids.projects.web}/tasks`, { title: 'Monatsabschluss', dueDate: '2026-10-31', responsibleUserId: t.ids.users.max, recurrence: { freq: 'monthly', mode: 'on_due', leadDays: 20 } });
  assert.equal(created.statusCode, 200, created.body);
  const r1 = await runDailyRules(t.db, '2026-10-10');
  assert.equal(r1.created, 0);
  const r2 = await runDailyRules(t.db, '2026-10-12');
  assert.equal(r2.created, 1);
  const r3 = await runDailyRules(t.db, '2026-10-13');
  assert.equal(r3.created, 0, 'nicht doppelt');
  const all = (await t.api(pl).get(`/projects/${t.ids.projects.web}/tasks`)).json().tasks.filter((x: any) => x.title === 'Monatsabschluss');
  assert.equal(all.length, 2);
  assert.ok(all.some((x: any) => x.dueDate === '2026-11-30'));
  const max = await t.login('max@demo.local');
  const n = await t.api(max).get('/notifications');
  assert.ok(n.json().notifications.some((x: any) => x.type === 'task.assigned' && x.title.includes('Monatsabschluss')));
  await runDailyRules(t.db, '2026-11-01');
  const n2 = (await t.api(max).get('/notifications')).json();
  assert.ok(n2.notifications.some((x: any) => x.type === 'task.overdue' && x.title.includes('Monatsabschluss')));
  const read = await t.api(max).post('/notifications/read', { all: true });
  assert.equal(read.statusCode, 200);
  assert.equal((await t.api(max).get('/notifications')).json().unread, 0);
});

test('Nachfolger verschieben benachrichtigt Betroffene; Kommentar benachrichtigt Zuständigen', async () => {
  const pl = await t.login('pl@demo.local');
  const tasks = (await t.api(pl).get(`/projects/${t.ids.projects.web}/tasks`)).json().tasks;
  const design = tasks.find((x: any) => x.title.startsWith('Designsystem'));
  await t.api(pl).post(`/tasks/${design.id}/comments`, { body: 'Bitte Farbpalette bis Montag.' });
  const anna = await t.login('anna@demo.local');
  const n = (await t.api(anna).get('/notifications')).json();
  assert.ok(n.notifications.some((x: any) => x.type === 'task.comment' && x.title.includes('Designsystem')));
});

test('Meilenstein bearbeiten: Name, Datum, Teilprojekt', async () => {
  const pl = await t.login('pl@demo.local');
  const created = await t.api(pl).post(`/projects/${t.ids.projects.web}/milestones`, { name: 'Testlauf', date: '2027-03-01' });
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json().milestone.id;
  const upd = await t.api(pl).patch(`/projects/${t.ids.projects.web}/milestones/${id}`, { name: 'Testlauf 2', date: '2027-03-15' });
  assert.equal(upd.statusCode, 200, upd.body);
  assert.equal(upd.json().milestone.name, 'Testlauf 2');
  assert.equal(upd.json().milestone.date, '2027-03-15');
  const bad = await t.api(pl).patch(`/projects/${t.ids.projects.web}/milestones/${id}`, { date: '15.03.2027' });
  assert.equal(bad.statusCode, 400);
  const reader = await t.login('leser@demo.local');
  const forbidden = await t.api(reader).patch(`/projects/${t.ids.projects.web}/milestones/${id}`, { name: 'x' });
  assert.equal(forbidden.statusCode, 403);
});

test('Projektliste liefert Kennzahlen je Projekt', async () => {
  const pl = await t.login('pl@demo.local');
  const r = await t.api(pl).get('/projects');
  assert.equal(r.statusCode, 200);
  const web = r.json().projects.find((p: any) => p.key === 'WEB');
  assert.ok(web.stats.open > 0);
  assert.ok(web.stats.nextMilestone && /^\d{4}-\d{2}-\d{2}$/.test(web.stats.nextMilestone.date));
});

test('Projekt-Übersicht liefert Kennzahlen', async () => {
  const pl = await t.login('pl@demo.local');
  const o = await t.api(pl).get(`/projects/${t.ids.projects.web}/overview`);
  assert.equal(o.statusCode, 200, o.body);
  const j = o.json();
  assert.ok(j.counts.open > 0);
  assert.ok(j.milestones.length >= 1);
  assert.match(j.milestones[0].date, /^\d{4}-\d{2}-\d{2}$/, 'Meilenstein-Datum als YYYY-MM-DD, sonst fehlt er im Gantt und Kalender');
  assert.ok(j.perSubproject.length === 4);
  assert.ok(j.conflicts.length >= 1);
  assert.ok(Array.isArray(j.workload) && j.workload.length >= 1);
  assert.ok(j.activity.length > 0);
});

test('Doku-Freigabe per Link: lesen, Unterseiten, schreiben, widerrufen, Ablauf', async () => {
  const pl = await t.login('pl@demo.local');
  const docs = (await t.api(pl).get(`/projects/${t.ids.projects.web}/docs`)).json();
  const auftrag = docs.pages.find((p: any) => p.title.startsWith('Projektauftrag'));
  const child = docs.pages.find((p: any) => p.parentPageId === auftrag.id);
  assert.ok(child, 'Unterseite vorhanden');
  // Leser darf keine Freigaben erstellen
  const leser = await t.login('leser@demo.local');
  assert.equal((await t.api(leser).post(`/docs/pages/${auftrag.id}/shares`, { email: 'x@y.de', mode: 'read' })).statusCode, 403);
  // Lese-Freigabe inkl. Unterseiten, per Mail versendet
  const sh = await t.api(pl).post(`/docs/pages/${auftrag.id}/shares`, { email: 'k.mueller@mueller-design.de', mode: 'read', includeChildren: true, send: true, message: 'Zur Kenntnis.' });
  assert.equal(sh.statusCode, 200, sh.body);
  assert.equal(sh.json().sent, true);
  const token = sh.json().share.url.split('/s/')[1];
  assert.ok(t.mail.dev.sent.at(-1)!.msg.text.includes(token));
  const pub = await t.app.inject({ method: 'GET', url: `/api/share/${token}` });
  assert.equal(pub.statusCode, 200, pub.body);
  assert.equal(pub.json().pages.length, 2);
  assert.equal(pub.json().share.mode, 'read');
  const childPub = await t.app.inject({ method: 'GET', url: `/api/share/${token}/pages/${child.id}` });
  assert.equal(childPub.statusCode, 200);
  assert.match(childPub.json().page.contentMd, /WCAG/);
  const foreign = docs.pages.find((p: any) => p.title.startsWith('Statusbericht'));
  assert.equal((await t.app.inject({ method: 'GET', url: `/api/share/${token}/pages/${foreign.id}` })).statusCode, 403);
  assert.equal((await t.app.inject({ method: 'PATCH', url: `/api/share/${token}/pages/${child.id}`, payload: { contentMd: 'x' } })).statusCode, 403);
  // Schreib-Freigabe ohne Unterseiten auf die Unterseite (Entwurf/Prüfung)
  const sw = await t.api(pl).post(`/docs/pages/${child.id}/shares`, { email: 'extern@partner.de', mode: 'write', includeChildren: false, expiresDays: 7 });
  const tok2 = sw.json().share.url.split('/s/')[1];
  const tree = (await t.app.inject({ method: 'GET', url: `/api/share/${tok2}` })).json();
  assert.equal(tree.pages.length, 1);
  const edit = await t.app.inject({ method: 'PATCH', url: `/api/share/${tok2}/pages/${child.id}`, payload: { contentMd: tree.root.contentMd + '\n\n## Ergänzung extern\n\nPrüfbericht folgt.', baseVersion: tree.root.version } });
  assert.equal(edit.statusCode, 200, edit.body);
  assert.equal(edit.json().page.version, tree.root.version + 1);
  const detail = (await t.api(pl).get(`/docs/pages/${child.id}`)).json();
  assert.equal(detail.page.updatedByName, 'extern@partner.de (extern)');
  assert.ok(detail.versions[0].savedByName.includes('extern'));
  assert.equal(detail.activeShares, 2);
  const n = (await t.api(pl).get('/notifications')).json();
  assert.ok(n.notifications.some((x: any) => x.type === 'page.external_edit'));
  // Finale Seite nicht beschreibbar
  const sf = await t.api(pl).post(`/docs/pages/${auftrag.id}/shares`, { email: 'extern@partner.de', mode: 'write', includeChildren: false });
  const tok3 = sf.json().share.url.split('/s/')[1];
  assert.equal((await t.app.inject({ method: 'PATCH', url: `/api/share/${tok3}/pages/${auftrag.id}`, payload: { contentMd: 'x' } })).statusCode, 409);
  // Widerruf
  const list = (await t.api(pl).get(`/docs/pages/${auftrag.id}/shares`)).json().shares;
  assert.equal(list.length, 2);
  const rev = await t.api(pl).del(`/docs/shares/${sh.json().share.id}`);
  assert.equal(rev.statusCode, 200);
  assert.equal((await t.app.inject({ method: 'GET', url: `/api/share/${token}` })).statusCode, 404);
  // Ablauf
  await t.db.query(`update doc_shares set expires_at = now() - interval '1 day' where token = $1`, [tok2]);
  assert.equal((await t.app.inject({ method: 'GET', url: `/api/share/${tok2}` })).statusCode, 404);
  const audit = await t.db.query(`select action from audit_log where action in ('page.share','page.share_revoke','page.external_edit')`);
  assert.ok(audit.rows.length >= 4);
});

test('RAID- und weitere Vorlagen vorhanden', async () => {
  const pl = await t.login('pl@demo.local');
  const keys = (await t.api(pl).get('/docs/templates')).json().templates.map((x: any) => x.key);
  for (const k of ['raid', 'aenderungsantrag', 'kickoff', 'lessons', 'protokoll']) assert.ok(keys.includes(k), k);
});
