import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';

let t: Awaited<ReturnType<typeof testApp>>;
before(async () => { t = await testApp(); });
after(async () => { await t.close(); });

test('Login und /me', async () => {
  const c = await t.login('pl@demo.local');
  const me = await t.api(c).get('/auth/me');
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.email, 'pl@demo.local');
  const bad = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'pl@demo.local', password: 'falsch' } });
  assert.equal(bad.statusCode, 401);
});

test('Org-Admin sieht Projektinhalte nicht ohne Mitgliedschaft', async () => {
  const c = await t.login('admin@demo.local');
  const res = await t.api(c).get(`/projects/${t.ids.projects.web}/tasks`);
  assert.equal(res.statusCode, 403);
});

test('Leser darf Aufgaben lesen, aber nicht anlegen', async () => {
  const c = await t.login('leser@demo.local');
  const list = await t.api(c).get(`/projects/${t.ids.projects.web}/tasks`);
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().tasks.length >= 9);
  const create = await t.api(c).post(`/projects/${t.ids.projects.web}/tasks`, { title: 'Nicht erlaubt' });
  assert.equal(create.statusCode, 403);
});

test('Verantwortung wird vererbt: Aufgabe → Teilprojekt → PL', async () => {
  const c = await t.login('pl@demo.local');
  const { tasks } = (await t.api(c).get(`/projects/${t.ids.projects.web}/tasks`)).json();
  const wire = tasks.find((x: any) => x.title.startsWith('Wireframes'));
  assert.equal(wire.responsible.inherited, true);
  assert.equal(wire.responsible.inheritedFrom, 'subproject');
  assert.equal(wire.responsible.name, 'Max Keller');
  const auftrag = tasks.find((x: any) => x.title.startsWith('Projektauftrag'));
  assert.equal(auftrag.responsible.inheritedFrom, 'project');
  assert.equal(auftrag.responsible.name, 'Petra Lenz');
  const design = tasks.find((x: any) => x.title.startsWith('Designsystem'));
  assert.equal(design.responsible.inherited, false);
  assert.equal(design.responsible.name, 'Anna Berger');
  const extern = tasks.find((x: any) => x.title.startsWith('Angebot Agentur'));
  assert.equal(extern.responsible.email, 'k.mueller@mueller-design.de');
});

test('Konflikte: Deadline nach Teilprojekt-Ende und Vorgänger', async () => {
  const c = await t.login('pl@demo.local');
  const { tasks } = (await t.api(c).get(`/projects/${t.ids.projects.web}/tasks`)).json();
  const migr = tasks.find((x: any) => x.title.startsWith('Inhalte migrieren'));
  assert.ok(migr.conflicts.some((m: string) => m.includes('Teilprojekt-Ende')));
  const hosting = tasks.find((x: any) => x.title.startsWith('Hosting'));
  assert.ok(hosting.conflicts.some((m: string) => m.includes('Vorgänger')));
});

test('Nachfolger verschieben: Vorschau und Anwenden', async () => {
  const c = await t.login('pl@demo.local');
  const { tasks } = (await t.api(c).get(`/projects/${t.ids.projects.web}/tasks`)).json();
  const cms = tasks.find((x: any) => x.title.startsWith('CMS-Auswahl'));
  const preview = await t.api(c).post(`/tasks/${cms.id}/shift-successors`, {});
  assert.equal(preview.statusCode, 200);
  assert.ok(preview.json().changes.length >= 1);
  assert.equal(preview.json().applied, false);
  const apply = await t.api(c).post(`/tasks/${cms.id}/shift-successors`, { apply: true });
  assert.equal(apply.json().applied, true);
  const after = (await t.api(c).get(`/projects/${t.ids.projects.web}/tasks`)).json().tasks.find((x: any) => x.title.startsWith('Hosting'));
  assert.ok(!after.conflicts.some((m: string) => m.includes('Vorgänger')));
});

test('Meine Aufgaben über alle Projekte', async () => {
  const c = await t.login('pl@demo.local');
  const res = await t.api(c).get('/my/tasks');
  const titles = res.json().tasks.map((x: any) => x.title);
  assert.ok(titles.includes('Anforderungsworkshop Einkauf'), 'ERP-Aufgabe fehlt');
  assert.ok(titles.includes('Wireframes Startseite und Produktseiten') === false, 'Fremde geerbte Aufgabe darf nicht erscheinen');
  assert.ok(titles.some((x: string) => x.startsWith('Angebot Agentur')) === false, 'Externe Zuständigkeit nicht meine');
});

test('Stellvertreter: zweiter PL, Hauptverantwortlicher kann nicht entfernt werden', async () => {
  const c = await t.login('pl@demo.local');
  const del = await t.api(c).del(`/projects/${t.ids.projects.web}/members/${t.ids.users.pl}`);
  assert.equal(del.statusCode, 400);
  const detail = (await t.api(c).get(`/projects/${t.ids.projects.web}`)).json();
  const anna = detail.members.find((m: any) => m.userId === t.ids.users.anna);
  assert.equal(anna.role, 'pl');
  assert.equal(anna.isDeputy, true);
});

test('Mail-Sync speichert nur Treffer; private Mails bleiben draußen', async () => {
  const persMails = await t.db.query(`select subject from mails where account_id = $1`, [t.ids.accounts.personal]);
  const subjects = persMails.rows.map((r: any) => r.subject);
  assert.deepEqual(subjects, ['Vertragsverlängerung Hosting 2027']);
  const projMails = await t.db.query(`select count(*)::int as c from mails where account_id = $1`, [t.ids.accounts.project]);
  assert.equal(projMails.rows[0].c, 5);
});

test('Plus-Adresse ordnet Antwort der Aufgabe zu', async () => {
  const c = await t.login('pl@demo.local');
  const res = await t.api(c).get(`/tasks/${t.ids.tasks.t4}`);
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().mails.some((m: any) => m.subject.includes('Lizenzen')));
});

test('Rechte je Ansicht: Max liest Hosting-Ansicht, Leser nicht', async () => {
  const max = await t.login('max@demo.local');
  const ok = await t.api(max).get(`/mail/views/${t.ids.views.hosting}/mails`);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().mails.length, 1);
  assert.equal(ok.json().view.myRights.canSend, false, 'aus persönlichen Konten sendet nur der Eigentümer');
  const leser = await t.login('leser@demo.local');
  const no = await t.api(leser).get(`/mail/views/${t.ids.views.hosting}/mails`);
  assert.equal(no.statusCode, 403);
  const views = await t.api(leser).get(`/projects/${t.ids.projects.web}/mail/views`);
  assert.ok(!views.json().views.some((v: any) => v.id === t.ids.views.hosting));
});

test('Kopie in Aufgabe: Bestätigung nötig, danach für Leser sichtbar', async () => {
  const pl = await t.login('pl@demo.local');
  const { mails } = (await t.api(pl).get(`/mail/views/${t.ids.views.hosting}/mails`)).json();
  const mail = mails[0];
  const leser = await t.login('leser@demo.local');
  assert.equal((await t.api(leser).get(`/mail/mails/${mail.id}`)).statusCode, 403);
  const first = await t.api(pl).post(`/mail/mails/${mail.id}/link`, { taskId: t.ids.tasks.t2, copy: true });
  assert.equal(first.json().needsConfirmation, true);
  assert.ok(first.json().willSee.length >= 4);
  const second = await t.api(pl).post(`/mail/mails/${mail.id}/link`, { taskId: t.ids.tasks.t2, copy: true, confirmed: true });
  assert.equal(second.statusCode, 200);
  assert.equal((await t.api(leser).get(`/mail/mails/${mail.id}`)).statusCode, 200);
  const log = await t.db.query(`select action from audit_log where action = 'mail.copy_to_task'`);
  assert.equal(log.rows.length, 1);
});

test('Entwurf ohne Senderecht geht in die Freigabe, PL sendet', async () => {
  const max = await t.login('max@demo.local');
  const d = await t.api(max).post('/mail/drafts', {
    viewId: t.ids.views.agentur, projectId: t.ids.projects.web, taskId: t.ids.tasks.t4,
    to: ['k.mueller@mueller-design.de'], subject: 'Rückfrage Shootingtage', body: 'Wie viele Motive pro Tag?', send: true
  });
  assert.equal(d.statusCode, 200, d.body);
  assert.equal(d.json().draft.status, 'pending_approval');
  const pl = await t.login('pl@demo.local');
  const pending = await t.api(pl).get(`/projects/${t.ids.projects.web}/mail/drafts`);
  assert.ok(pending.json().drafts.some((x: any) => x.id === d.json().draft.id));
  const sent = await t.api(pl).post(`/mail/drafts/${d.json().draft.id}/send`);
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal(sent.json().draft.status, 'sent');
  const out = t.mail.dev.sent.at(-1)!;
  assert.match(out.msg.replyTo ?? '', /^projekt-web\+t[0-9a-f]+@demo\.local$/);
  const task = await t.api(pl).get(`/tasks/${t.ids.tasks.t4}`);
  assert.ok(task.json().mails.some((m: any) => m.subject === 'Rückfrage Shootingtage'));
});

test('Mail → Aufgabe vorbefüllt', async () => {
  const pl = await t.login('pl@demo.local');
  const { mails } = (await t.api(pl).get(`/mail/views/${t.ids.views.project}/mails`)).json();
  const gf = mails.find((m: any) => m.fromAddr === 'gf@demo.local');
  const res = await t.api(pl).post(`/mail/mails/${gf.id}/create-task`, { projectId: t.ids.projects.web, dueDate: '2026-11-10' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().task.title, gf.subject);
  assert.match(res.json().task.description, /Lenkungskreis/);
});

test('Doku: Version, Final sperrt, Verteiler-Versand', async () => {
  const pl = await t.login('pl@demo.local');
  const docs = (await t.api(pl).get(`/projects/${t.ids.projects.web}/docs`)).json();
  const draft = docs.pages.find((p: any) => p.title.includes('16.10.2026'));
  const upd = await t.api(pl).patch(`/docs/pages/${draft.id}`, { contentMd: draft.contentMd + '\n- Beschluss: Agentur beauftragt', baseVersion: draft.version });
  assert.equal(upd.statusCode, 200, upd.body);
  assert.equal(upd.json().page.version, draft.version + 1);
  const stale = await t.api(pl).patch(`/docs/pages/${draft.id}`, { contentMd: 'x', baseVersion: draft.version });
  assert.equal(stale.statusCode, 409);
  const fin = await t.api(pl).post(`/docs/pages/${draft.id}/status`, { status: 'final' });
  assert.equal(fin.json().page.status, 'final');
  const locked = await t.api(pl).patch(`/docs/pages/${draft.id}`, { contentMd: 'y' });
  assert.equal(locked.statusCode, 409);
  const dist = await t.api(pl).post(`/docs/pages/${draft.id}/distribute`, {});
  assert.equal(dist.statusCode, 200, dist.body);
  assert.deepEqual(dist.json().to, ['gf@demo.local', 'k.mueller@mueller-design.de']);
  const versions = (await t.api(pl).get(`/docs/pages/${draft.id}`)).json().versions;
  assert.ok(versions.length >= 2);
  const max = await t.login('max@demo.local');
  const noFinal = await t.api(max).post(`/docs/pages/${draft.id}/status`, { status: 'draft' });
  assert.equal(noFinal.statusCode, 403);
});

test('Seite aus Vorlage', async () => {
  const max = await t.login('max@demo.local');
  const res = await t.api(max).post(`/projects/${t.ids.projects.web}/docs/pages`, { title: 'Protokoll Test', templateKey: 'protokoll' });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.json().page.contentMd, /## Beschlüsse/);
  assert.doesNotMatch(res.json().page.contentMd, /\{\{datum\}\}/);
});

test('Audit-Export nur für Org-Admin, Export wird protokolliert', async () => {
  const pl = await t.login('pl@demo.local');
  assert.equal((await t.api(pl).get('/audit')).statusCode, 403);
  const admin = await t.login('admin@demo.local');
  const res = await t.api(admin).get('/audit');
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().entries.length > 10);
  const log = await t.db.query(`select 1 from audit_log where action = 'audit.export'`);
  assert.equal(log.rows.length, 1);
});

test('Suche respektiert Rechte', async () => {
  const leser = await t.login('leser@demo.local');
  const res = await t.api(leser).get('/search?q=Hosting');
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().tasks.length >= 1);
  assert.ok(!res.json().mails.some((m: any) => m.subject.includes('Vertragsverlängerung')));
});

test('Mail-Aktionen: Aufgaben-Log, in Doku ablegen, an Seite anhängen, Aufgabe anpassen mit Beleg', async () => {
  const pl = await t.login('pl@demo.local');
  const { mails } = (await t.api(pl).get(`/mail/views/${t.ids.views.project}/mails`)).json();
  const offer = mails.find((m: any) => m.subject.startsWith('Angebot Website-Relaunch'));
  const actions = await t.api(pl).get(`/mail/mails/${offer.id}/actions`);
  assert.equal(actions.statusCode, 200);
  assert.ok(actions.json().rule.some((a: any) => a.key === 'to_page' && a.enabled));
  assert.ok(actions.json().ai.every((a: any) => a.enabled === false));

  const log = await t.api(pl).post(`/mail/mails/${offer.id}/to-task-log`, { taskId: t.ids.tasks.t4, note: 'Angebot liegt vor.' });
  assert.equal(log.statusCode, 200, log.body);
  assert.equal(log.json().comment.source, 'mail');
  assert.match(log.json().comment.body, /86\.400/);

  const docs = (await t.api(pl).get(`/projects/${t.ids.projects.web}/docs`)).json();
  const folder = docs.folders.find((f: any) => f.name === 'Allgemein');
  const first = await t.api(pl).post(`/mail/mails/${offer.id}/to-page`, { projectId: t.ids.projects.web, folderId: folder.id });
  assert.equal(first.json().needsConfirmation, true);
  const page = await t.api(pl).post(`/mail/mails/${offer.id}/to-page`, { projectId: t.ids.projects.web, folderId: folder.id, confirmed: true });
  assert.equal(page.statusCode, 200, page.body);
  assert.match(page.json().page.contentMd, /\*\*Von:\*\* Katrin Müller/);
  const leser = await t.login('leser@demo.local');
  assert.equal((await t.api(leser).get(`/docs/pages/${page.json().page.id}`)).statusCode, 200);

  const draft = docs.pages.find((p: any) => p.title === 'Statusbericht KW 41');
  const app1 = await t.api(pl).post(`/mail/mails/${offer.id}/append-to-page`, { pageId: draft.id, confirmed: true });
  assert.equal(app1.statusCode, 200, app1.body);
  assert.equal(app1.json().page.version, draft.version + 1);
  assert.match(app1.json().page.contentMd, /## Angebot Website-Relaunch/);
  const finalPage = docs.pages.find((p: any) => p.title.startsWith('Projektauftrag'));
  assert.equal((await t.api(pl).post(`/mail/mails/${offer.id}/append-to-page`, { pageId: finalPage.id, confirmed: true })).statusCode, 400);

  const adj = await t.api(pl).patch(`/tasks/${t.ids.tasks.t4}`, { dueDate: '2026-10-25', sourceMailId: offer.id, note: 'Frist wegen Rückfragen verlängert.' });
  assert.equal(adj.statusCode, 200, adj.body);
  const detail = (await t.api(pl).get(`/tasks/${t.ids.tasks.t4}`)).json();
  assert.ok(detail.comments.some((c: any) => c.source === 'mail' && /Angepasst auf Grundlage/.test(c.body)));
  assert.ok(detail.mails.some((m: any) => m.id === offer.id));

  const max = await t.login('max@demo.local');
  const { mails: hosting } = (await t.api(pl).get(`/mail/views/${t.ids.views.hosting}/mails`)).json();
  const denied = await t.api(max).post(`/mail/mails/${hosting[0].id}/to-page`, { projectId: t.ids.projects.web, confirmed: true });
  assert.equal(denied.statusCode, 403, 'aus persönlichen Konten legt nur der Eigentümer ab');
});

test('Leerer POST-Body liefert 400 statt 500; Konto bearbeiten und testen; Projektadresse aus Projektkonto', async () => {
  const pl = await t.login('pl@demo.local');
  const empty = await t.app.inject({ method: 'POST', url: `/api/mail/accounts/${t.ids.accounts.project}/sync`, cookies: pl, headers: { 'content-type': 'application/json' } });
  assert.equal(empty.statusCode, 400);
  const ok = await t.app.inject({ method: 'POST', url: `/api/mail/accounts/${t.ids.accounts.project}/sync`, cookies: pl });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().hint, null);
  const upd = await t.api(pl).patch(`/mail/accounts/${t.ids.accounts.project}`, { name: 'Projektpostfach WEB (neu)', imapPassword: '' });
  assert.equal(upd.statusCode, 200, upd.body);
  assert.equal(upd.json().account.name, 'Projektpostfach WEB (neu)');
  const test = await t.api(pl).post('/mail/accounts/test', { accountId: t.ids.accounts.project });
  assert.equal(test.statusCode, 200);
  assert.equal(test.json().imap.ok, true);
  const max = await t.login('max@demo.local');
  assert.equal((await t.api(max).patch(`/mail/accounts/${t.ids.accounts.project}`, { name: 'x' })).statusCode, 403);
  // Projekt ohne Mailadresse, Projektkonto anbinden → Adresse gesetzt, trennen → Adresse weg
  const p = await t.api(pl).post('/projects', { key: 'NEU', name: 'Neues Projekt' });
  assert.equal(p.json().project.mailAddress, null);
  const acc = await t.api(pl).post('/mail/accounts', { type: 'project', projectId: p.json().project.id, name: 'Postfach NEU', address: 'neu@demo.local', provider: 'dev' });
  assert.equal(acc.statusCode, 200, acc.body);
  assert.equal((await t.api(pl).get(`/projects/${p.json().project.id}`)).json().project.mailAddress, 'neu@demo.local');
  await t.api(pl).del(`/mail/accounts/${acc.json().account.id}`);
  assert.equal((await t.api(pl).get(`/projects/${p.json().project.id}`)).json().project.mailAddress, null);
});

test('Gesamtsicht: Aufgaben über alle Projekte, gemeinsames Postfach, Projekt-Sichtbarkeit org', async () => {
  const pl = await t.login('pl@demo.local');
  const mine = (await t.api(pl).get('/my/tasks')).json().tasks;
  const all = (await t.api(pl).get('/my/tasks?scope=all')).json().tasks;
  assert.ok(all.length >= mine.length && all.length > 0);
  assert.ok(all.every((x: any) => typeof x.projectKey === 'string' && x.projectKey.length > 0));
  assert.ok(mine.every((x: any) => !x.done));
  const inbox = (await t.api(pl).get('/mail/inbox')).json();
  assert.ok(inbox.views.length >= 1 && inbox.mails.length > 0);
  assert.ok(inbox.mails.every((m: any) => m.projectKey && m.viewId && m.viewName));
  const ids = new Set(inbox.mails.map((m: any) => m.id));
  assert.equal(ids.size, inbox.mails.length, 'keine Doppelungen über mehrere Ansichten');
  // Leser ohne Mail-Rechte sieht leeres Postfach, aber keinen Fehler
  const leser = await t.login('leser@demo.local');
  const li = await t.api(leser).get('/mail/inbox');
  assert.equal(li.statusCode, 200);
  // Sichtbarkeit: Admin ist kein Mitglied von WEB → 403; nach visibility=org lesend → 200, schreiben weiter 403
  const admin = await t.login('admin@demo.local');
  assert.equal((await t.api(admin).get(`/projects/${t.ids.projects.web}`)).statusCode, 403);
  assert.equal((await t.api(admin).patch(`/projects/${t.ids.projects.web}`, { visibility: 'org' })).statusCode, 403, 'nur PL ändert Sichtbarkeit');
  assert.equal((await t.api(pl).patch(`/projects/${t.ids.projects.web}`, { visibility: 'offen' })).statusCode, 400);
  assert.equal((await t.api(pl).patch(`/projects/${t.ids.projects.web}`, { visibility: 'org' })).statusCode, 200);
  const vis = await t.api(admin).get(`/projects/${t.ids.projects.web}`);
  assert.equal(vis.statusCode, 200, vis.body);
  assert.equal(vis.json().project.myRole, 'reader');
  assert.ok((await t.api(admin).get('/projects')).json().projects.some((p: any) => p.id === t.ids.projects.web && p.myRole === 'reader'));
  assert.equal((await t.api(admin).get(`/projects/${t.ids.projects.web}/tasks`)).statusCode, 200);
  assert.equal((await t.api(admin).post(`/projects/${t.ids.projects.web}/tasks`, { title: 'nicht erlaubt' })).statusCode, 403);
  assert.ok((await t.api(admin).get('/my/tasks?scope=all')).json().tasks.some((x: any) => x.projectKey === 'WEB'));
  assert.equal((await t.api(pl).patch(`/projects/${t.ids.projects.web}`, { visibility: 'members' })).statusCode, 200);
  assert.equal((await t.api(admin).get(`/projects/${t.ids.projects.web}`)).statusCode, 403);
});

test('Reporting: Policy, Fälligkeit, Bericht aus Vorlage mit Kennzahlen, Versand als PDF oder Entwurf zur Prüfung', async () => {
  const { isReportDue, runReports } = await import('../src/docs/report.js');
  const base = { enabled: true, templateKey: 'statusbericht', interval: 'weekly' as const, weekday: 5, dayOfMonth: 1, recipients: [], mode: 'direct' as const, parentPageId: null, lastRunOn: null, lastPageId: null };
  assert.equal(isReportDue(base, '2026-10-16'), true, 'Freitag');
  assert.equal(isReportDue(base, '2026-10-15'), false, 'Donnerstag');
  assert.equal(isReportDue({ ...base, lastRunOn: '2026-10-16' }, '2026-10-16'), false, 'nur einmal am Tag');
  assert.equal(isReportDue({ ...base, interval: 'biweekly', lastRunOn: '2026-10-09' }, '2026-10-16'), false);
  assert.equal(isReportDue({ ...base, interval: 'biweekly', lastRunOn: '2026-10-02' }, '2026-10-16'), true);
  assert.equal(isReportDue({ ...base, interval: 'monthly', dayOfMonth: 28 }, '2026-02-28'), true);
  assert.equal(isReportDue({ ...base, enabled: false }, '2026-10-16'), false);

  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  assert.equal((await t.api(max).patch(`/projects/${t.ids.projects.web}`, { reporting: { enabled: true } })).statusCode, 403);
  assert.equal((await t.api(pl).patch(`/projects/${t.ids.projects.web}`, { reporting: { recipients: ['kaputt'] } })).statusCode, 400);
  assert.equal((await t.api(pl).patch(`/projects/${t.ids.projects.web}`, { reporting: { templateKey: 'gibtsnicht' } })).statusCode, 400);
  const set = await t.api(pl).patch(`/projects/${t.ids.projects.web}`, { reporting: { enabled: true, interval: 'weekly', weekday: 5, recipients: ['GF@kunde.de', 'lenkung@kunde.de'], mode: 'direct' } });
  assert.equal(set.statusCode, 200, set.body);
  const pol = (await t.api(pl).get(`/projects/${t.ids.projects.web}`)).json().project.reporting;
  assert.deepEqual(pol.recipients, ['gf@kunde.de', 'lenkung@kunde.de']);

  // Direktmodus: Seite final, PDF an Empfängerkreis, Anhang an der Seite
  const before = t.mail.dev.sent.length;
  const run = await t.api(pl).post(`/projects/${t.ids.projects.web}/reporting/run`);
  assert.equal(run.statusCode, 200, run.body);
  const r1 = run.json().result;
  assert.equal(r1.sent, true, JSON.stringify(r1));
  assert.match(r1.title, /^Statusbericht WEB KW \d{2}\/\d{4}$/);
  const out = t.mail.dev.sent.at(-1)!;
  assert.equal(t.mail.dev.sent.length, before + 1);
  assert.deepEqual(out.msg.to, ['gf@kunde.de', 'lenkung@kunde.de']);
  assert.equal(out.msg.attachments?.length, 1);
  assert.ok(out.msg.attachments![0].content.subarray(0, 4).toString() === '%PDF');
  const page = (await t.api(pl).get(`/docs/pages/${r1.pageId}`)).json();
  assert.equal(page.page.status, 'final');
  assert.ok(page.page.contentHtml.includes('Kennzahlen'));
  assert.ok(page.page.contentHtml.includes('Nächste Meilensteine'));
  assert.equal(page.attachments.length, 1);
  assert.deepEqual(page.page.settings.recipients, ['gf@kunde.de', 'lenkung@kunde.de']);
  const after = (await t.api(pl).get(`/projects/${t.ids.projects.web}`)).json().project.reporting;
  assert.equal(after.lastPageId, r1.pageId);
  assert.ok(after.lastRunOn);
  // Worker-Lauf am selben Tag erzeugt nichts Doppeltes
  assert.equal((await runReports(t.db, t.mail, after.lastRunOn)).length, 0);

  // Prüfmodus: Entwurf + Benachrichtigung an PL, Versand danach über die Seite (Empfänger aus Seiteneinstellung)
  await t.api(pl).patch(`/projects/${t.ids.projects.web}`, { reporting: { mode: 'proposal' } });
  const r2 = (await t.api(pl).post(`/projects/${t.ids.projects.web}/reporting/run`)).json().result;
  assert.equal(r2.sent, false);
  assert.equal(r2.status, 'draft');
  const notes = (await t.api(pl).get('/notifications')).json().notifications;
  assert.ok(notes.some((n: any) => n.type === 'report.review' && n.link.endsWith(r2.pageId)));
  assert.equal((await t.api(pl).post(`/docs/pages/${r2.pageId}/distribute`, {})).statusCode, 400, 'Entwurf wird nicht versendet');
  assert.equal((await t.api(pl).post(`/docs/pages/${r2.pageId}/status`, { status: 'final' })).statusCode, 200);
  const dist = await t.api(pl).post(`/docs/pages/${r2.pageId}/distribute`, {});
  assert.equal(dist.statusCode, 200, dist.body);
  assert.deepEqual(dist.json().to, ['gf@kunde.de', 'lenkung@kunde.de']);
});

test('Einladungen über Org-Postfach, Annahme mit Passwort, manuelles Anlegen bleibt', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  assert.equal((await t.api(pl).post('/invitations', { email: 'neu@firma.de', name: 'Neu' })).statusCode, 403);
  assert.equal((await t.api(admin).post('/invitations', { email: 'pl@demo.local', name: 'Doppelt' })).statusCode, 400, 'bestehender Benutzer');
  const before = t.mail.dev.sent.length;
  const inv = await t.api(admin).post('/invitations', { email: 'Neu@Firma.de', name: 'Nina Neu', globalRole: 'project_creator' });
  assert.equal(inv.statusCode, 200, inv.body);
  assert.equal(inv.json().sent, true);
  assert.equal(t.mail.dev.sent.length, before + 1);
  const mail = t.mail.dev.sent.at(-1)!.msg;
  assert.deepEqual(mail.to, ['neu@firma.de']);
  assert.ok(mail.text.includes(inv.json().invitation.link));
  const token = inv.json().invitation.link.split('/einladung/')[1];
  const info = await t.app.inject({ method: 'GET', url: `/api/invitations/accept/${token}` });
  assert.equal(info.statusCode, 200);
  assert.equal(info.json().email, 'neu@firma.de');
  assert.equal((await t.app.inject({ method: 'POST', url: `/api/invitations/accept/${token}`, payload: { password: 'kurz' } })).statusCode, 400);
  const acc = await t.app.inject({ method: 'POST', url: `/api/invitations/accept/${token}`, payload: { password: 'sicheres-passwort-1' } });
  assert.equal(acc.statusCode, 200, acc.body);
  assert.equal(acc.json().user.globalRole, 'project_creator');
  assert.ok(acc.headers['set-cookie']);
  assert.equal((await t.app.inject({ method: 'GET', url: `/api/invitations/accept/${token}` })).statusCode, 404, 'Token verbraucht');
  assert.ok((await t.api(admin).get('/invitations')).json().invitations.every((i: any) => i.email !== 'neu@firma.de'));
  const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'neu@firma.de', password: 'sicheres-passwort-1' } });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().orgName, 'Demo GmbH');
  // Fallback: manuelles Anlegen
  assert.equal((await t.api(admin).post('/users', { email: 'manuell@firma.de', name: 'Manuell', password: 'passwort-manuell' })).statusCode, 200);
});

test('Gruppen und eingeschränkte Teilprojekte: nur PL, Verantwortliche und benannte Benutzer/Gruppen sehen die Aufgaben', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const anna = await t.login('anna@demo.local');
  const web = t.ids.projects.web;
  const maxId = (await t.api(max).get('/auth/me')).json().user.id;
  // Seed: Teilprojekt „Vertrag und Budget“ ist eingeschränkt (Gruppe Lenkungskreis = pl, anna)
  const plSubs = (await t.api(pl).get(`/projects/${web}`)).json().subprojects;
  const vertrag = plSubs.find((s: any) => s.name === 'Vertrag und Budget');
  assert.ok(vertrag && vertrag.restricted);
  assert.ok(!(await t.api(max).get(`/projects/${web}`)).json().subprojects.some((s: any) => s.id === vertrag.id), 'Max sieht das Teilprojekt nicht');
  assert.ok((await t.api(anna).get(`/projects/${web}`)).json().subprojects.some((s: any) => s.id === vertrag.id), 'Anna über Gruppe');
  const secret = (await t.api(pl).get(`/projects/${web}/tasks`)).json().tasks.find((x: any) => x.subprojectId === vertrag.id);
  assert.ok(secret);
  assert.ok(!(await t.api(max).get(`/projects/${web}/tasks`)).json().tasks.some((x: any) => x.id === secret.id));
  assert.equal((await t.api(max).get(`/tasks/${secret.id}`)).statusCode, 403);
  assert.equal((await t.api(max).patch(`/tasks/${secret.id}`, { title: 'x' })).statusCode, 403);
  assert.ok(!(await t.api(max).get('/search?q=Agenturvertrag')).json().tasks.some((x: any) => x.id === secret.id));
  assert.ok(!(await t.api(max).get('/my/tasks?scope=all')).json().tasks.some((x: any) => x.id === secret.id));
  // Gruppe anlegen und Max aufnehmen → sichtbar
  assert.equal((await t.api(pl).post('/groups', { name: 'Einkauf' })).statusCode, 403);
  const g = await t.api(admin).post('/groups', { name: 'Einkauf', memberIds: [maxId] });
  assert.equal(g.statusCode, 200, g.body);
  assert.equal((await t.api(max).patch(`/projects/${web}/subprojects/${vertrag.id}`, { accessGroupIds: [g.json().group.id] })).statusCode, 403, 'Max darf Zugriff nicht selbst setzen');
  const upd = await t.api(pl).patch(`/projects/${web}/subprojects/${vertrag.id}`, { accessGroupIds: [...vertrag.accessGroupIds, g.json().group.id] });
  assert.equal(upd.statusCode, 200, upd.body);
  assert.ok((await t.api(max).get(`/projects/${web}/tasks`)).json().tasks.some((x: any) => x.id === secret.id), 'Max sieht nach Gruppenfreigabe');
  assert.equal((await t.api(max).get(`/tasks/${secret.id}`)).statusCode, 200);
  // Gruppe in Mail-Ansicht-Rechten
  const leser = await t.login('leser@demo.local');
  const leserId = (await t.api(leser).get('/auth/me')).json().user.id;
  await t.api(admin).patch(`/groups/${g.json().group.id}`, { memberIds: [maxId, leserId] });
  const rightsBefore = (await t.api(pl).get(`/mail/views/${t.ids.views.project}/rights`)).json().rights;
  const put = await t.api(pl).put(`/mail/views/${t.ids.views.project}/rights`, { rights: [...rightsBefore.filter((r: any) => r.role !== 'reader'), { groupId: g.json().group.id, canRead: true, canCreateTask: true }] });
  assert.equal(put.statusCode, 200, put.body);
  assert.ok(put.json().rights.some((r: any) => r.groupId === g.json().group.id && r.groupName === 'Einkauf'));
  const lv = await t.api(leser).get(`/mail/views/${t.ids.views.project}/mails`);
  assert.equal(lv.statusCode, 200, 'Leser liest über Gruppe');
  assert.equal(lv.json().view.myRights.canCreateTask, true);
  // Entfernen der Freigabe → wieder unsichtbar
  await t.api(pl).patch(`/projects/${web}/subprojects/${vertrag.id}`, { accessGroupIds: vertrag.accessGroupIds });
  assert.equal((await t.api(max).get(`/tasks/${secret.id}`)).statusCode, 403);
  // Nicht eingeschränkt → alle Mitglieder
  await t.api(pl).patch(`/projects/${web}/subprojects/${vertrag.id}`, { restricted: false });
  assert.equal((await t.api(max).get(`/tasks/${secret.id}`)).statusCode, 200);
});

test('Übergeordnete Zuständigkeit wechseln: direkt zugewiesene Aufgaben nur auf Wunsch mit übertragen', async () => {
  const pl = await t.login('pl@demo.local');
  const web = t.ids.projects.web;
  const users = (await t.api(pl).get('/users')).json().users;
  const anna = users.find((u: any) => u.email === 'anna@demo.local');
  const max = users.find((u: any) => u.email === 'max@demo.local');
  const sp = (await t.api(pl).post(`/projects/${web}/subprojects`, { name: 'Wechsel-TP', responsibleUserId: anna.id })).json().subproject;
  const direct = (await t.api(pl).post(`/projects/${web}/tasks`, { title: 'Direkt Anna', subprojectId: sp.id, responsibleUserId: anna.id })).json().task;
  const inherited = (await t.api(pl).post(`/projects/${web}/tasks`, { title: 'Geerbt', subprojectId: sp.id })).json().task;
  assert.equal(inherited.responsible.userId, anna.id);
  assert.equal(inherited.responsible.inherited, true);
  // ohne transferTasks: geerbte folgen, direkte bleiben
  const r1 = await t.api(pl).patch(`/projects/${web}/subprojects/${sp.id}`, { responsibleUserId: max.id });
  assert.equal(r1.json().transferred, 0);
  assert.equal((await t.api(pl).get(`/tasks/${inherited.id}`)).json().task.responsible.userId, max.id);
  assert.equal((await t.api(pl).get(`/tasks/${direct.id}`)).json().task.responsible.userId, anna.id);
  // zurück mit transferTasks: direkte wechseln mit
  await t.api(pl).patch(`/projects/${web}/subprojects/${sp.id}`, { responsibleUserId: anna.id });
  const r2 = await t.api(pl).patch(`/projects/${web}/subprojects/${sp.id}`, { responsibleUserId: max.id, transferTasks: true });
  assert.equal(r2.json().transferred, 1);
  assert.equal((await t.api(pl).get(`/tasks/${direct.id}`)).json().task.responsible.userId, max.id);
});

test('Meine Arbeit: Projekte mit Teilprojekten, Arbeitspaketen und Tasks, eingeschränkte Teilprojekte gefiltert', async () => {
  const pl0 = await t.login('pl@demo.local');
  const vb = (await t.api(pl0).get(`/projects/${t.ids.projects.web}`)).json().subprojects.find((s: any) => s.name === 'Vertrag und Budget');
  await t.api(pl0).patch(`/projects/${t.ids.projects.web}/subprojects/${vb.id}`, { restricted: true });
  const max = await t.login('max@demo.local');
  const r = await t.api(max).get('/my/work');
  assert.equal(r.statusCode, 200, r.body);
  const web = r.json().projects.find((p: any) => p.key === 'WEB');
  assert.ok(web && web.lead.userId && Array.isArray(web.subprojects) && Array.isArray(web.tasks) && Array.isArray(web.checklist));
  assert.ok(!web.subprojects.some((s: any) => s.name === 'Vertrag und Budget'), 'eingeschränktes Teilprojekt fehlt für Max');
  assert.ok(!web.tasks.some((x: any) => x.title === 'Agenturvertrag verhandeln'));
  assert.ok(web.checklist.every((c: any) => web.tasks.some((x: any) => x.id === c.taskId)));
  const pl = await t.login('pl@demo.local');
  const plWeb = (await t.api(pl).get('/my/work')).json().projects.find((p: any) => p.key === 'WEB');
  assert.ok(plWeb.subprojects.some((s: any) => s.name === 'Vertrag und Budget'));
});

test('Spaltenarten: Geplant und Zurückgestellt, Eskalation nur in aktiven Spalten, neue Projekte mit sechs Spalten', async () => {
  const pl = await t.login('pl@demo.local');
  const d = (await t.api(pl).get(`/projects/${t.ids.projects.web}`)).json();
  const kinds = d.columns.map((c: any) => c.kind);
  assert.ok(kinds.includes('backlog') && kinds.includes('parked') && kinds.includes('done'), JSON.stringify(kinds));
  assert.equal(d.columns[0].kind, 'backlog');
  assert.equal(d.columns.at(-1).kind, 'done');
  const p = (await t.api(pl).post('/projects', { key: 'SPA', name: 'Spalten' })).json().project;
  const cols = (await t.api(pl).get(`/projects/${p.id}`)).json().columns;
  assert.deepEqual(cols.map((c: any) => c.name), ['Geplant', 'Offen', 'In Arbeit', 'In Prüfung', 'Zurückgestellt', 'Erledigt']);
  // ohne Erledigt-Spalte abgelehnt
  assert.equal((await t.api(pl).put(`/projects/${p.id}/columns`, { columns: [{ name: 'A', kind: 'active' }, { name: 'B', kind: 'parked' }] })).statusCode, 400);
  // Zurückgestellt zählt nicht als Stillstand
  const { evaluateProject } = await import('../src/tasks/escalation.js');
  const parked = cols.find((c: any) => c.kind === 'parked');
  const task = (await t.api(pl).post(`/projects/${p.id}/tasks`, { title: 'Ruht', columnId: parked.id })).json().task;
  await t.db.query(`update tasks set last_activity_at = now() - interval '30 days' where id = $1`, [task.id]);
  const rows = await evaluateProject(t.db, p.id, new Date().toISOString().slice(0, 10));
  assert.ok(!rows.some((r) => r.taskId === task.id && r.staleDays > 0), 'zurückgestellt ist kein Stillstand');
});

test('Mail: Ordner, Archivieren, Papierkorb, Verschieben in Unterordner mit Rechten und Audit', async () => {
  const pl = await t.login('pl@demo.local');
  const leser = await t.login('leser@demo.local');
  const acc = t.ids.accounts.project;
  const folders = (await t.api(pl).get(`/mail/accounts/${acc}/folders`)).json().folders;
  assert.ok(folders.some((f: any) => f.specialUse === 'inbox') && folders.some((f: any) => f.specialUse === 'trash'));
  const inbox = (await t.api(pl).get(`/mail/inbox?projectId=${t.ids.projects.web}&folder=INBOX`)).json().mails;
  assert.ok(inbox.length >= 2);
  const m1 = inbox[0]; const m2 = inbox[1];
  assert.equal((await t.api(leser).post(`/mail/mails/${m1.id}/archive`)).statusCode, 403, 'Leser ohne Entwurfs-/Senderecht');
  const a = await t.api(pl).post(`/mail/mails/${m1.id}/archive`);
  assert.equal(a.statusCode, 200, a.body);
  assert.equal((await t.api(pl).get(`/mail/mails/${m1.id}`)).json().mail.folder, 'Archive');
  assert.ok((await t.api(pl).get(`/mail/inbox?projectId=${t.ids.projects.web}&folder=Archive`)).json().mails.some((m: any) => m.id === m1.id));
  assert.ok(!(await t.api(pl).get(`/mail/inbox?projectId=${t.ids.projects.web}&folder=INBOX`)).json().mails.some((m: any) => m.id === m1.id));
  const tr = await t.api(pl).post(`/mail/mails/${m2.id}/trash`);
  assert.equal(tr.json().folder, 'Trash');
  const nf = await t.api(pl).post(`/mail/accounts/${acc}/folders`, { name: 'Lieferanten' });
  assert.equal(nf.statusCode, 200, nf.body);
  assert.equal((await t.api(pl).post(`/mail/mails/${m2.id}/move`, { folder: nf.json().folder.path })).json().folder, 'Lieferanten');
  assert.ok((await t.api(pl).get(`/mail/accounts/${acc}/folders`)).json().folders.some((f: any) => f.path === 'Lieferanten'));
  const audit = (await t.api(pl).get(`/audit?projectId=${t.ids.projects.web}`)).json().entries;
  assert.ok(audit.some((e: any) => e.action === 'mail.archive') && audit.some((e: any) => e.action === 'mail.trash') && audit.some((e: any) => e.action === 'mail.move'));
  // Ansicht-Filter im Posteingang
  const only = (await t.api(pl).get(`/mail/inbox?projectId=${t.ids.projects.web}&viewId=${t.ids.views.hosting}`)).json();
  assert.ok(only.mails.every((m: any) => m.viewId === t.ids.views.hosting));
  // Detail liefert Ansichten und Änderungsrecht
  const det = (await t.api(pl).get(`/mail/mails/${m2.id}`)).json();
  assert.ok(Array.isArray(det.viewIds) && det.canModify === true);
});

test('Benutzereinstellungen: Theme, Sprache, Name, Passwort; Org-Admin verwaltet Projekt- und Org-Konten', async () => {
  const max = await t.login('max@demo.local');
  assert.equal((await t.api(max).patch('/me', { settings: { theme: 'neon' } })).statusCode, 400);
  const r = await t.api(max).patch('/me', { name: 'Max K.', settings: { theme: 'dark', language: 'de' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().user.settings.theme, 'dark');
  assert.equal((await t.api(max).get('/auth/me')).json().user.name, 'Max K.');
  assert.equal((await t.api(max).patch('/me', { password: 'neues-passwort-99', currentPassword: 'falsch' })).statusCode, 400);
  assert.equal((await t.api(max).patch('/me', { password: 'neues-passwort-99', currentPassword: 'demo1234' })).statusCode, 200);
  assert.equal((await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'max@demo.local', password: 'neues-passwort-99' } })).statusCode, 200);
  await t.api(max).patch('/me', { password: 'demo1234', currentPassword: 'neues-passwort-99' });
  const admin = await t.login('admin@demo.local');
  const accounts = (await t.api(admin).get('/mail/accounts')).json().accounts;
  assert.ok(accounts.some((a: any) => a.type === 'project') && accounts.some((a: any) => a.type === 'org'));
  assert.equal((await t.api(admin).patch(`/mail/accounts/${t.ids.accounts.project}`, { name: 'Projektpostfach (Admin)' })).statusCode, 200);
  assert.equal((await t.api(admin).patch(`/mail/accounts/${t.ids.accounts.personal}`, { name: 'x' })).statusCode, 403, 'persönliche Konten bleiben beim Eigentümer');
});

test('Tasks mit externer Zuständigkeit', async () => {
  const pl = await t.login('pl@demo.local');
  const task = (await t.api(pl).post(`/projects/${t.ids.projects.web}/tasks`, { title: 'AP mit externem Task' })).json().task;
  const r = await t.api(pl).post(`/tasks/${task.id}/checklist`, { title: 'Angebot liefern', responsibleEmail: 'Lieferant@Extern.de' });
  assert.equal(r.statusCode, 200, r.body);
  const item = r.json().task.checklist[0];
  assert.equal(item.responsibleEmail, 'lieferant@extern.de');
  const upd = await t.api(pl).patch(`/tasks/${task.id}/checklist/${item.id}`, { responsibleEmail: null });
  assert.equal(upd.json().task.checklist[0].responsibleEmail, null);
});
