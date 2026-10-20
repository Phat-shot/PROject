import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testApp } from './helpers.js';
import { dispatch, notify } from '../src/notify.js';
import { resolveRule } from '../src/rules.js';
import { runNotificationMails } from '../src/notifyMail.js';
import { runCleanup, runDailyRules } from '../src/worker.js';
import { beforeLocal, dueLocal } from '../src/localTime.js';
import { createDb, runMigrations } from '../src/db.js';

const t = await testApp();
test.after(() => t.close());
const web = () => t.ids.projects.web;
const U = () => t.ids.users;
const login = (who: 'admin' | 'pl' | 'anna' | 'max' | 'leser') => t.login(`${who}@demo.local`);
const notes = (userId: string, where = 'true', params: unknown[] = []) => t.db.query(`select * from notifications where user_id = $1 and ${where} order by created_at`, [userId, ...params]).then((r) => r.rows);
const newTask = async (title: string, extra: Record<string, unknown> = {}) => (await t.api(await login('pl')).post(`/projects/${web()}/tasks`, { title, ...extra })).json().task;
const konzept = async () => (await t.db.one(`select id from subprojects where project_id = $1 and name = 'Konzept & Design'`, [web()])).id as string;
const umsetzung = async () => (await t.db.one(`select id from subprojects where project_id = $1 and name = 'Umsetzung CMS'`, [web()])).id as string;
let geheim = '';

test('Regel N: Org-Sperre gewinnt, Klasse vor „*“ je Ebene, Benutzer am AP schlägt Benutzer; Mail-Modus steht in der Meldung', async () => {
  const admin = await login('admin');
  const max = await login('max');
  // Org: Entscheidungen sofort per Mail, gesperrt
  const org = await t.api(admin).put('/org/notification-rules', { rules: [{ event: 'decision', channels: { mail: 'now' }, locked: ['mail'] }] });
  assert.equal(org.statusCode, 200, org.body);
  assert.equal(org.json().effective.find((e: any) => e.event === 'decision').locked.mail, 'org');
  // Max: alles als Digest, Zuweisungen gar nicht per Mail
  const me = await t.api(max).put('/me/notification-rules', { rules: [{ event: '*', channels: { mail: 'digest' } }, { event: 'assigned', channels: { mail: 'off' } }] });
  assert.equal(me.statusCode, 200, me.body);
  const lock = await t.api(max).put('/me/notification-rules', { rules: [{ event: 'decision', channels: { mail: 'off' } }] });
  assert.equal(lock.statusCode, 400);
  assert.match(lock.json().error, /gesperrt \(Org\)/);
  const scope = { orgId: t.ids.org, projectId: web(), userId: U().max };
  const decision = await resolveRule(t.db, { ...scope, event: 'decision' });
  assert.equal(decision.value.mail, 'now', 'Sperre der Org schlägt das „*“ von Max');
  assert.equal(decision.origin.mail, 'org');
  assert.equal((await resolveRule(t.db, { ...scope, event: 'assigned' })).value.mail, 'off', 'Klasse vor „*“');
  assert.equal((await resolveRule(t.db, { ...scope, event: 'review' })).value.mail, 'digest');
  assert.equal((await resolveRule(t.db, { ...scope, event: 'escalation' })).origin.mail, 'user', 'Code-Standard „sofort“ überschrieben');
  // Benutzer am AP: Zwischenstände zu diesem AP sofort, obwohl „*“ auf Digest steht
  const ap = await newTask('Zwischenstände Regel N', { responsibleUserId: U().max });
  const wish = await t.api(max).put(`/me/notification-rules?taskId=${ap.id}`, { rules: [{ event: 'progress', channels: { mail: 'now' }, timing: { every: 'each' } }] });
  assert.equal(wish.statusCode, 200, wish.body);
  const atTask = await resolveRule(t.db, { ...scope, taskId: ap.id, event: 'progress' });
  assert.deepEqual([atTask.value.mail, atTask.origin.mail, atTask.value.every, atTask.origin.every], ['now', 'user_task', 'each', 'user_task']);
  assert.equal((await resolveRule(t.db, { ...scope, event: 'progress' })).value.mail, 'digest', 'ohne AP gilt „*“');
  // notify() schreibt Klasse, Bezug und den aufgelösten Modus in die Meldung
  await notify(t.db, { userId: U().max, projectId: web(), type: 'escalation', event: 'decision', title: 'Entscheidung nötig', ref: { type: 'task', id: ap.id } });
  await notify(t.db, { userId: U().max, projectId: web(), type: 'task.assigned', title: 'Zugewiesen (Test)', ref: { type: 'task', id: ap.id } });
  const [d, a] = (await notes(U().max, `title in ('Entscheidung nötig', 'Zugewiesen (Test)')`)).sort((x: any, y: any) => x.title.localeCompare(y.title));
  assert.deepEqual([d.event, d.mail, d.ref_type, d.ref_id], ['decision', 'now', 'task', ap.id]);
  assert.deepEqual([a.event, a.mail], ['assigned', 'off']);
  // Die Org hebt die Sperre auf: jetzt gilt das „*“ von Max
  await t.api(admin).put('/org/notification-rules', { rules: [{ event: 'decision', channels: { mail: 'now' } }] });
  assert.equal((await resolveRule(t.db, { ...scope, event: 'decision' })).value.mail, 'digest');
  // Projekt sperrt: Max im Projekt kann nicht abweichen, außerhalb gilt seine Regel
  const pl = await login('pl');
  assert.equal((await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: 'review', channels: { mail: 'now' }, locked: ['mail'] }] })).statusCode, 200);
  assert.equal((await resolveRule(t.db, { ...scope, event: 'review' })).value.mail, 'now', 'Projektsperre schlägt Benutzer');
  assert.equal((await t.api(max).put(`/me/notification-rules?projectId=${web()}`, { rules: [{ event: 'review', channels: { mail: 'off' } }] })).statusCode, 400);
  assert.equal((await resolveRule(t.db, { orgId: t.ids.org, projectId: t.ids.projects.erp, userId: U().max, event: 'review' })).value.mail, 'digest');
  await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: 'review' }] });
  await t.api(admin).put('/org/notification-rules', { rules: [{ event: 'decision' }] });
  await t.api(max).put('/me/notification-rules', { rules: [{ event: '*' }, { event: 'assigned' }] });
  assert.equal((await t.api(max).get('/me/notification-rules')).json().rules.length, 0, 'leere Zeilen werden gelöscht');
});

test('Regeln: Felder je Ebene, Werte, Empfänger und Rechte werden geprüft', async () => {
  const admin = await login('admin');
  const pl = await login('pl');
  const max = await login('max');
  const leser = await login('leser');
  const bad = async (c: any, url: string, rules: unknown[], status = 400) => {
    const r = await t.api(c).put(url, { rules });
    assert.equal(r.statusCode, status, `${url} ${JSON.stringify(rules)}: ${r.body}`);
  };
  await bad(max, '/org/notification-rules', [{ event: 'decision', channels: { mail: 'now' } }], 403);
  await bad(max, `/projects/${web()}/notification-rules`, [{ event: 'decision', channels: { mail: 'now' } }], 403);
  await bad(admin, `/projects/${web()}/notification-rules`, [{ event: 'decision', channels: { mail: 'now' } }], 403);
  // Benutzer: nur Chat (aus/Thread) und Mail
  await bad(max, '/me/notification-rules', [{ event: 'assigned', recipients: ['pl'] }]);
  await bad(max, '/me/notification-rules', [{ event: 'assigned', channels: { log: true } }]);
  await bad(max, '/me/notification-rules', [{ event: 'assigned', channels: { chat: 'project' } }]);
  await bad(max, '/me/notification-rules', [{ event: 'assigned', timing: { remindH: 4 } }]);
  await bad(max, '/me/notification-rules', [{ event: 'assigned', channels: { mail: 'later' } }]);
  await bad(max, `/me/notification-rules?projectId=${web()}`, [{ event: 'progress', timing: { every: 'each' } }]);
  const ap = await newTask('Regelprüfung', { responsibleUserId: U().max });
  await bad(max, `/me/notification-rules?taskId=${ap.id}`, [{ event: 'assigned', timing: { every: 'each' } }]);
  // Fragearten: der Chat ist die Frage selbst; Chat-Meldungen haben keinen Chat-Kanal
  await bad(admin, '/org/notification-rules', [{ event: 'question', channels: { chat: 'off' } }]);
  await bad(max, '/me/notification-rules', [{ event: 'chat', channels: { chat: 'thread' } }]);
  // Empfänger: bekannte Rollen, Gruppen und Personen des Mandanten
  await bad(admin, '/org/notification-rules', [{ event: 'blocked', recipients: ['chef'] }]);
  await bad(admin, '/org/notification-rules', [{ event: 'blocked', recipients: ['group:00000000-0000-4000-8000-000000000000'] }]);
  await bad(admin, '/org/notification-rules', [{ event: 'blocked', recipients: ['pl|chef'] }]);
  // Doku nur im Projekt, Sperren nur Org und Projekt, unbekannte Klasse oder Felder
  await bad(admin, '/org/notification-rules', [{ event: 'decision', channels: { doc: true } }]);
  await bad(pl, `/tasks/${ap.id}/notification-rules`, [{ event: 'progress', timing: { every: 'each' }, locked: ['every'] }]);
  await bad(admin, '/org/notification-rules', [{ event: 'sonstwas', channels: { mail: 'now' } }]);
  await bad(admin, '/org/notification-rules', [{ event: 'decision', channels: { every: 'each' } }]);
  await bad(admin, '/org/notification-rules', [{ event: 'decision', timing: { remindH: 0 } }]);
  // AP: PL alle Klassen, die zuständige Person nur Zwischenstände, Leser nichts
  await bad(max, `/tasks/${ap.id}/notification-rules`, [{ event: 'blocked', recipients: ['pl'] }], 403);
  const own = await t.api(max).put(`/tasks/${ap.id}/notification-rules`, { rules: [{ event: 'progress', recipients: ['pl'], timing: { every: 'milestones' } }] });
  assert.equal(own.statusCode, 200, own.body);
  assert.equal(own.json().canEditProgress, true);
  await bad(leser, `/tasks/${ap.id}/notification-rules`, [{ event: 'progress', recipients: ['pl'] }], 403);
  const other = await newTask('Fremdes AP');
  await bad(max, `/tasks/${other.id}/notification-rules`, [{ event: 'progress', recipients: ['pl'] }], 403);
  assert.equal((await t.api(pl).put(`/tasks/${ap.id}/notification-rules`, { rules: [{ event: 'blocked', recipients: ['pl', 'deputy_pl'] }] })).statusCode, 200);
  // Audit
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'notify.rule.set' and details->>'level' = 'task' and details->>'taskId' = $1`, [ap.id]));
  // Feste Kanäle: „*“ auf aus ändert weder Fragen (Chat ist die Frage) noch Chat-Meldungen (kein Chat-Kanal)
  assert.equal((await t.api(admin).put('/org/notification-rules', { rules: [{ event: '*', channels: { chat: 'off' } }] })).statusCode, 200);
  assert.equal((await t.api(max).put('/me/notification-rules', { rules: [{ event: '*', channels: { chat: 'thread' } }] })).statusCode, 200);
  const sc = { orgId: t.ids.org, projectId: web(), userId: U().max };
  assert.deepEqual([(await resolveRule(t.db, { ...sc, event: 'question' })).value.chat, (await resolveRule(t.db, { ...sc, event: 'chat' })).value.chat, (await resolveRule(t.db, { ...sc, event: 'blocked' })).value.chat], ['thread', 'off', 'thread']);
  const sa = { orgId: t.ids.org, projectId: web(), userId: U().anna };
  assert.deepEqual([(await resolveRule(t.db, { ...sa, event: 'question' })).value.chat, (await resolveRule(t.db, { ...sa, event: 'blocked' })).value.chat], ['thread', 'off'], 'ohne eigene Regel: Org „aus“ gilt, außer bei Fragen');
  await t.api(admin).put('/org/notification-rules', { rules: [{ event: '*' }] });
  await t.api(max).put('/me/notification-rules', { rules: [{ event: '*' }] });
  // Projekt gegen Org-Sperre: das gesperrte Feld nicht, andere Felder und „*“ schon (die Sperre gilt je Klasse)
  await t.api(admin).put('/org/notification-rules', { rules: [{ event: 'review', channels: { mail: 'now' }, locked: ['mail'] }] });
  const locked = await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: 'review', channels: { mail: 'off' } }] });
  assert.equal(locked.statusCode, 400);
  assert.match(locked.json().error, /gesperrt \(Org\)/);
  assert.equal((await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: 'review', channels: { chat: 'project' } }] })).statusCode, 200);
  const star = await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: '*', channels: { mail: 'off' } }] });
  assert.equal(star.statusCode, 200, star.body);
  assert.equal(star.json().effective.find((e: any) => e.event === 'review').value.mail, 'now', 'Org-Sperre schlägt das „*“ des Projekts');
  assert.equal(star.json().effective.find((e: any) => e.event === 'assigned').value.mail, 'off');
  await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: 'review' }, { event: '*' }] });
  await t.api(admin).put('/org/notification-rules', { rules: [{ event: 'review' }] });
});

test('dispatch: Rollen mit „sonst“, Auslöser, Gruppen nur mit Projektzugriff und Sicht auf das Teilprojekt', async () => {
  const pl = await login('pl');
  const anna = await login('anna');
  const max = await login('max');
  const admin = await login('admin');
  // Blockiert (Standard: TP-Verantwortung, sonst PL): im Teilprojekt von Max geht die Meldung an Max, nicht an die PL
  const a1 = await newTask('Blockiert im Konzept', { subprojectId: await konzept() });
  assert.equal((await t.api(anna).patch(`/tasks/${a1.id}`, { blocked: true, blockedReason: 'Lizenz' })).statusCode, 200);
  assert.equal((await notes(U().max, `title = 'Blockiert: Blockiert im Konzept'`)).map((n: any) => n.event).join(), 'blocked');
  assert.equal((await notes(U().pl, `title = 'Blockiert: Blockiert im Konzept'`)).length, 0, '„sonst PL“ nur ohne TP-Verantwortung');
  // Log (Standard bei „blockiert“): die Aufrufstelle schreibt selbst, das System nicht noch einmal
  assert.deepEqual((await t.db.query(`select body from task_comments where task_id = $1 and source = 'system'`, [a1.id])).rows.map((r: any) => r.body), ['Blockiert gemeldet: Lizenz. Teilprojekt-Verantwortung wird informiert.']);
  // Ohne TP-Verantwortung: die PL
  const a2 = await newTask('Blockiert in Umsetzung', { subprojectId: await umsetzung() });
  await t.api(anna).patch(`/tasks/${a2.id}`, { blocked: true, blockedReason: 'Server' });
  assert.equal((await notes(U().pl, `title = 'Blockiert: Blockiert in Umsetzung'`)).length, 1);
  // Der Auslöser bekommt nichts: Max meldet selbst, die Alternative greift (PL)
  const a3 = await newTask('Max blockiert selbst', { subprojectId: await konzept() });
  await t.api(max).patch(`/tasks/${a3.id}`, { blocked: true, blockedReason: 'Urlaub' });
  assert.equal((await notes(U().max, `title = 'Blockiert: Max blockiert selbst'`)).length, 0);
  assert.equal((await notes(U().pl, `title = 'Blockiert: Max blockiert selbst'`)).length, 1);

  // Gruppe als Empfänger: Max und Lea sind Mitglied, Alex (Org-Admin) hat keinen Projektzugriff; im eingeschränkten Teilprojekt nur Max
  const g = (await t.api(admin).post('/groups', { name: 'Bereitschaft', memberIds: [U().max, U().leser, U().admin] })).json().group;
  const sp = await t.api(pl).post(`/projects/${web()}/subprojects`, { name: 'Geheim', restricted: true, accessUserIds: [U().max] });
  assert.equal(sp.statusCode, 200, sp.body);
  geheim = sp.json().subproject.id;
  assert.equal((await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: 'blocked', recipients: [`group:${g.id}`] }] })).statusCode, 200);
  const open = await newTask('Blockiert offen', { subprojectId: await umsetzung() });
  await t.api(pl).patch(`/tasks/${open.id}`, { blocked: true, blockedReason: 'x' });
  assert.equal((await notes(U().max, `title = 'Blockiert: Blockiert offen'`)).length, 1);
  assert.equal((await notes(U().leser, `title = 'Blockiert: Blockiert offen'`)).length, 1, 'Leser mit Projektzugriff');
  assert.equal((await notes(U().admin, `title = 'Blockiert: Blockiert offen'`)).length, 0, 'ohne Projektzugriff nichts');
  assert.equal((await notes(U().pl, `title = 'Blockiert: Blockiert offen'`)).length, 0, 'Regel ersetzt den Standard');
  const hidden = await newTask('Blockiert geheim', { subprojectId: geheim });
  await t.api(pl).patch(`/tasks/${hidden.id}`, { blocked: true, blockedReason: 'y' });
  assert.equal((await notes(U().max, `title = 'Blockiert: Blockiert geheim'`)).length, 1);
  assert.equal((await notes(U().leser, `title = 'Blockiert: Blockiert geheim'`)).length, 0, 'keine Sicht auf das eingeschränkte Teilprojekt');
  // Empfänger der Aufrufstelle ohne Sicht fallen ebenso heraus
  const sent = await dispatch(t.db, { event: 'review', projectId: web(), taskId: hidden.id, users: [U().leser, U().anna, U().max], type: 'page.review', title: 'Prüfung geheim', actorId: U().max });
  assert.deepEqual(sent, [U().anna], 'Leser ohne Sicht und Auslöser fallen heraus');
  assert.deepEqual(await dispatch(t.db, { event: 'review', projectId: web(), taskId: open.id, users: [U().admin, U().leser], type: 'page.review', title: 'Prüfung offen' }), [U().leser], 'ohne Projektzugriff (Org-Admin) fällt heraus');
  await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: 'blocked' }] });

  // Kommentare (Klasse log): Erwähnte bekommen den eigenen Typ, Beteiligte den Kommentar, jede Person nur einmal
  const c = await newTask('Kommentarrunde', { responsibleUserId: U().max });
  await t.api(anna).post(`/tasks/${c.id}/comments`, { body: 'Erster Stand' });
  await t.api(pl).post(`/tasks/${c.id}/comments`, { body: '@Max Keller und @Anna Berger bitte prüfen' });
  const mx = await notes(U().max, `ref_id = $2 and event = 'log'`, [c.id]);
  assert.deepEqual(mx.map((n: any) => n.type).sort(), ['mention', 'task.comment'], 'Max: Kommentar von Anna, dann Erwähnung statt Kommentar');
  const an = await notes(U().anna, `ref_id = $2 and event = 'log'`, [c.id]);
  assert.deepEqual(an.map((n: any) => n.type), ['mention']);
  assert.equal((await notes(U().pl, `ref_id = $2 and event = 'log'`, [c.id])).length, 0, 'Auslöser');
});

test('Kanäle des Ereignisses: Systembeitrag im Projektkanal (nicht bei eingeschränktem TP), Log einmal je Ereignis, Seite „Entscheidungen und Meldungen“', async () => {
  const pl = await login('pl');
  const max = await login('max');
  const r = await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: 'assigned', recipients: ['responsible', 'pl', 'deputy_pl'], channels: { chat: 'project', log: true } }] });
  assert.equal(r.statusCode, 200, r.body);
  const ap = await newTask('Kanaltest', { responsibleUserId: U().max });
  // Empfänger: Max und Anna (Petra löst aus), je eine Meldung; Log und Chat je einmal
  assert.equal((await notes(U().max, `ref_id = $2 and type = 'task.assigned'`, [ap.id])).length, 1);
  assert.equal((await notes(U().anna, `ref_id = $2 and type = 'task.assigned'`, [ap.id])).length, 1);
  const logs = await t.db.query(`select * from task_comments where task_id = $1 and source = 'system' and body like 'Zuweisung:%'`, [ap.id]);
  assert.equal(logs.rows.length, 1, 'Log einmal je Ereignis, nicht je Person');
  const chat = (await t.api(max).get(`/projects/${web()}/chat`)).json();
  const sys = chat.messages.filter((m: any) => m.kind === 'system' && m.body.includes('Kanaltest'));
  assert.equal(sys.length, 1, 'ein Systembeitrag im Projektkanal');
  assert.equal(sys[0].userName, 'Petra Lenz');
  assert.equal(sys[0].meta.event, 'assigned');
  assert.equal(sys[0].meta.link, `/projekte/${web()}/board?task=${ap.id}`);
  // Systembeiträge erzeugen keine Chat-Meldungen und lassen sich nicht bearbeiten; die PL darf sie löschen
  assert.equal((await notes(U().max, `event = 'chat' and body like '%Kanaltest%'`)).length, 0);
  assert.equal((await t.api(pl).patch(`/chat/messages/${sys[0].id}`, { body: 'geändert' })).statusCode, 403);
  // Systembeitrag mit der auslösenden Person als Autor: auch sie löscht ihn nicht, nur die PL
  await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: 'blocked', channels: { chat: 'project' } }] });
  const blocked = await newTask('Blockiert im Kanal', { responsibleUserId: U().max });
  assert.equal((await t.api(max).patch(`/tasks/${blocked.id}`, { blocked: true, blockedReason: 'Teile fehlen' })).statusCode, 200);
  const sysB = (await t.api(max).get(`/projects/${web()}/chat`)).json().messages.find((m: any) => m.kind === 'system' && m.meta?.event === 'blocked' && m.body.includes('Blockiert im Kanal'));
  assert.equal(sysB.userId, U().max, 'Autor ist, wer blockiert gemeldet hat');
  assert.equal((await t.api(max).del(`/chat/messages/${sysB.id}`)).statusCode, 403);
  assert.equal((await t.api(pl).del(`/chat/messages/${sysB.id}`)).statusCode, 200);
  assert.equal((await t.api(max).get(`/projects/${web()}/chat`)).json().messages.find((m: any) => m.id === sysB.id)?.deleted, true);
  await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: 'blocked' }] });
  // Eingeschränktes Teilprojekt: kein Beitrag im Projektkanal
  const hidden = await newTask('Kanaltest geheim', { subprojectId: geheim, responsibleUserId: U().max });
  const chat2 = (await t.api(max).get(`/projects/${web()}/chat`)).json();
  assert.equal(chat2.messages.filter((m: any) => m.body.includes('Kanaltest geheim')).length, 0);
  assert.equal((await notes(U().max, `ref_id = $2`, [hidden.id])).length, 1, 'In-App kommt trotzdem');
  await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: 'assigned' }] });

  // Doku: Einschalten legt die Seite an (erst wenn alle Zeilen geprüft sind); Eskalationen werden eingetragen, nicht aus eingeschränkten Teilprojekten
  const pages = () => t.db.one(`select count(*)::int as c from doc_pages where project_id = $1 and title = 'Entscheidungen und Meldungen' and deleted_at is null`, [web()]).then((r) => r.c as number);
  assert.equal((await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: 'decision', channels: { doc: true } }, { event: 'escalation', channels: { mail: 'später' } }] })).statusCode, 400);
  assert.equal(await pages(), 0, 'keine verwaiste Seite nach abgewiesenem Aufruf');
  const on = await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: 'decision', channels: { doc: true } }, { event: 'escalation', channels: { doc: true } }] });
  assert.equal(on.statusCode, 200, on.body);
  const pageId = on.json().effective.find((e: any) => e.event === 'escalation').value.doc;
  const page = await t.db.one(`select * from doc_pages where id = $1`, [pageId]);
  assert.equal(page.title, 'Entscheidungen und Meldungen');
  assert.equal(on.json().effective.find((e: any) => e.event === 'decision').value.doc, pageId, 'eine Seite je Projekt');
  assert.equal(on.json().effective.find((e: any) => e.event === 'blocked').value.doc, false);
  // Zeile mit eingeschalteter Seite ändern: die Seiten-ID kommt zurück (so schickt die Oberfläche die Zeile), nur Seiten dieses Projekts
  const withPage = await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: 'decision', channels: { doc: pageId, mail: 'now' } }] });
  assert.equal(withPage.statusCode, 200, withPage.body);
  assert.deepEqual([withPage.json().effective.find((e: any) => e.event === 'decision').value.doc, withPage.json().effective.find((e: any) => e.event === 'decision').value.mail], [pageId, 'now']);
  const foreign = await t.db.one(`insert into doc_pages (project_id, title, content_md, content_html, created_by, updated_by) values ($1,'Fremde Seite','','',$2,$2) returning id`, [t.ids.projects.erp, U().anna]);
  const bad = await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: 'decision', channels: { doc: foreign.id } }] });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /Seite nicht in diesem Projekt/);
  assert.equal((await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: 'decision', channels: { doc: 'ja' } }] })).statusCode, 400);
  // Aus und wieder ein: dieselbe Seite, keine zweite
  await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: 'decision', channels: { doc: false } }, { event: 'escalation', channels: { doc: false } }] });
  const again = await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: 'decision', channels: { doc: true } }, { event: 'escalation', channels: { doc: true } }] });
  assert.equal(again.json().effective.find((e: any) => e.event === 'escalation').value.doc, pageId, 'bestehende Seite wird wiederverwendet');
  assert.equal(await pages(), 1);
  const e1 = await newTask('Eskalation Doku', { responsibleUserId: U().max });
  assert.equal((await t.api(pl).post(`/tasks/${e1.id}/escalate`, { level: 1, note: 'Freigabe fehlt' })).statusCode, 200);
  const e2 = await newTask('Eskalation geheim Doku', { subprojectId: geheim, responsibleUserId: U().max });
  await t.api(pl).post(`/tasks/${e2.id}/escalate`, { level: 1 });
  const after = await t.db.one(`select content_md, version from doc_pages where id = $1`, [pageId]);
  assert.match(after.content_md, /\*\*\d\d\.\d\d\.\d{4} \d\d:\d\d\*\* · Eskalation · WEB-\d+ · Eskalation Stufe 1: Teilprojekt-Verantwortung: Eskalation Doku: .*Freigabe fehlt/);
  assert.doesNotMatch(after.content_md, /geheim/);
  assert.equal(after.version, 2);
  await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: 'decision' }, { event: 'escalation' }] });
});

test('Persönliches Projekt: nie Chat im Projektkanal', async () => {
  const admin = await login('admin');
  const pl = await login('pl');
  await t.api(admin).put('/org/settings', { personalProjects: true });
  const own = (await t.api(pl).post('/projects', { key: 'PNR', name: 'Petra Regeln', personal: true })).json().project;
  await t.api(pl).put(`/projects/${own.id}/notification-rules`, { rules: [{ event: '*', channels: { chat: 'project' } }] });
  const ap = (await t.api(pl).post(`/projects/${own.id}/tasks`, { title: 'Privat' })).json().task;
  await dispatch(t.db, { event: 'escalation', projectId: own.id, taskId: ap.id, users: [U().pl], type: 'escalation', title: 'Persönlich eskaliert' });
  assert.equal((await t.db.query(`select 1 from chat_messages m join chat_channels c on c.id = m.channel_id where c.project_id = $1`, [own.id])).rows.length, 0);
  assert.equal((await notes(U().pl, `title = 'Persönlich eskaliert'`)).length, 1);
});

test('Chat: Lesen markiert die Chat-Meldungen des Kanals bzw. Threads, nicht Meldungen zu Fragen', async () => {
  const pl = await login('pl');
  const max = await login('max');
  const dm = (await t.api(pl).post('/chat/dm', { userId: U().max })).json().channelId;
  await t.api(pl).post(`/chat/channels/${dm}/messages`, { body: 'Kurze Frage zum Angebot' });
  const [n] = await notes(U().max, `type = 'chat.dm' and body = 'Kurze Frage zum Angebot'`);
  assert.deepEqual([n.event, n.ref_type, n.ref_id, n.read_at], ['chat', 'chat_channel', dm, null]);
  await t.api(max).get(`/chat/channels/${dm}/messages`);
  assert.ok((await notes(U().max, `id = $2`, [n.id]))[0].read_at, 'Kanal gelesen: Meldung gelesen');

  const channel = (await t.api(pl).get(`/projects/${web()}/chat`)).json().channel.id;
  const root = (await t.api(max).post(`/chat/channels/${channel}/messages`, { body: 'Thread zur Abnahme' })).json().message;
  await t.api(pl).post(`/chat/channels/${channel}/messages`, { body: 'Antwort im Thread', threadId: root.id });
  const [reply] = await notes(U().max, `type = 'chat.reply' and ref_id = $2`, [root.id]);
  assert.equal(reply.ref_type, 'chat_thread');
  // Frage im selben Thread (Klasse question): bleibt offen, bis sie beantwortet ist
  await notify(t.db, { userId: U().max, projectId: web(), type: 'question', event: 'question', title: 'Frage im Thread', ref: { type: 'chat_thread', id: root.id } });
  await t.api(max).get(`/projects/${web()}/chat`);
  assert.equal((await notes(U().max, `id = $2`, [reply.id]))[0].read_at, null, 'Kanal lesen markiert keine Thread-Meldungen');
  await t.api(max).get(`/chat/channels/${channel}/messages?thread=${root.id}`);
  assert.ok((await notes(U().max, `id = $2`, [reply.id]))[0].read_at, 'Thread gelesen');
  assert.equal((await notes(U().max, `title = 'Frage im Thread'`))[0].read_at, null, 'Meldung zur Frage bleibt ungelesen');
  // Meldung mit eigenem Thread (Frage, Auftrag): ein Systembeitrag in diesem Thread je Ereignis, nicht je Person
  const sent = await dispatch(t.db, { event: 'decision', projectId: web(), users: [U().max, U().anna], type: 'escalation', title: 'Bitte im Thread entscheiden', thread: { channelId: channel, messageId: root.id }, actorId: U().pl });
  assert.deepEqual(sent.sort(), [U().max, U().anna].sort());
  const inThread = await t.db.query(`select kind, user_id from chat_messages where thread_id = $1 and body like 'Bitte im Thread entscheiden%'`, [root.id]);
  assert.deepEqual(inThread.rows.map((r: any) => [r.kind, r.user_id]), [['system', U().pl]]);
});

test('GET /notifications: Klasse, Bezug, Mail-Modus und Filter', async () => {
  const max = await login('max');
  await notify(t.db, { userId: U().max, projectId: t.ids.projects.erp, type: 'task.overdue', title: 'Filter ERP' });
  const all = (await t.api(max).get('/notifications')).json();
  const f = all.notifications.find((n: any) => n.title === 'Filter ERP');
  assert.deepEqual([f.event, f.mail, f.ref], ['due', 'digest', null]);
  const due = (await t.api(max).get('/notifications?event=due')).json().notifications;
  assert.ok(due.length >= 1 && due.every((n: any) => n.event === 'due'));
  const erp = (await t.api(max).get(`/notifications?projectId=${t.ids.projects.erp}`)).json().notifications;
  assert.ok(erp.some((n: any) => n.title === 'Filter ERP') && erp.every((n: any) => n.projectId === t.ids.projects.erp));
  await t.api(max).post('/notifications/read', { ids: [f.id] });
  const unread = (await t.api(max).get('/notifications?unread=1')).json();
  assert.ok(unread.notifications.every((n: any) => !n.readAt) && !unread.notifications.some((n: any) => n.id === f.id));
  assert.equal((await t.api(max).get('/notifications?event=quatsch')).statusCode, 400);
  assert.equal((await t.api(max).get('/notifications?projectId=abc')).statusCode, 400, 'ungültige Projekt-ID ist kein Serverfehler');
});

test('Mail am AP (Klasse mail_in): neue Zuordnung schreibt einmal ins Log, Meldungen nur nach Regel und nie an die zuordnende Person', async () => {
  const pl = await login('pl');
  const mail = (await t.api(pl).get(`/mail/views/${t.ids.views.project}/mails`)).json().mails[0];
  const row = await t.db.one(`select subject, from_addr from mails where id = $1`, [mail.id]);
  const logs = (taskId: string) => t.db.query(`select body from task_comments where task_id = $1 and source = 'system' and body like 'Mail am AP:%'`, [taskId]).then((r) => r.rows);
  const ap = await newTask('Mail-Zuordnung', { responsibleUserId: U().max });
  assert.equal((await t.api(pl).post(`/mail/mails/${mail.id}/link`, { taskId: ap.id })).statusCode, 200);
  assert.deepEqual((await logs(ap.id)).map((r: any) => r.body), [`Mail am AP: Mail von ${row.from_addr}: ${row.subject}`]);
  assert.equal((await notes(U().max, `ref_id = $2 and event = 'mail_in'`, [ap.id])).length, 0, 'Standard: niemand, nur Log');
  // Dieselbe Mail noch einmal (als Kopie): kein zweiter Log-Eintrag
  assert.equal((await t.api(pl).post(`/mail/mails/${mail.id}/link`, { taskId: ap.id, copy: true, confirmed: true })).statusCode, 200);
  assert.equal((await logs(ap.id)).length, 1);
  assert.equal((await t.db.one(`select copied from mail_task_links where mail_id = $1 and task_id = $2`, [mail.id, ap.id])).copied, true, 'Kopie bleibt gesetzt');
  // Projektregel: Zuständige(r) bekommt die Meldung, nicht wer zuordnet
  await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: 'mail_in', recipients: ['responsible'] }] });
  const ap2 = await newTask('Mail-Zuordnung mit Regel', { responsibleUserId: U().max });
  await t.api(pl).post(`/mail/mails/${mail.id}/link`, { taskId: ap2.id });
  const n = await notes(U().max, `ref_id = $2 and event = 'mail_in'`, [ap2.id]);
  assert.equal(n.length, 1);
  assert.deepEqual([n[0].type, n[0].title, n[0].dedupe_key], ['mail.in', `Mail von ${row.from_addr}: ${row.subject}`, `mail_in:${mail.id}:${ap2.id}`]);
  assert.equal((await notes(U().pl, `ref_id = $2 and event = 'mail_in'`, [ap2.id])).length, 0, 'Auslöser');
  // Mail als Log-Eintrag: die Aufrufstelle schreibt selbst ins Log, das System nicht noch einmal; die Meldung kommt trotzdem
  const ap3 = await newTask('Mail als Log', { responsibleUserId: U().max });
  assert.equal((await t.api(pl).post(`/mail/mails/${mail.id}/to-task-log`, { taskId: ap3.id, confirmed: true })).statusCode, 200);
  assert.equal((await logs(ap3.id)).length, 0);
  assert.equal((await notes(U().max, `ref_id = $2 and event = 'mail_in'`, [ap3.id])).length, 1);
  // Automatische Zuordnung über die Antwortadresse (ohne Auslöser): Log und Meldung an die zuständige Person
  const ap4 = await newTask('Antwort von extern', { responsibleUserId: U().max });
  const code = (await t.db.one(`select mail_code from tasks where id = $1`, [ap4.id])).mail_code;
  t.mail.dev.inject(t.ids.accounts.project, { from: { address: 'lieferant@extern.de', name: 'Lieferant' }, to: [`projekt-web+t${code}@demo.local`], subject: 'Re: Liefertermin', text: 'Passt.', folder: 'INBOX' } as any);
  await t.mail.syncAccount(t.ids.accounts.project);
  assert.deepEqual((await logs(ap4.id)).map((r: any) => r.body), ['Mail am AP: Mail von lieferant@extern.de: Re: Liefertermin']);
  assert.equal((await notes(U().max, `ref_id = $2 and event = 'mail_in'`, [ap4.id])).length, 1);
  await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: 'mail_in' }] });
});

test('PATCH /me mit mailNotifications schreibt die Benutzerregel „*“ (Übergang)', async () => {
  const anna = await login('anna');
  await t.api(anna).patch('/me', { settings: { mailNotifications: 'immediate' } });
  const rule = await t.db.one(`select channels from notification_rules where user_id = $1 and event = '*' and project_id is null`, [U().anna]);
  assert.equal(rule.channels.mail, 'now');
  await t.api(anna).put('/me/notification-rules', { rules: [{ event: '*', channels: { mail: 'now', chat: 'off' } }] });
  await t.api(anna).patch('/me', { settings: { mailNotifications: 'off' } });
  const after = await t.db.one(`select channels from notification_rules where user_id = $1 and event = '*' and project_id is null`, [U().anna]);
  assert.deepEqual(after.channels, { mail: 'off', chat: 'off' }, 'andere Angaben bleiben');
  assert.equal((await t.db.one(`select settings from users where id = $1`, [U().anna])).settings.mailNotifications, 'off', 'Einstellung wird mitgeschrieben');
});

test('Migration: Mail-Modus aus users.settings wird Benutzerregel, offene Meldungen behalten ihn, Klassen und Bezüge', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = path.resolve(here, '..', 'migrations');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mig-'));
  for (const f of (await readdir(src)).filter((x) => x.endsWith('.sql') && x < '047')) await symlink(path.join(src, f), path.join(dir, f));
  const db = await createDb();
  try {
    await runMigrations(db, dir);
    const org = await db.one(`insert into orgs (name) values ('Alt') returning id`);
    const mk = (email: string, settings: unknown) => db.one(`insert into users (org_id, email, name, password_hash, global_role, settings) values ($1,$2,$2,'x','user',$3) returning id`, [org.id, email, JSON.stringify(settings)]);
    const sofort = (await mk('a@x.de', { mailNotifications: 'immediate' })).id;
    const aus = (await mk('b@x.de', { mailNotifications: 'off' })).id;
    const ohne = (await mk('c@x.de', {})).id;
    const cid = '11111111-1111-4111-8111-111111111111';
    await db.query(`insert into notifications (user_id, type, title, link) values ($1,'task.assigned','A',null), ($1,'chat.reply','B','/chat/${cid}?thread=${cid}'), ($2,'escalation','Blockiert: X',null), ($3,'mention','C','/projekte/p/board?task=${cid}')`, [sofort, aus, ohne]);
    await db.exec(await readFile(path.join(src, '047_notification_rules.sql'), 'utf8'));
    const rules = (await db.query(`select user_id, event, channels from notification_rules order by user_id`)).rows;
    assert.deepEqual(rules.map((r: any) => [r.user_id, r.event, r.channels.mail]).sort(), [[sofort, '*', 'now'], [aus, '*', 'off']].sort(), 'nur wer eine Einstellung hatte');
    const n = Object.fromEntries((await db.query(`select title, mail, event, ref_type, ref_id from notifications`)).rows.map((r: any) => [r.title, r]));
    assert.deepEqual([n.A.mail, n.A.event], ['now', 'assigned']);
    assert.deepEqual([n.B.mail, n.B.event, n.B.ref_type, n.B.ref_id], ['now', 'chat', 'chat_thread', cid]);
    assert.deepEqual([n['Blockiert: X'].mail, n['Blockiert: X'].event], ['off', 'blocked']);
    assert.deepEqual([n.C.mail, n.C.event, n.C.ref_type], ['digest', 'log', 'task']);
  } finally { await db.close(); }
});

test('notifyMail: PDF nur an interne Empfänger mit Leserecht, Fehler ins Audit, ohne Org-Postfach Lieferungen über das Projektkonto', async () => {
  const page = await t.db.one(`select id, title from doc_pages where project_id = $1 and deleted_at is null order by created_at limit 1`, [web()]);
  await t.db.query(`update notifications set mailed_at = now() where mailed_at is null`);
  const pl = await login('pl');
  const admin = await login('admin');
  await t.api(pl).put('/me/notification-rules', { rules: [{ event: '*', channels: { mail: 'now' } }] });
  await t.api(admin).put('/me/notification-rules', { rules: [{ event: '*', channels: { mail: 'now' } }] });
  await notify(t.db, { userId: U().pl, projectId: web(), type: 'report.sent', title: 'Lieferung Petra', ref: { type: 'page', id: page.id }, attach: true });
  await notify(t.db, { userId: U().admin, projectId: web(), type: 'report.sent', title: 'Lieferung Admin', ref: { type: 'page', id: page.id }, attach: true });
  const before = t.mail.dev.sent.length;
  await runNotificationMails(t.db, t.mail, new Date('2026-10-23T06:00:00Z'));
  const sent = t.mail.dev.sent.slice(before);
  const toPl = sent.find((m) => m.msg.to.includes('pl@demo.local'))!;
  const toAdmin = sent.find((m) => m.msg.to.includes('admin@demo.local'))!;
  assert.equal(toPl.msg.attachments?.length, 1);
  assert.equal(toPl.msg.attachments![0].content.subarray(0, 4).toString(), '%PDF');
  assert.equal(toAdmin.msg.attachments?.length ?? 0, 0, 'ohne Projektzugriff kein Anhang');

  // Fehler beim Versand: Audit notify.mail_failed (höchstens einmal je Stunde), Meldung bleibt offen
  await notify(t.db, { userId: U().pl, projectId: web(), type: 'report.sent', title: 'Fehlversuch' });
  const orig = t.mail.sendFromAccount.bind(t.mail);
  t.mail.sendFromAccount = async () => { throw new Error('SMTP weg'); };
  try {
    await runNotificationMails(t.db, t.mail, new Date('2026-10-23T06:01:00Z'));
    await runNotificationMails(t.db, t.mail, new Date('2026-10-23T06:02:00Z'));
  } finally { t.mail.sendFromAccount = orig; }
  const failed = await t.db.query(`select details from audit_log where action = 'notify.mail_failed' and object_id = $1`, [U().pl]);
  assert.equal(failed.rows.length, 1);
  assert.match(failed.rows[0].details.error, /SMTP weg/);
  assert.equal((await notes(U().pl, `title = 'Fehlversuch'`))[0].mailed_at, null);
  await t.db.query(`update notifications set mailed_at = now() where mailed_at is null`);

  // Ohne Org-Postfach: nur Lieferungen, einzeln über das Projektkonto
  // Org-Bindung vorübergehend lösen (das Konto bleibt), danach wieder setzen
  const orgUse = await t.db.maybeOne(`delete from mail_account_uses where use = 'org' and org_id = $1 returning account_id`, [t.ids.org]);
  await notify(t.db, { userId: U().pl, projectId: web(), type: 'report.sent', title: 'Lieferung ohne Org', ref: { type: 'page', id: page.id }, attach: true });
  await notify(t.db, { userId: U().pl, projectId: web(), type: 'report.sent', title: 'Ohne Anhang' });
  const b2 = t.mail.dev.sent.length;
  await runNotificationMails(t.db, t.mail, new Date('2026-10-23T06:10:00Z'));
  const s2 = t.mail.dev.sent.slice(b2).filter((m) => m.msg.to.includes('pl@demo.local'));
  assert.equal(s2.length, 1);
  assert.equal(s2[0].msg.from.address, 'projekt-web@demo.local');
  assert.match(String(s2[0].msg.subject), /Lieferung ohne Org/);
  assert.equal((await notes(U().pl, `title = 'Ohne Anhang'`))[0].mailed_at, null, 'normale Meldungen brauchen das Org-Postfach');
  if (orgUse) await t.db.query(`insert into mail_account_uses (org_id, account_id, use) values ($1,$2,'org')`, [t.ids.org, orgUse.account_id]);
  await t.api(pl).put('/me/notification-rules', { rules: [{ event: '*' }] });
  await t.api(admin).put('/me/notification-rules', { rules: [{ event: '*' }] });
});

test('dueLocal: Ortszeit Europe/Berlin, einmal je Tag, werktags', () => {
  assert.equal(dueLocal(new Date('2026-10-18T04:59:00Z'), 7, null), false, '06:59 Berlin');
  assert.equal(dueLocal(new Date('2026-10-18T05:00:00Z'), 7, null), true, '07:00 Berlin (Sommerzeit)');
  assert.equal(dueLocal(new Date('2026-12-18T05:30:00Z'), 7, null), false, 'Winterzeit: 06:30 Berlin');
  assert.equal(dueLocal(new Date('2026-12-18T06:00:00Z'), 7, null), true);
  assert.equal(dueLocal(new Date('2026-10-18T09:00:00Z'), 7, new Date('2026-10-18T05:10:00Z')), false, 'heute schon gelaufen');
  assert.equal(dueLocal(new Date('2026-10-18T09:00:00Z'), 7, new Date('2026-10-18T04:00:00Z')), true, 'heute nur vor der Uhrzeit');
  assert.equal(dueLocal(new Date('2026-10-18T22:30:00Z'), 7, new Date('2026-10-18T05:10:00Z')), false, '00:30 Berlin am 19.: neuer Tag, aber vor 7 Uhr');
  assert.equal(dueLocal(new Date('2026-10-19T05:30:00Z'), 7, new Date('2026-10-18T05:10:00Z')), true, '07:30 Berlin am 19.');
  assert.equal(dueLocal(new Date('2026-10-17T08:00:00Z'), '06:45', null, { weekdays: true }), false, 'Samstag');
  assert.equal(dueLocal(new Date('2026-10-19T05:00:00Z'), '06:45', null, { weekdays: true }), true, 'Montag 07:00');
  // Vor der Digest-Zeit des Tages entstanden?
  const at = new Date('2026-10-20T08:14:00Z'); // 10:14 Berlin
  assert.equal(beforeLocal('2026-10-20T04:59:00Z', at, 7), true, '06:59 Berlin');
  assert.equal(beforeLocal('2026-10-20T05:00:00Z', at, 7), false, '07:00 Berlin ist nicht mehr davor');
  assert.equal(beforeLocal('2026-10-20T08:13:00Z', at, 7), false, 'nach der Digest-Stunde');
  assert.equal(beforeLocal('2026-10-19T20:00:00Z', at, 7), true, 'Vortag');
  assert.equal(beforeLocal('2026-10-19T22:30:00Z', at, '07:00'), true, '00:30 Berlin am 20.');
});

test('Fälligkeit: Dedupe-Schlüssel mit Fälligkeitsdatum; Aufräumen nach 180 Tagen', async () => {
  const ap = await newTask('Bald fällig Dedupe', { responsibleUserId: U().max, dueDate: '2026-11-03' });
  await runDailyRules(t.db, '2026-11-01');
  await runDailyRules(t.db, '2026-11-02');
  assert.equal((await notes(U().max, `type = 'task.due_soon' and ref_id = $2`, [ap.id])).length, 1, 'einmal je Fälligkeit');
  await t.api(await login('pl')).patch(`/tasks/${ap.id}`, { dueDate: '2026-11-04' });
  await runDailyRules(t.db, '2026-11-02');
  const due = await notes(U().max, `type = 'task.due_soon' and ref_id = $2`, [ap.id]);
  assert.deepEqual(due.map((n: any) => n.dedupe_key), [`due_soon:${ap.id}:2026-11-03`, `due_soon:${ap.id}:2026-11-04`]);
  assert.equal(due[0].event, 'due');
  // Kanäle des Ereignisses nur beim ersten Mal (gleicher Schlüssel am nächsten Tag: kein zweiter Log-Eintrag)
  const pl = await login('pl');
  await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: 'due', channels: { log: true } }] });
  const ap2 = await newTask('Fällig mit Log', { responsibleUserId: U().max, dueDate: '2026-11-05' });
  await runDailyRules(t.db, '2026-11-03');
  await runDailyRules(t.db, '2026-11-04');
  assert.equal((await t.db.query(`select 1 from task_comments where task_id = $1 and source = 'system' and body like 'Fälligkeit:%'`, [ap2.id])).rows.length, 1);
  await t.api(pl).put(`/projects/${web()}/notification-rules`, { rules: [{ event: 'due' }] });

  const old = `now() - interval '200 days'`;
  await t.db.query(`insert into notifications (user_id, type, title, created_at, read_at) values ($1,'x','alt gelesen',${old},now()), ($1,'x','alt ungelesen',${old},null)`, [U().max]);
  await t.db.query(`insert into notifications (user_id, type, title, created_at, read_at, ref_type, ref_id) values ($1,'question','alte offene Frage',${old},now(),'question',gen_random_uuid()), ($1,'question','alte erledigte Frage',${old},now(),'question',gen_random_uuid())`, [U().max]);
  await t.db.query(`update notifications set resolved_at = now() where title = 'alte erledigte Frage'`);
  await t.db.query(`insert into notifications (user_id, type, title, created_at, read_at) values ($1,'x','neu gelesen',now() - interval '100 days',now())`, [U().max]);
  await runCleanup(t.db);
  const left = (await notes(U().max, `title in ('alt gelesen','alt ungelesen','alte offene Frage','alte erledigte Frage','neu gelesen')`)).map((n: any) => n.title).sort();
  assert.deepEqual(left, ['alt ungelesen', 'alte offene Frage', 'neu gelesen']);
});

test('Vorschau „Wer bekommt was?“: Personen je Klasse mit Rolle und Mail-Modus (nur PL)', async () => {
  const pl = await login('pl');
  const max = await login('max');
  assert.equal((await t.api(max).get(`/projects/${web()}/notification-rules/effective`)).statusCode, 403);
  const ap = await newTask('Vorschau AP', { subprojectId: await konzept() });
  const r = await t.api(pl).get(`/projects/${web()}/notification-rules/effective?taskId=${ap.id}`);
  assert.equal(r.statusCode, 200, r.body);
  const ev = (k: string) => r.json().events.find((e: any) => e.event === k);
  assert.deepEqual(ev('blocked').people.map((p: any) => [p.name, p.roleLabel]), [['Max Keller', 'TP-Verantwortung']]);
  assert.deepEqual(ev('decision').people.map((p: any) => [p.name, p.mail]), [['Petra Lenz', 'now']]);
  assert.deepEqual(ev('log').perEvent, ['Beteiligte', 'Erwähnte']);
  const without = (await t.api(pl).get(`/projects/${web()}/notification-rules/effective`)).json();
  assert.deepEqual(without.events.find((e: any) => e.event === 'assigned').perEvent, ['Zuständige(r)'], 'ohne AP: je Ereignis');
});
