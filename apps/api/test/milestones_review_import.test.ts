import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { detectMapping, parseCsv, parseDate } from '../src/tasks/importCsv.js';

/** Meilensteine mit Status und AP-Bezug, benannte prüfende Person (Board und Doku), CSV-Import. */
const t = await testApp();
test.after(() => t.close());

const web = () => t.ids.projects.web;
const col = async (name: string) => (await t.db.one(`select id from board_columns where project_id = $1 and name = $2`, [web(), name])).id as string;
const doneCol = async () => (await t.db.one(`select id from board_columns where project_id = $1 and is_done order by position limit 1`, [web()])).id as string;

test('Meilenstein: APs verknüpfen, alle erledigt → Vorschlag an die PL; PL bestätigt → erreicht mit Datum und Person; Report nutzt reachedAt', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const a = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'MS-AP 1' })).json().task;
  const b = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'MS-AP 2' })).json().task;
  let r = await t.api(max).post(`/projects/${web()}/milestones`, { name: 'Abnahme Design', date: '2026-12-01', taskIds: [a.id] });
  assert.equal(r.statusCode, 200, r.body);
  const ms = r.json().milestone;
  assert.deepEqual(ms.taskIds, [a.id]);
  assert.equal(ms.reachedAt, null);
  // Feld „Meilenstein“ am Arbeitspaket (Mehrfach) setzt den Bezug von der anderen Seite
  r = await t.api(pl).patch(`/tasks/${b.id}`, { milestoneIds: [ms.id] });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().task.milestoneIds, [ms.id]);
  const leser = await t.login('leser@demo.local');
  assert.equal((await t.api(leser).patch(`/tasks/${b.id}`, { milestoneIds: [] })).statusCode, 403);
  // Aufgaben hängen nicht direkt an Meilensteinen
  const auf = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Aufgabe', parentId: a.id })).json().task;
  assert.equal((await t.api(pl).patch(`/tasks/${auf.id}`, { milestoneIds: [ms.id] })).statusCode, 400);
  await t.api(pl).post(`/tasks/${auf.id}/move`, { columnId: await doneCol() });

  await t.api(max).post(`/tasks/${a.id}/move`, { columnId: await doneCol() });
  let d = (await t.api(pl).get(`/projects/${web()}`)).json().milestones.find((x: any) => x.id === ms.id);
  assert.equal(d.tasksDone, 1); assert.equal(d.tasksTotal, 2); assert.equal(d.reachSuggestedAt, null);
  await t.api(max).post(`/tasks/${b.id}/move`, { columnId: await doneCol() });
  d = (await t.api(pl).get(`/projects/${web()}`)).json().milestones.find((x: any) => x.id === ms.id);
  assert.ok(d.reachSuggestedAt, 'alle APs erledigt: Vorschlag');
  assert.equal(d.reachedAt, null, 'ohne Automatik nicht von selbst erreicht');
  const note = await t.db.maybeOne(`select * from notifications where user_id = $1 and type = 'milestone.reach' and resolved_at is null`, [t.ids.users.pl]);
  assert.ok(note, 'PL bekommt die Meldung');
  // AP wieder offen: Vorschlag fällt weg
  await t.api(max).post(`/tasks/${b.id}/move`, { columnId: await col('In Arbeit') });
  d = (await t.api(pl).get(`/projects/${web()}`)).json().milestones.find((x: any) => x.id === ms.id);
  assert.equal(d.reachSuggestedAt, null);
  await t.api(max).post(`/tasks/${b.id}/move`, { columnId: await doneCol() });

  // PL bestätigt
  r = await t.api(pl).patch(`/projects/${web()}/milestones/${ms.id}`, { reached: true });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(r.json().milestone.reachedAt);
  assert.equal(r.json().milestone.reachedBy.userId, t.ids.users.pl);
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'milestone.reached' and object_id = $1`, [ms.id]));
  assert.equal((await t.db.one(`select count(*)::int as c from notifications where type = 'milestone.reach' and resolved_at is null and dedupe_key like $1`, [`ms_reach:${ms.id}:%`])).c, 0, 'Vorschlag erledigt');
  // Leser darf nicht bestätigen
  assert.equal((await t.api(leser).patch(`/projects/${web()}/milestones/${ms.id}`, { reached: false })).statusCode, 403);

  // Report-Block: erreicht im Zeitraum (bestätigt heute), auch wenn das Datum in der Zukunft liegt
  const today = new Date().toISOString().slice(0, 10);
  const rep = await t.api(pl).post(`/projects/${web()}/reporting/preview`, { today, blocks: [{ id: 'm', type: 'milestones', chart: false }] });
  assert.equal(rep.statusCode, 200, rep.body);
  const html = rep.json().html as string;
  const reachedPart = html.slice(html.indexOf('Erreicht'));
  assert.ok(reachedPart.includes('Abnahme Design'), 'erreichter Meilenstein im Bericht unter „Erreicht“');
  assert.ok(reachedPart.includes(today.split('-').reverse().join('.')), 'mit Datum der Bestätigung');
  const ov = (await t.api(pl).get(`/projects/${web()}/overview`)).json();
  assert.ok(ov.reachedMilestones.some((x: any) => x.id === ms.id), 'Übersicht: erreicht');
  assert.ok(!ov.milestones.some((x: any) => x.id === ms.id), 'nicht mehr unter offen');
});

test('Meilenstein: Projekteinstellung „automatisch erreichen“ setzt erreicht ohne Bestätigung', async () => {
  const pl = await t.login('pl@demo.local');
  assert.equal((await t.api(pl).patch(`/projects/${web()}`, { milestoneAutoReach: true })).json().project.milestoneAutoReach, true);
  const a = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Auto-MS-AP' })).json().task;
  const ms = (await t.api(pl).post(`/projects/${web()}/milestones`, { name: 'Auto', date: '2026-12-24', taskIds: [a.id] })).json().milestone;
  await t.api(pl).patch(`/tasks/${a.id}`, { columnId: await doneCol() });
  const d = (await t.api(pl).get(`/projects/${web()}`)).json().milestones.find((x: any) => x.id === ms.id);
  assert.ok(d.reachedAt, 'automatisch erreicht');
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'milestone.reached' and object_id = $1 and details->>'auto' = 'all_tasks_done'`, [ms.id]));
  await t.api(pl).patch(`/projects/${web()}`, { milestoneAutoReach: false });
  // Fremde Arbeitspakete lassen sich nicht verknüpfen
  const other = await t.db.one(`select id from tasks where project_id <> $1 limit 1`, [web()]);
  assert.equal((await t.api(pl).patch(`/projects/${web()}/milestones/${ms.id}`, { taskIds: [other.id] })).statusCode, 400);
});

test('Prüfung am Board: Prüfer beim Wechsel in „In Prüfung“, Meldung, Offen für dich, Freigeben und Zurückweisen mit Kommentar', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const review = await col('In Prüfung');
  assert.equal((await t.db.one(`select kind from board_columns where id = $1`, [review])).kind, 'review', 'Spalte „In Prüfung“ hat die Art review');
  const ap = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Konzept prüfen lassen', responsibleUserId: t.ids.users.anna })).json().task;
  const inArbeit = await col('In Arbeit');
  await t.api(pl).post(`/tasks/${ap.id}/move`, { columnId: inArbeit });

  // Pflicht mit Projekteinstellung
  await t.api(pl).patch(`/projects/${web()}`, { reviewRequired: true });
  let r = await t.api(pl).post(`/tasks/${ap.id}/move`, { columnId: review });
  assert.equal(r.statusCode, 400, 'ohne Prüfer abgelehnt');
  assert.equal((await t.api(pl).get(`/tasks/${ap.id}`)).json().task.columnId, inArbeit, 'nicht verschoben');
  r = await t.api(pl).post(`/tasks/${ap.id}/move`, { columnId: review, review: { reviewerUserId: t.ids.users.leser } });
  assert.equal(r.statusCode, 400, 'Leser prüfen nicht');
  r = await t.api(pl).post(`/tasks/${ap.id}/move`, { columnId: review, review: { reviewerUserId: t.ids.users.max } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().task.reviewer.userId, t.ids.users.max);
  assert.equal(r.json().task.reviewer.name, 'Max Keller');
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'task.review' and ref_id = $2 and event = 'review'`, [t.ids.users.max, ap.id]), 'Meldung an den Prüfer');
  const w = (await t.api(max).get('/my/waiting')).json();
  assert.ok(w.tasksInReview.some((x: any) => x.id === ap.id), 'Offen für dich');

  // Nur Prüfer oder PL entscheiden; Zurückweisen braucht einen Kommentar
  const anna = await t.login('anna@demo.local');
  const leser = await t.login('leser@demo.local');
  void anna;
  assert.equal((await t.api(leser).post(`/tasks/${ap.id}/review`, { decision: 'approve' })).statusCode, 403);
  assert.equal((await t.api(max).post(`/tasks/${ap.id}/review`, { decision: 'reject' })).statusCode, 400);
  r = await t.api(max).post(`/tasks/${ap.id}/review`, { decision: 'reject', comment: 'Quellen fehlen' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().task.columnId, inArbeit, 'zurück in die Spalte vor der Prüfung');
  assert.equal(r.json().task.reviewer, null);
  const log = (await t.db.query(`select body from task_comments where task_id = $1 order by created_at`, [ap.id])).rows.map((x: any) => x.body);
  assert.ok(log.some((b: string) => b.includes('Prüfung zurückgewiesen: Quellen fehlen')));
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'task.review_result' and ref_id = $2`, [t.ids.users.anna, ap.id]), 'Zuständige informiert');
  assert.equal((await t.db.one(`select count(*)::int as c from notifications where type = 'task.review' and ref_id = $1 and resolved_at is null`, [ap.id])).c, 0, 'Prüfmeldung erledigt');

  // Erneut zur Prüfung (PATCH mit columnId), dann freigeben → Erledigt
  r = await t.api(pl).patch(`/tasks/${ap.id}`, { columnId: review, reviewerUserId: t.ids.users.max });
  assert.equal(r.statusCode, 200, r.body);
  r = await t.api(max).post(`/tasks/${ap.id}/review`, { decision: 'approve' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().task.done, true);
  assert.equal((await t.api(max).post(`/tasks/${ap.id}/review`, { decision: 'approve' })).statusCode, 400, 'nicht mehr in Prüfung');
  await t.api(pl).patch(`/projects/${web()}`, { reviewRequired: false });
});

test('Prüfung einer Doku-Seite: Prüfer im Status-Menü, Pflicht, Meldung, Freigeben (final) und Zurückweisen (Entwurf)', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const page = (await t.api(max).post(`/projects/${web()}/docs/pages`, { title: 'Konzept Navigation' })).json().page;
  await t.api(pl).patch(`/projects/${web()}`, { reviewRequired: true });
  assert.equal((await t.api(max).post(`/docs/pages/${page.id}/status`, { status: 'review' })).statusCode, 400, 'Pflicht');
  let r = await t.api(max).post(`/docs/pages/${page.id}/status`, { status: 'review', reviewerUserId: t.ids.users.anna });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().page.reviewer.userId, t.ids.users.anna);
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'page.review' and ref_id = $2`, [t.ids.users.anna, page.id]));
  assert.ok(!(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'page.review' and ref_id = $2`, [t.ids.users.pl, page.id])), 'mit Prüfer nur an ihn');
  const anna = await t.login('anna@demo.local');
  assert.ok((await t.api(anna).get('/my/waiting')).json().pagesInReview.some((p: any) => p.id === page.id));
  assert.ok(!(await t.api(pl).get('/my/waiting')).json().pagesInReview.some((p: any) => p.id === page.id), 'PL sieht sie nicht als offen');
  // Zurückweisen mit Kommentar → Entwurf, Verfasser informiert
  r = await t.api(anna).post(`/docs/pages/${page.id}/status`, { status: 'draft', comment: 'Bitte Glossar ergänzen' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().page.status, 'draft');
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'page.review_result' and body like '%Glossar%'`, [t.ids.users.max]));
  // Prüfer ohne „Final setzen“ darf seine Seite freigeben
  await t.api(pl).patch(`/projects/${web()}`, { reviewRequired: false });
  await t.api(max).post(`/docs/pages/${page.id}/status`, { status: 'review', reviewerUserId: t.ids.users.max });
  r = await t.api(max).post(`/docs/pages/${page.id}/status`, { status: 'final' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().page.status, 'final');
  assert.equal(r.json().page.reviewer, null);
});

test('CSV: Parser, Datumsformate, Spaltenerkennung (Export des Boards und des Plans)', () => {
  assert.deepEqual(parseCsv('﻿A;B\r\n"x;y";"sagt ""hi"""\r\n;"zwei\nZeilen"\r\n'), [['A', 'B'], ['x;y', 'sagt "hi"'], ['', 'zwei\nZeilen']]);
  assert.deepEqual(parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
  assert.equal(parseDate('12.11.2026'), '2026-11-12');
  assert.equal(parseDate('1.2.27'), '2027-02-01');
  assert.equal(parseDate('2026-11-12'), '2026-11-12');
  assert.equal(parseDate('31.02.2026'), undefined);
  assert.equal(parseDate(''), null);
  assert.deepEqual(detectMapping(['Kennung', 'Titel', 'Status', 'Teilprojekt', 'Zuständig', 'Start', 'Fällig', 'Priorität', 'Labels', 'Blockiert', 'Erledigt', 'Übergeordnet']),
    ['key', 'title', 'status', 'subproject', 'responsible', 'start', 'due', 'priority', 'labels', 'ignore', 'ignore', 'parent']);
  assert.deepEqual(detectMapping(['Art', 'Bezeichnung', 'Start', 'Ende', 'Zuständig', 'Erledigt', 'Konflikt']), ['kind', 'title', 'start', 'due', 'responsible', 'status', 'ignore']);
});

test('CSV-Import: Trockenlauf mit Fehlern je Zeile, Import in einer Transaktion, Ebenen, Rechte, Audit', async () => {
  const pl = await t.login('pl@demo.local');
  const leser = await t.login('leser@demo.local');
  const csv = [
    'Ebene;Titel;Beschreibung;Teilprojekt;Zuständig;Start;Deadline;Priorität;Labels',
    '1;Import-AP Hosting;Server bestellen;Import-TP;max@demo.local;01.12.2026;15.12.2026;hoch;Infra, Neu-Label',
    '2;Angebote einholen;;;Anna Berger;;10.12.2026;;',
    '3;Anbieter A;;;;;;;',
    '3;Anbieter B;;;;;;;',
    '1;Import-AP kaputt;;;niemand;32.12.2026;;;',
    '3;Waise;;;;;;;'
  ].join('\n');
  assert.equal((await t.api(leser).post(`/projects/${web()}/import`, { csv })).statusCode, 403);
  let r = await t.api(pl).post(`/projects/${web()}/import`, { csv, dryRun: true });
  assert.equal(r.statusCode, 200, r.body);
  let res = r.json();
  assert.equal(res.dryRun, true);
  assert.deepEqual(res.counts.ap, 2); assert.equal(res.counts.aufgabe, 1); assert.equal(res.counts.item, 3);
  const bad = res.rows.find((x: any) => x.line === 5);
  assert.ok(bad.errors.some((e: string) => e.includes('niemand')), 'unbekannte Person');
  assert.ok(bad.errors.some((e: string) => e.includes('32.12.2026')), 'ungültiges Datum');
  assert.ok(res.rows.find((x: any) => x.line === 6).errors.length > 0, 'Checklistenpunkt ohne Aufgabe');
  assert.ok(res.rows.find((x: any) => x.line === 1).warnings.some((w: string) => w.includes('Import-TP')), 'Teilprojekt wird angelegt');
  const before = (await t.db.one(`select count(*)::int as c from tasks where project_id = $1`, [web()])).c;
  // Mit Fehlern: nichts angelegt
  r = await t.api(pl).post(`/projects/${web()}/import`, { csv, dryRun: false });
  assert.equal(r.statusCode, 400);
  assert.equal((await t.db.one(`select count(*)::int as c from tasks where project_id = $1`, [web()])).c, before);
  assert.equal(await t.db.maybeOne(`select 1 from subprojects where name = 'Import-TP'`), null, 'Transaktion: auch kein Teilprojekt');
  // Ohne die fehlerhaften Zeilen
  const ok = csv.split('\n').slice(0, 5).join('\n');
  r = await t.api(pl).post(`/projects/${web()}/import`, { csv: ok, dryRun: false });
  assert.equal(r.statusCode, 200, r.body);
  res = r.json();
  assert.deepEqual(res.created, { ap: 1, aufgabe: 1, item: 2 });
  const ap = await t.db.one(`select t.*, s.name as sp from tasks t join subprojects s on s.id = t.subproject_id where t.title = 'Import-AP Hosting'`);
  assert.equal(ap.sp, 'Import-TP'); assert.equal(ap.priority, 'high'); assert.equal(ap.responsible_user_id, t.ids.users.max);
  assert.equal(String(ap.due_date instanceof Date ? ap.due_date.toISOString() : ap.due_date).slice(0, 10), '2026-12-15');
  const auf = await t.db.one(`select * from tasks where parent_id = $1`, [ap.id]);
  assert.equal(auf.title, 'Angebote einholen'); assert.equal(auf.responsible_user_id, t.ids.users.anna);
  assert.equal((await t.db.one(`select count(*)::int as c from checklist_items where task_id = $1`, [auf.id])).c, 2);
  assert.equal((await t.db.one(`select count(*)::int as c from task_labels tl join labels l on l.id = tl.label_id where tl.task_id = $1`, [ap.id])).c, 2);
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'project.import' and project_id = $1`, [web()]));

  // Export des Boards wieder einlesen: Übergeordnet verweist auf eine Kennung in der Datei bzw. ein bestehendes AP
  const key = (await t.db.one(`select key from projects where id = $1`, [web()])).key;
  const n = (await t.db.one(`select number from tasks where id = $1`, [ap.id])).number;
  const exp = [
    'Kennung;Titel;Status;Teilprojekt;Zuständig;Start;Fällig;Priorität;Labels;Blockiert;Erledigt;Übergeordnet',
    `X-1;Re-Import AP;Erledigt;;Petra Lenz;;2026-12-20;normal;;;ja;`,
    `X-2;Re-Import Aufgabe;In Arbeit;;;;;low;;;;X-1`,
    `;Neue Aufgabe am alten AP;;;;;;;;;;${key}-${n}`
  ].join('\r\n');
  r = await t.api(pl).post(`/projects/${web()}/import`, { csv: exp, dryRun: false });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().created, { ap: 1, aufgabe: 2, item: 0 });
  const re = await t.db.one(`select t.*, c.is_done from tasks t join board_columns c on c.id = t.column_id where t.title = 'Re-Import AP'`);
  assert.equal(re.is_done, true);
  assert.ok(await t.db.maybeOne(`select 1 from tasks where title = 'Neue Aufgabe am alten AP' and parent_id = $1`, [ap.id]));
});
