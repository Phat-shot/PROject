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
