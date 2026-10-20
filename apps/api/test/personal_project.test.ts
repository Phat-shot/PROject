import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { readFile } from 'node:fs/promises';
import { agentBudgetLeft } from '../src/ai/agent.js';

delete process.env.ANTHROPIC_API_KEY;
const t = await testApp();
test.after(() => t.close());

let pid = '';
let profileA = '';
let profileB = '';

test('Persönliches Projekt: anlegen nur mit Freigabe, leer, nur Ersteller und Agenten, keine Einladungen, nur Mitglieder sichtbar', async () => {
  const admin = await t.login('admin@demo.local');
  const max = await t.login('max@demo.local');
  assert.equal((await t.api(max).post('/projects', { key: 'MAX', name: 'Max Assistent', personal: true })).statusCode, 403, 'ohne Freigabe nicht für Benutzer');
  assert.equal((await t.api(admin).put('/org/settings', { personalProjects: true })).statusCode, 200);
  assert.equal((await t.api(max).post('/projects', { key: 'MAXX', name: 'Normal' })).statusCode, 403, 'normale Projekte weiter nur Projektersteller');
  const r = await t.api(max).post('/projects', { key: 'MAX', name: 'Max Assistent', personal: true });
  assert.equal(r.statusCode, 200, r.body);
  pid = r.json().project.id;
  assert.equal(r.json().project.personal, true);
  assert.equal((await t.db.one(`select count(*)::int as c from doc_folders where project_id = $1`, [pid])).c, 0, 'leer');
  assert.equal((await t.api(max).put(`/projects/${pid}/members/${t.ids.users.anna}`, { role: 'member' })).statusCode, 403);
  assert.equal((await t.api(max).post('/invitations', { email: 'neu@extern.de', name: 'Neu', projectId: pid })).statusCode, 403);
  assert.equal((await t.api(max).patch(`/projects/${pid}`, { visibility: 'org' })).statusCode, 400);
  // Org-Agent nur mit einem LLM, das auch in persönlichen Projekten freigegeben ist
  const noLlm = (await t.api(admin).post('/agents', { name: 'Ohne' })).json().agent;
  const blocked = await t.api(max).put(`/projects/${pid}/members/${noLlm.id}`, { role: 'pl' });
  assert.equal(blocked.statusCode, 400); assert.match(blocked.json().error, /kein LLM|nicht freigegeben/);
  const llm = (await t.api(admin).post('/ai/profiles', { name: 'Agenten-LLM', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'x', personalScope: true })).json().profile;
  const agent = (await t.api(admin).post('/agents', { name: 'Hilfe', aiProfileId: llm.id })).json().agent;
  assert.equal((await t.api(max).put(`/projects/${pid}/members/${agent.id}`, { role: 'pl' })).statusCode, 200, 'Agenten ja, auch als stellv. PL');
  assert.equal((await t.api(admin).get(`/projects/${pid}`)).statusCode, 403, 'Org-Admin sieht keine Inhalte');
  // Org-Admin: Agentenliste ohne Projektnamen
  const listed = (await t.api(admin).get('/agents')).json().agents.find((a: any) => a.id === agent.id);
  assert.deepEqual(listed.projects.map((p: any) => p.name), ['persönlich (Max Keller)']);
});

test('Persönliches Projekt: Audit-Export des Org-Admins ohne Details, Projektkonto verwaltet der Org-Admin nicht', async () => {
  const admin = await t.login('admin@demo.local');
  const max = await t.login('max@demo.local');
  const acc = await t.api(max).post('/mail/accounts', { type: 'project', projectId: pid, name: 'Max Postfach', address: 'max-assistent@demo.local', provider: 'dev' });
  assert.equal(acc.statusCode, 200, acc.body);
  const accountId = acc.json().account.id;
  assert.ok(!(await t.api(admin).get('/mail/accounts')).json().accounts.some((a: any) => a.id === accountId));
  assert.equal((await t.api(admin).patch(`/mail/accounts/${accountId}`, { name: 'Übernommen' })).statusCode, 403);
  assert.equal((await t.api(max).patch(`/mail/accounts/${accountId}`, { name: 'Mein Postfach' })).statusCode, 200);
  await t.api(max).post(`/projects/${pid}/tasks`, { title: 'Geheimes Thema' });
  const entries = (await t.api(admin).get('/audit')).json().entries.filter((e: any) => e.projectId === pid);
  assert.ok(entries.length >= 3);
  assert.ok(entries.every((e: any) => JSON.stringify(e.details) === '{"personalProject":true}'), 'keine Details');
  assert.ok(!JSON.stringify(entries).includes('Geheimes Thema'));
  // Projektbezogenes Audit sieht der Eigentümer vollständig
  assert.ok(JSON.stringify((await t.api(max).get(`/audit?projectId=${pid}`)).json().entries).includes('Geheimes Thema'));
});

test('Eigene Agenten der PL: nur mit Freigabe, nur freigegebene Profile, Budget gedeckelt, nur im eigenen Projekt, Org-Admin nur (de)aktivieren', async () => {
  const admin = await t.login('admin@demo.local');
  const max = await t.login('max@demo.local');
  const pl = await t.login('pl@demo.local');
  const anna = await t.login('anna@demo.local');
  profileA = (await t.api(admin).post('/ai/profiles', { name: 'Lokal A', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'qwen' })).json().profile.id;
  profileB = (await t.api(admin).post('/ai/profiles', { name: 'Teuer B', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'big', projectScope: 'none' })).json().profile.id;
  assert.equal((await t.api(max).post(`/projects/${pid}/agents`, { name: 'Morton', aiProfileId: profileA })).statusCode, 403, 'nicht freigegeben');
  await t.api(admin).put('/ai/settings', { agentDailyBudget: 40, plAgents: { enabled: true, maxBudget: 10 } });
  assert.equal((await t.api(max).post(`/projects/${pid}/agents`, { name: 'Morton', aiProfileId: profileB })).statusCode, 400, 'Profil im Projekt nicht freigegeben');
  // „alle Projekte“ gilt im persönlichen Projekt erst mit „auch in persönlichen Projekten“
  assert.equal((await t.api(max).post(`/projects/${pid}/agents`, { name: 'Morton', aiProfileId: profileA })).statusCode, 400, 'ohne personalScope nicht im persönlichen Projekt');
  assert.equal((await t.api(admin).patch(`/ai/profiles/${profileA}`, { personalScope: true })).statusCode, 200);
  assert.equal((await t.api(max).post(`/projects/${pid}/agents`, { name: 'Morton', aiProfileId: profileA, dailyBudget: 11 })).statusCode, 400, 'Budget über dem Deckel');
  const r = await t.api(max).post(`/projects/${pid}/agents`, { name: 'Morton', aiProfileId: profileA, dailyBudget: 5, role: 'pl', persona: 'knapp', signature: 'Morton\nfür Max' });
  assert.equal(r.statusCode, 200, r.body);
  const morton = r.json().agent;
  assert.equal(morton.projectBound.id, pid);
  const mem = await t.db.one(`select role, is_deputy from project_members where project_id = $1 and user_id = $2`, [pid, morton.id]);
  assert.deepEqual([mem.role, mem.is_deputy], ['pl', true]);
  assert.equal(await agentBudgetLeft(t.db, { id: morton.id, org_id: t.ids.org }), 5, 'eigenes Budget');
  // Nicht in anderen Projekten, kein Chat für Fremde
  assert.equal((await t.api(pl).put(`/projects/${t.ids.projects.web}/members/${morton.id}`, { role: 'member' })).statusCode, 403);
  assert.equal((await t.api(anna).post('/chat/dm', { userId: morton.id })).statusCode, 403);
  assert.equal((await t.api(max).post('/chat/dm', { userId: morton.id })).statusCode, 200);
  // Fremde PL bearbeitet ihn nicht; PL ändert im Rahmen
  assert.equal((await t.api(pl).patch(`/projects/${t.ids.projects.web}/agents/${morton.id}`, { name: 'X' })).statusCode, 404);
  assert.equal((await t.api(max).patch(`/projects/${pid}/agents/${morton.id}`, { dailyBudget: 8, persona: 'freundlich' })).json().agent.dailyBudget, 8);
  // Org-Admin: sieht ihn, darf deaktivieren, nicht gestalten
  const listed = (await t.api(admin).get('/agents')).json().agents.find((a: any) => a.id === morton.id);
  assert.match(listed.projectBound.label, /^persönlich \(Max Keller\)$/, 'eine Beschriftung für alle Org-Sichten');
  assert.equal((await t.api(admin).patch(`/agents/${morton.id}`, { persona: 'vom Admin' })).statusCode, 403);
  assert.equal((await t.api(admin).patch(`/agents/${morton.id}`, { active: false })).json().agent.active, false);
  assert.equal((await t.api(admin).get(`/projects/${pid}/agents`)).statusCode, 403, 'keine Projektinhalte');
});

test('Persönliches Projekt sieht nur eigene Postfächer: kein Organisationspostfach, keine Mails aus fremden Konten, keine Plus-Adress-Verknüpfung', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const orgAcc = (await t.db.one(`select id from mail_accounts where type = 'org'`)).id;
  // Organisationspostfach: nur der Org-Admin teilt es, und nie in ein persönliches Projekt
  assert.equal((await t.api(max).post(`/projects/${t.ids.projects.web}/mail/views`, { accountId: orgAcc, name: 'Org' })).statusCode, 403, 'Mitglied ohne Org-Admin');
  const adm = (await t.api(admin).post('/projects', { key: 'ADM', name: 'Admin Assistent', personal: true })).json().project.id;
  const own = await t.api(admin).post(`/projects/${adm}/mail/views`, { accountId: orgAcc, name: 'Org' });
  assert.equal(own.statusCode, 403);
  assert.match(own.body, /eigenen Postfächern/);
  const normal = (await t.api(admin).post('/projects', { key: 'ADN', name: 'Normal' })).json().project.id;
  assert.equal((await t.api(admin).post(`/projects/${normal}/mail/views`, { accountId: orgAcc, name: 'Org' })).statusCode, 200, 'Org-Admin in normalem Projekt');
  assert.equal((await t.api(admin).post('/mail/drafts', { projectId: adm, accountId: orgAcc, to: ['x@extern.de'], subject: 'x', body: 'x' })).statusCode, 403, 'kein Versand aus dem Org-Postfach im persönlichen Projekt');

  // Mails aus anderen Postfächern (hier Projektkonto WEB) nicht ins persönliche Projekt übernehmen; eigene ja
  const mine = (await t.api(pl).post('/projects', { key: 'PET', name: 'Petra Assistent', personal: true })).json().project.id;
  const task = (await t.api(pl).post(`/projects/${mine}/tasks`, { title: 'Privat sortieren' })).json().task;
  const page = (await t.api(pl).post(`/projects/${mine}/docs/pages`, { title: 'Notizen' })).json().page;
  const foreign = (await t.db.one(`select x.mail_id from mail_view_matches x join mails m on m.id = x.mail_id where x.view_id = $1 and not m.outgoing order by m.date desc limit 1`, [t.ids.views.agentur])).mail_id;
  for (const [url, body] of [
    [`/mail/mails/${foreign}/link`, { taskId: task.id, copy: true, confirmed: true }],
    [`/mail/mails/${foreign}/create-task`, { projectId: mine, confirmed: true }],
    [`/mail/mails/${foreign}/to-task-log`, { taskId: task.id, confirmed: true }],
    [`/mail/mails/${foreign}/to-page`, { projectId: mine, confirmed: true }],
    [`/mail/mails/${foreign}/append-to-page`, { pageId: page.id, confirmed: true }]
  ] as [string, any][]) {
    const r = await t.api(pl).post(url, body);
    assert.equal(r.statusCode, 403, `${url}: ${r.body}`);
  }
  const ownMail = (await t.db.one(`select x.mail_id from mail_view_matches x where x.view_id = $1 limit 1`, [t.ids.views.hosting])).mail_id;
  assert.equal((await t.api(pl).post(`/mail/mails/${ownMail}/link`, { taskId: task.id, copy: true, confirmed: true })).statusCode, 200, 'eigenes persönliches Konto');

  // Plus-Adresse: Mail ins Projektkonto WEB mit der Kennung eines AP im persönlichen Projekt wird nicht verknüpft
  const code = (await t.db.one(`select mail_code from tasks where id = $1`, [task.id])).mail_code;
  t.mail.dev.inject(t.ids.accounts.project, { from: { address: 'fremd@extern.de', name: 'Fremd' }, to: [`projekt-web+t${code}@demo.local`], subject: 'Plus-Adresse fremd', text: 'x', folder: 'INBOX' } as any);
  await t.mail.syncAccount(t.ids.accounts.project);
  assert.equal(await t.db.maybeOne(`select 1 from mail_task_links l join mails m on m.id = l.mail_id where l.task_id = $1 and m.subject = 'Plus-Adresse fremd'`, [task.id]), null);
});

test('Migration 045 entfernt Org-Postfach-Ansichten und fremde Mail-Verknüpfungen aus persönlichen Projekten, normale Projekte bleiben', async () => {
  const orgAcc = (await t.db.one(`select id from mail_accounts where type = 'org'`)).id;
  const adm = (await t.db.one(`select id from projects where key = 'ADM'`)).id;
  const normal = (await t.db.one(`select id from projects where key = 'ADN'`)).id;
  const orgUse = (await t.db.one(`select id from mail_account_uses where account_id = $1 and use = 'org'`, [orgAcc])).id;
  const v = await t.db.one(`insert into mail_views (account_id, use_id, project_id, name, filter, created_by) values ($1,$2,$3,'Alt','{}',$4) returning id`, [orgAcc, orgUse, adm, t.ids.users.admin]);
  const task = await t.db.one(`select id from tasks where title = 'Privat sortieren'`);
  const foreign = (await t.db.one(`select x.mail_id from mail_view_matches x where x.view_id = $1 limit 1`, [t.ids.views.agentur])).mail_id;
  await t.db.query(`insert into mail_task_links (mail_id, task_id, copied) values ($1,$2,true)`, [foreign, task.id]);
  await t.db.exec(await readFile(new URL('../migrations/045_personal_no_org_mail.sql', import.meta.url), 'utf8'));
  assert.equal(await t.db.maybeOne(`select 1 from mail_views where id = $1`, [v.id]), null);
  assert.equal(await t.db.maybeOne(`select 1 from mail_task_links where mail_id = $1 and task_id = $2`, [foreign, task.id]), null);
  assert.ok(await t.db.maybeOne(`select 1 from mail_views where project_id = $1 and account_id = $2`, [normal, orgAcc]), 'normales Projekt unverändert');
  assert.ok(await t.db.maybeOne(`select 1 from mail_task_links l join mails m on m.id = l.mail_id join mail_accounts a on a.id = m.account_id where l.task_id = $1 and a.type = 'personal'`, [task.id]), 'eigenes Konto bleibt verknüpft');
});
