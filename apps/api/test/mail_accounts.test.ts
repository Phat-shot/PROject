import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { testApp } from './helpers.js';
import { accountRights, ensureDefault, orgAccount, projectAccount } from '../src/mail/accounts.js';
import { DEMO_PASSWORD } from '../src/seed.js';

delete process.env.ANTHROPIC_API_KEY;
const t = await testApp();
test.after(() => t.close());

const web = () => t.ids.projects.web;
const erp = () => t.ids.projects.erp;

test('Bestand: Verwalter aus dem Typ, eine Bindung je Konto, Projektkonto WEB Standard, Ansichten an der Bindung', async () => {
  const admin = await t.login('admin@demo.local');
  const list = (await t.api(admin).get('/mail/accounts')).json().accounts;
  const proj = list.find((a: any) => a.id === t.ids.accounts.project);
  assert.deepEqual(proj.managedBy, { kind: 'project', projectId: web() });
  assert.deepEqual(proj.uses.map((u: any) => [u.use, u.projectId, u.isDefault]), [['project', web(), true]]);
  assert.ok(list.some((a: any) => a.managedBy.kind === 'org' && a.uses.some((u: any) => u.use === 'org')), 'Org-Postfach mit org-Bindung');
  assert.ok(!list.some((a: any) => a.id === t.ids.accounts.personal), 'persönliche Konten sieht der Org-Admin nicht');
  assert.equal((await projectAccount(t.db, web()))!.id, t.ids.accounts.project);
  assert.equal((await t.db.one(`select mail_address from projects where id = $1`, [web()])).mail_address, 'projekt-web@demo.local');
  assert.equal((await t.db.one(`select count(*)::int as c from mail_views where use_id is null`)).c, 0);
  const pl = await t.login('pl@demo.local');
  const mine = (await t.api(pl).get('/mail/accounts')).json().accounts.find((a: any) => a.id === t.ids.accounts.personal);
  assert.deepEqual(mine.managedBy, { kind: 'user', userId: t.ids.users.pl });
  assert.deepEqual(mine.uses.map((u: any) => u.use), ['personal']);
});

test('Migration 049: Backfill wählt je Projekt das älteste Projektkonto als Standard, Verwalter aus dem Typ', async () => {
  // Rohe Konten wie vor der Migration (ohne Verwalter, ohne Bindung) in ERP
  const a1 = await t.db.one(`insert into mail_accounts (org_id, type, project_id, name, address, provider, created_at) values ($1,'project',$2,'ERP alt','erp-alt@demo.local','dev', now() - interval '2 days') returning id`, [t.ids.org, erp()]);
  const a2 = await t.db.one(`insert into mail_accounts (org_id, type, project_id, name, address, provider, created_at) values ($1,'project',$2,'ERP neu','erp-neu@demo.local','dev', now() - interval '1 day') returning id`, [t.ids.org, erp()]);
  const p1 = await t.db.one(`insert into mail_accounts (org_id, type, owner_user_id, name, address, provider) values ($1,'personal',$2,'Anna privat','anna-privat@demo.local','dev') returning id`, [t.ids.org, t.ids.users.anna]);
  const sql = await readFile(new URL('../migrations/049_mail_account_uses.sql', import.meta.url), 'utf8');
  const backfill = sql.slice(sql.indexOf('-- Bestand:'));
  await t.db.exec(backfill);
  assert.equal((await t.db.one(`select managed_project_id from mail_accounts where id = $1`, [a1.id])).managed_project_id, erp());
  assert.equal((await t.db.one(`select managed_user_id from mail_accounts where id = $1`, [p1.id])).managed_user_id, t.ids.users.anna);
  const uses = (await t.db.query(`select account_id, use, is_default from mail_account_uses where account_id = any($1::uuid[]) order by created_at`, [[a1.id, a2.id, p1.id]])).rows;
  assert.deepEqual(uses.map((u: any) => [u.account_id, u.use, u.is_default]), [[a1.id, 'project', true], [a2.id, 'project', false], [p1.id, 'personal', false]]);
  assert.equal((await projectAccount(t.db, erp()))!.id, a1.id, 'wie bisher „ältestes Projektkonto“');
  assert.equal((await t.db.one(`select mail_address from projects where id = $1`, [erp()])).mail_address, 'erp-alt@demo.local');
  // Bestehende Bindungen bleiben unberührt (idempotent)
  assert.equal((await t.db.one(`select count(*)::int as c from mail_account_uses where account_id = $1`, [t.ids.accounts.project])).c, 1);
  await t.db.query(`delete from mail_accounts where id = any($1::uuid[])`, [[a1.id, a2.id, p1.id]]);
  await ensureDefault(t.db, erp());
  assert.equal(await projectAccount(t.db, erp()), null);
  assert.equal((await t.db.one(`select mail_address from projects where id = $1`, [erp()])).mail_address, null, 'Cache folgt dem Standard');
});

test('Konto anlegen ohne Typzwang: Verwalter = Anleger, erste Bindung nach Verwalter; PL setzt nie org; Bindungen nur an eigene Projekte', async () => {
  const pl = await t.login('pl@demo.local');
  const anna = await t.login('anna@demo.local');
  const r = await t.api(pl).post('/mail/accounts', { name: 'Petra zweit', address: 'petra2@demo.local', provider: 'dev' });
  assert.equal(r.statusCode, 200, r.body);
  const acc = r.json().account;
  assert.deepEqual(acc.managedBy, { kind: 'user', userId: t.ids.users.pl });
  assert.deepEqual(acc.uses.map((u: any) => u.use), ['personal']);
  assert.equal((await t.api(pl).post(`/mail/accounts/${acc.id}/uses`, { use: 'org' })).statusCode, 403, 'PL setzt nie org');
  assert.equal((await t.api(pl).post('/mail/accounts', { managedBy: 'org', name: 'x', address: 'x@demo.local', provider: 'dev' })).statusCode, 403);
  assert.equal((await t.api(pl).post(`/mail/accounts/${acc.id}/uses`, { use: 'project', projectId: erp() })).statusCode, 403, 'in ERP nur Mitglied');
  assert.equal((await t.api(anna).post(`/mail/accounts/${acc.id}/uses`, { use: 'project', projectId: erp() })).statusCode, 403, 'fremdes Konto bindet keine andere PL');
  // Eigenes Konto zusätzlich als Projektkonto in WEB: nicht Standard (WEB hat eines), Standard setzbar, Cache folgt
  const b = await t.api(pl).post(`/mail/accounts/${acc.id}/uses`, { use: 'project', projectId: web() });
  assert.equal(b.statusCode, 200, b.body);
  assert.equal(b.json().use.isDefault, false);
  const pa = (await t.api(pl).get(`/projects/${web()}/mail/accounts`)).json();
  assert.deepEqual(pa.accounts.map((a: any) => [a.address, a.isDefault, a.offered]), [['projekt-web@demo.local', true, false], ['petra2@demo.local', false, false]]);
  assert.ok(pa.personalAccounts.some((a: any) => a.id === acc.id));
  assert.equal((await t.api(pl).put(`/projects/${web()}/mail/default-account`, { accountId: acc.id })).statusCode, 200);
  assert.equal((await t.db.one(`select mail_address from projects where id = $1`, [web()])).mail_address, 'petra2@demo.local');
  assert.equal((await t.api(pl).put(`/projects/${web()}/mail/default-account`, { accountId: t.ids.accounts.project })).statusCode, 200);
  // Max (Mitglied) sieht die Projektkonten, setzt aber keinen Standard
  const max = await t.login('max@demo.local');
  assert.equal((await t.api(max).put(`/projects/${web()}/mail/default-account`, { accountId: acc.id })).statusCode, 403);
  // Ansicht aus dem Konto in WEB entsteht über die project-Bindung (Senden für PL), in ERP über die persönliche (Senden nur Petra)
  const vWeb = await t.api(pl).post(`/projects/${web()}/mail/views`, { accountId: acc.id, name: 'Petra2 in WEB', roleRights: { member: { canRead: true, canSend: true } } });
  assert.equal(vWeb.statusCode, 200, vWeb.body);
  assert.equal(vWeb.json().view.use, 'project');
  const vErp = await t.api(pl).post(`/projects/${erp()}/mail/views`, { accountId: acc.id, name: 'Petra2 in ERP', roleRights: { member: { canRead: true, canSend: true } } });
  assert.equal(vErp.statusCode, 200, vErp.body);
  assert.equal(vErp.json().view.use, 'personal');
  const maxRightsErp = (await t.api(max).get(`/projects/${erp()}/mail/views`)).json().views.find((v: any) => v.id === vErp.json().view.id);
  assert.equal(maxRightsErp.myRights.canSend, false, 'über persönliche Bindung sendet nur die Eigentümerin');
  const maxRightsWeb = (await t.api(max).get(`/projects/${web()}/mail/views`)).json().views.find((v: any) => v.id === vWeb.json().view.id);
  assert.equal(maxRightsWeb.myRights.canSend, true, 'über die Projektbindung gilt das Rollenrecht');
  // Bindung lösen: die Ansicht darüber verschwindet, Standard bleibt das Projektkonto
  const useWeb = acc.id && (await t.api(pl).get('/mail/accounts')).json().accounts.find((a: any) => a.id === acc.id).uses.find((u: any) => u.use === 'project');
  assert.equal((await t.api(pl).del(`/mail/accounts/${acc.id}/uses/${useWeb.id}`)).statusCode, 200);
  assert.equal(await t.db.maybeOne(`select 1 from mail_views where id = $1`, [vWeb.json().view.id]), null);
  assert.ok(await t.db.maybeOne(`select 1 from mail_views where id = $1`, [vErp.json().view.id]));
  assert.equal((await projectAccount(t.db, web()))!.id, t.ids.accounts.project);
});

test('Org-Admin bietet ein Konto der Organisation an (auch persönlichem Projekt), ohne Ansicht dort; angebotene Konten werden nie automatisch Standard', async () => {
  const admin = await t.login('admin@demo.local');
  const anna = await t.login('anna@demo.local');
  const r = await t.api(admin).post('/mail/accounts', { managedBy: 'org', name: 'Zentrale', address: 'zentrale@demo.local', provider: 'dev' });
  assert.equal(r.statusCode, 200, r.body);
  const acc = r.json().account;
  assert.deepEqual(acc.uses, [], 'zweites Konto der Organisation: keine org-Bindung, bis es angeboten wird');
  assert.equal((await t.api(admin).post(`/mail/accounts/${acc.id}/uses`, { use: 'org' })).statusCode, 400, 'höchstens ein Org-Postfach');
  const off = await t.api(admin).post(`/mail/accounts/${acc.id}/uses`, { use: 'project', projectId: erp() });
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(await projectAccount(t.db, erp()), null, 'angeboten ≠ Standard');
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'mail_account.offered' and object_id = $1`, [acc.id]));
  const pa = (await t.api(anna).get(`/projects/${erp()}/mail/accounts`)).json();
  assert.deepEqual(pa.accounts.map((a: any) => [a.address, a.isDefault, a.offered]), [['zentrale@demo.local', false, true]]);
  assert.equal((await t.api(anna).put(`/projects/${erp()}/mail/default-account`, { accountId: acc.id })).statusCode, 200, 'die PL macht es ausdrücklich zum Standard');
  assert.equal((await projectAccount(t.db, erp()))!.id, acc.id);
  // Die PL kann das Angebot nicht umkonfigurieren, aber lösen
  assert.equal((await t.api(anna).patch(`/mail/accounts/${acc.id}`, { name: 'Meins' })).statusCode, 403);
  const u = pa.accounts[0].uses.find((x: any) => x.use === 'project');
  assert.equal((await t.api(anna).del(`/mail/accounts/${acc.id}/uses/${u.id}`)).statusCode, 200);
  assert.equal(await projectAccount(t.db, erp()), null);
  // Persönliches Projekt: nur ausdrücklich durch den Org-Admin; er sieht dort keine Inhalte, in seiner Liste nur „persönlich (Name)“
  const max = await t.login('max@demo.local');
  await t.api(admin).put('/org/settings', { personalProjects: true });
  const pid = (await t.api(max).post('/projects', { key: 'MXA', name: 'Max Assistent', personal: true })).json().project.id;
  assert.equal((await t.api(max).post(`/mail/accounts/${acc.id}/uses`, { use: 'project', projectId: pid })).statusCode, 403, 'die PL des persönlichen Projekts holt sich kein Org-Konto');
  assert.equal((await t.api(admin).post(`/mail/accounts/${acc.id}/uses`, { use: 'project', projectId: pid })).statusCode, 200);
  assert.equal((await t.api(admin).get(`/projects/${pid}/mail/accounts`)).statusCode, 403, 'kein Inhaltszugriff');
  const listed = (await t.api(admin).get('/mail/accounts')).json().accounts.find((a: any) => a.id === acc.id);
  assert.deepEqual(listed.uses.map((x: any) => x.projectLabel), ['persönlich (Max Keller)']);
  const mine = (await t.api(max).get(`/projects/${pid}/mail/accounts`)).json();
  assert.deepEqual(mine.accounts.map((a: any) => [a.address, a.isDefault, a.offered]), [['zentrale@demo.local', false, true]]);
  // Ansicht darauf legt Max an (Projektbindung, er ist PL); der Org-Admin kann es nicht
  assert.equal((await t.api(max).post(`/projects/${pid}/mail/views`, { accountId: acc.id, name: 'Zentrale' })).statusCode, 200);
  assert.equal((await t.api(admin).post(`/projects/${pid}/mail/views`, { accountId: acc.id, name: 'Admin' })).statusCode, 403);
  // Max bindet sein eigenes Konto ins persönliche Projekt; ein Org-Postfach ohne Angebot bleibt draußen
  const own = (await t.api(max).post('/mail/accounts', { name: 'Max', address: 'max-priv@demo.local', provider: 'dev' })).json().account;
  assert.equal((await t.api(max).post(`/mail/accounts/${own.id}/uses`, { use: 'project', projectId: pid })).statusCode, 200);
  assert.equal((await projectAccount(t.db, pid))!.id, own.id, 'eigenes Konto wird Standard, das angebotene nicht');
  const orgAcc = (await orgAccount(t.db, t.ids.org))!;
  assert.equal((await t.api(max).post(`/projects/${pid}/mail/views`, { accountId: orgAcc.id, name: 'Org' })).statusCode, 403);
});

test('Senderechte am Konto: Reply-To mit Plus-Code nur über eine Projektbindung; Verwalter sendet in normalen Projekten, nicht in persönlichen', async () => {
  const pl = await t.login('pl@demo.local');
  const admin = await t.login('admin@demo.local');
  const plUser = { id: t.ids.users.pl, orgId: t.ids.org, globalRole: 'project_creator', kind: 'person', name: 'Petra', email: 'pl@demo.local' } as any;
  const personal = await t.db.one(`select * from mail_accounts where id = $1`, [t.ids.accounts.personal]);
  assert.deepEqual(await accountRights(t.db, plUser, personal, web()), { canSend: true, via: 'personal' });
  assert.deepEqual(await accountRights(t.db, plUser, await t.db.one(`select * from mail_accounts where id = $1`, [t.ids.accounts.project]), web()), { canSend: true, via: 'project' });
  assert.deepEqual(await accountRights(t.db, plUser, await t.db.one(`select * from mail_accounts where id = $1`, [t.ids.accounts.project]), erp()), { canSend: true, via: 'manager' }, 'Verwalter (PL von WEB) im normalen Projekt ERP');
  const max = await t.login('max@demo.local');
  const pid = (await t.db.one(`select id from projects where key = 'MXA'`)).id;
  const adminUser = { id: t.ids.users.admin, orgId: t.ids.org, globalRole: 'org_admin', kind: 'person' } as any;
  const zentrale = await t.db.one(`select * from mail_accounts where address = 'zentrale@demo.local'`);
  assert.equal((await accountRights(t.db, adminUser, zentrale, pid)).canSend, false, 'Verwalter ohne Senderecht im persönlichen Projekt');
  // Compose per accountId: Projektkonto in WEB mit Arbeitspaket → Reply-To mit Plus-Code; persönliches Konto ohne Projektbindung → ohne Reply-To
  const before = t.mail.dev.sent.length;
  const d1 = await t.api(pl).post('/mail/drafts', { accountId: t.ids.accounts.project, projectId: web(), taskId: t.ids.tasks.t4, to: ['ext@kunde.de'], subject: 'Mit Plus', body: 'Hallo', send: true });
  assert.equal(d1.statusCode, 200, d1.body);
  assert.match(t.mail.dev.sent.at(-1)!.msg.replyTo ?? '', /^projekt-web\+t[0-9a-f]+@demo\.local$/);
  const d2 = await t.api(pl).post('/mail/drafts', { accountId: t.ids.accounts.personal, projectId: web(), taskId: t.ids.tasks.t4, to: ['ext@kunde.de'], subject: 'Ohne Plus', body: 'Hallo', send: true });
  assert.equal(d2.statusCode, 200, d2.body);
  assert.equal(t.mail.dev.sent.at(-1)!.msg.replyTo ?? null, null);
  assert.equal(t.mail.dev.sent.length, before + 2);
  // Max (Mitglied ohne Bindung und ohne Verwaltung) darf per accountId nicht entwerfen; der Org-Admin nicht im persönlichen Projekt
  assert.equal((await t.api(max).post('/mail/drafts', { accountId: t.ids.accounts.project, projectId: web(), to: ['x@y.de'], subject: 'x', body: 'x' })).statusCode, 403);
  assert.equal((await t.api(admin).post('/mail/drafts', { accountId: zentrale.id, projectId: pid, to: ['x@y.de'], subject: 'x', body: 'x' })).statusCode, 403);
});

test('Verwalterwechsel und Deaktivierung: Konten ohne weitere Bindung werden gelöscht, sonst geht die Verwaltung an Projekt oder Org', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const neu = (await t.api(admin).post('/users', { email: 'tom@demo.local', name: 'Tom Test', password: DEMO_PASSWORD })).json().user;
  assert.equal((await t.api(pl).put(`/projects/${web()}/members/${neu.id}`, { role: 'member' })).statusCode, 200);
  const tom = await t.login('tom@demo.local');
  const only = (await t.api(tom).post('/mail/accounts', { name: 'Tom privat', address: 'tom-priv@demo.local', provider: 'dev' })).json().account;
  const shared = (await t.api(tom).post('/mail/accounts', { name: 'Tom Team', address: 'tom-team@demo.local', provider: 'dev' })).json().account;
  // Tom ist kein PL: binden kann er nicht, die PL bindet sein Konto auch nicht (fremder Verwalter) – der Org-Admin übergibt es ans Projekt
  assert.equal((await t.api(tom).post(`/mail/accounts/${shared.id}/uses`, { use: 'project', projectId: web() })).statusCode, 403);
  assert.equal((await t.api(pl).post(`/mail/accounts/${shared.id}/uses`, { use: 'project', projectId: web() })).statusCode, 403);
  assert.equal((await t.api(tom).put(`/mail/accounts/${shared.id}/manager`, { managedBy: 'project', projectId: web() })).statusCode, 403, 'nur die PL des Zielprojekts oder der Org-Admin');
  assert.equal((await t.api(pl).put(`/mail/accounts/${shared.id}/manager`, { managedBy: 'project', projectId: web() })).statusCode, 403, 'fremdes Konto');
  assert.equal((await t.api(admin).put(`/mail/accounts/${shared.id}/manager`, { managedBy: 'project', projectId: web() })).statusCode, 403, 'der Org-Admin verwaltet persönliche Konten nicht');
  // Tom übergibt sein Konto selbst an die Org; der Org-Admin an das Projekt WEB; die PL bindet es
  assert.equal((await t.api(tom).put(`/mail/accounts/${shared.id}/manager`, { managedBy: 'org' })).statusCode, 200);
  assert.equal((await t.api(admin).put(`/mail/accounts/${shared.id}/manager`, { managedBy: 'project', projectId: web() })).statusCode, 200);
  const bound = await t.api(pl).post(`/mail/accounts/${shared.id}/uses`, { use: 'project', projectId: web() });
  assert.equal(bound.statusCode, 200, bound.body);
  assert.equal((await t.db.one(`select type, project_id from mail_accounts where id = $1`, [shared.id])).type, 'project', 'Spiegel folgt dem Verwalter');
  // Deaktivierung: „Tom privat“ (nur persönlich) verschwindet; Toms persönliche Bindung am Teamkonto entfällt, das Konto bleibt beim Projekt
  assert.equal((await t.api(admin).post(`/users/${neu.id}/deactivate`)).statusCode, 200);
  assert.equal(await t.db.maybeOne(`select 1 from mail_accounts where id = $1`, [only.id]), null);
  assert.ok(await t.db.maybeOne(`select 1 from mail_accounts where id = $1 and managed_project_id = $2`, [shared.id, web()]));
  assert.equal((await t.db.one(`select count(*)::int as c from mail_account_uses where account_id = $1 and use = 'personal'`, [shared.id])).c, 0);
  // Konto mit Bindungen löschen: Standard rückt nach
  const second = (await t.api(pl).post('/mail/accounts', { managedBy: 'project', projectId: web(), name: 'WEB 2', address: 'web2@demo.local', provider: 'dev' })).json().account;
  assert.equal((await t.api(pl).put(`/projects/${web()}/mail/default-account`, { accountId: second.id })).statusCode, 200);
  assert.equal((await t.api(pl).del(`/mail/accounts/${second.id}`)).statusCode, 200);
  assert.equal((await projectAccount(t.db, web()))!.id, t.ids.accounts.project, 'ältestes eigenes Konto rückt nach');
  assert.equal((await t.db.one(`select mail_address from projects where id = $1`, [web()])).mail_address, 'projekt-web@demo.local');
});

test('Postfach-Arten: Org-Postfach ohne Projekte, zentrales Postfach für alle Projekte holt die PL selbst (nicht in persönliche), Projektpostfach gehört einem Projekt', async () => {
  const admin = await t.login('admin@demo.local');
  const anna = await t.login('anna@demo.local');
  const pl = await t.login('pl@demo.local');
  const list = (await t.api(admin).get('/mail/accounts')).json().accounts;
  const org = list.find((a: any) => a.kind === 'org');
  assert.ok(org, 'Org-Postfach hat die Art org');
  assert.equal(list.find((a: any) => a.id === t.ids.accounts.project).kind, 'project');
  // Org-Postfach: keine Projekt- und keine persönliche Bindung, auch nicht durch den Org-Admin
  assert.equal((await t.api(admin).post(`/mail/accounts/${org.id}/uses`, { use: 'project', projectId: erp() })).statusCode, 403);
  assert.equal((await t.api(admin).post(`/mail/accounts/${org.id}/uses`, { use: 'personal' })).statusCode, 403);
  assert.equal((await t.api(admin).patch(`/mail/accounts/${org.id}`, { offeredToAll: true })).statusCode, 400);
  assert.equal((await t.api(admin).post('/mail/accounts', { kind: 'org', name: 'Zweites', address: 'org2@demo.local', provider: 'dev' })).statusCode, 400, 'höchstens ein Org-Postfach');
  // Zentrales Postfach: Art central, keine Bindung, „für alle Projekte“
  const c = await t.api(admin).post('/mail/accounts', { kind: 'central', name: 'Vertrieb', address: 'vertrieb@demo.local', provider: 'dev' });
  assert.equal(c.statusCode, 200, c.body);
  const central = c.json().account;
  assert.equal(central.kind, 'central'); assert.equal(central.offeredToAll, true); assert.deepEqual(central.uses, []);
  // Die PL holt es sich in ERP (Anna ist dort PL); Petra ist in ERP nur Mitglied
  const bindable = (await t.api(anna).get(`/projects/${erp()}/mail/accounts`)).json().bindable;
  assert.ok(bindable.some((a: any) => a.id === central.id), 'zentrales Postfach ist für die PL wählbar');
  assert.equal((await t.api(pl).post(`/mail/accounts/${central.id}/uses`, { use: 'project', projectId: erp() })).statusCode, 403);
  const b = await t.api(anna).post(`/mail/accounts/${central.id}/uses`, { use: 'project', projectId: erp() });
  assert.equal(b.statusCode, 200, b.body); assert.equal(b.json().use.isDefault, false, 'nie automatisch Standard');
  assert.equal((await t.api(anna).put(`/projects/${erp()}/mail/default-account`, { accountId: central.id })).statusCode, 200);
  // Ein gebundenes Konto wird nicht zum Org-Postfach; die Freigabe lässt sich zurücknehmen, dann bietet nur der Org-Admin an
  assert.equal((await t.api(admin).patch(`/mail/accounts/${central.id}`, { offeredToAll: false })).statusCode, 200);
  assert.equal((await t.api(pl).post(`/mail/accounts/${central.id}/uses`, { use: 'project', projectId: web() })).statusCode, 403, 'ohne Freigabe nur per Angebot');
  assert.equal((await t.api(admin).post(`/mail/accounts/${central.id}/uses`, { use: 'project', projectId: web() })).statusCode, 200, 'Angebot durch den Org-Admin');
  await t.api(admin).patch(`/mail/accounts/${central.id}`, { offeredToAll: true });
  // Persönliches Projekt: auch mit Freigabe holt es sich die PL nicht selbst
  const max = await t.login('max@demo.local');
  await t.api(admin).put('/org/settings', { personalProjects: true });
  const pid = (await t.api(max).post('/projects', { key: 'MXB', name: 'Max Büro', personal: true })).json().project.id;
  assert.equal((await t.api(max).post(`/mail/accounts/${central.id}/uses`, { use: 'project', projectId: pid })).statusCode, 403);
  assert.ok(!(await t.api(max).get(`/projects/${pid}/mail/accounts`)).json().bindable.some((a: any) => a.id === central.id));
  // Projektpostfach: Verwalter Projekt WEB; an ERP bindet es niemand; wird ein zentrales Konto an ein Projekt übergeben, lösen sich die anderen Bindungen
  assert.equal((await t.api(anna).post(`/mail/accounts/${t.ids.accounts.project}/uses`, { use: 'project', projectId: erp() })).statusCode, 403);
  assert.equal((await t.api(admin).put(`/mail/accounts/${central.id}/manager`, { managedBy: 'project', projectId: web() })).statusCode, 200);
  const after = (await t.api(admin).get('/mail/accounts')).json().accounts.find((a: any) => a.id === central.id);
  assert.equal(after.kind, 'project'); assert.equal(after.offeredToAll, false);
  assert.deepEqual(after.uses.map((u: any) => u.projectId), [web()], 'nur noch das eigene Projekt');
  assert.equal(await projectAccount(t.db, erp()), null, 'ERP hat keinen Standard mehr');
});
