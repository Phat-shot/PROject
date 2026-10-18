import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';

const t = await testApp();
test.after(() => t.close());

const mailsOf = async (c: any, viewId: string) => (await t.api(c).get(`/mail/views/${viewId}/mails`)).json().mails as any[];

test('Arbeitspaket aus Mail: Zuständige nur Mitglieder, Agenten nur durch die PL, Teilprojekt aus dem Projekt, Benachrichtigung', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const admin = await t.login('admin@demo.local');
  const web = t.ids.projects.web;
  const mail = (await mailsOf(max, t.ids.views.project)).find((m) => m.fromAddr === 'gf@demo.local');
  const agent = (await t.api(admin).post('/agents', { name: 'Postbote' })).json().agent;
  await t.api(pl).put(`/projects/${web}/members/${agent.id}`, { role: 'member' });

  const byMember = await t.api(max).post(`/mail/mails/${mail.id}/create-task`, { projectId: web, responsibleUserId: agent.id });
  assert.equal(byMember.statusCode, 403, 'Mitglied darf keinen Agenten zuweisen');
  const outsider = await t.api(max).post(`/mail/mails/${mail.id}/create-task`, { projectId: web, responsibleUserId: t.ids.users.admin });
  assert.equal(outsider.statusCode, 400, 'kein Mitglied des Projekts');
  const erpSub = await t.db.query(`insert into subprojects (project_id, name) values ($1,'ERP-TP') returning id`, [t.ids.projects.erp]);
  assert.equal((await t.api(max).post(`/mail/mails/${mail.id}/create-task`, { projectId: web, subprojectId: erpSub.rows[0].id })).statusCode, 400);

  const ok = await t.api(max).post(`/mail/mails/${mail.id}/create-task`, { projectId: web, responsibleUserId: t.ids.users.anna });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'task.assigned' and link like $2`, [t.ids.users.anna, `%task=${ok.json().task.id}`]));
  assert.equal((await t.api(pl).post(`/mail/mails/${mail.id}/create-task`, { projectId: web, responsibleUserId: agent.id })).statusCode, 200, 'PL darf');

  // Auch der normale Weg prüft die Mitgliedschaft
  assert.equal((await t.api(pl).post(`/projects/${web}/tasks`, { title: 'X', responsibleUserId: t.ids.users.admin })).statusCode, 400);
});

test('Inhalt ins Projekt: Bestätigung, wenn Mitglieder die Mail bisher nicht lesen dürfen; persönliche Konten nur durch den Eigentümer', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const web = t.ids.projects.web;
  // Hosting-Ansicht aus dem persönlichen Konto der PL: nur sie und Max lesen → Log-Zitat und Arbeitspaket fragen nach
  const own = (await mailsOf(pl, t.ids.views.hosting))[0];
  const first = await t.api(pl).post(`/mail/mails/${own.id}/to-task-log`, { taskId: t.ids.tasks.t4 });
  assert.equal(first.json().needsConfirmation, true);
  assert.ok(first.json().willSee.some((w: any) => w.name === 'Lea Reuter'));
  assert.ok(!first.json().willSee.some((w: any) => w.name === 'Max Keller'), 'Max liest die Ansicht schon');
  const done = await t.api(pl).post(`/mail/mails/${own.id}/to-task-log`, { taskId: t.ids.tasks.t4, confirmed: true });
  assert.equal(done.statusCode, 200, done.body);
  const ct = await t.api(pl).post(`/mail/mails/${own.id}/create-task`, { projectId: web });
  assert.equal(ct.json().needsConfirmation, true);
  assert.equal((await t.api(pl).post(`/mail/mails/${own.id}/create-task`, { projectId: web, confirmed: true })).statusCode, 200);
  // Projektansicht: alle lesen schon → keine Rückfrage
  const gf = (await mailsOf(pl, t.ids.views.project)).find((m) => m.fromAddr === 'gf@demo.local');
  assert.equal((await t.api(pl).post(`/mail/mails/${gf.id}/to-task-log`, { taskId: t.ids.tasks.t4 })).json().comment?.source, 'mail');

  // Persönliches Konto der PL, Max darf die Ansicht lesen: kein Log-Zitat, Arbeitspaket ohne Mailtext
  const host = (await mailsOf(max, t.ids.views.hosting))[0];
  assert.ok(host, 'Hosting-Mail für Max sichtbar');
  assert.equal((await t.api(max).post(`/mail/mails/${host.id}/to-task-log`, { taskId: t.ids.tasks.t2 })).statusCode, 403);
  const hostTask = await t.api(max).post(`/mail/mails/${host.id}/create-task`, { projectId: web, copy: true });
  assert.equal(hostTask.statusCode, 200, hostTask.body);
  assert.match(hostTask.json().task.description, /nur für den Kontoinhaber sichtbar/);
  const full = await t.db.one(`select text_body from mails where id = $1`, [host.id]);
  if (full.text_body) assert.ok(!hostTask.json().task.description.includes(String(full.text_body).slice(0, 40)));
  assert.equal((await t.db.one(`select copied from mail_task_links where task_id = $1`, [hostTask.json().task.id])).copied, false);
});

test('Anpassen mit Beleg nur mit Leserecht; Aktionskatalog spiegelt Rechte; Zusammenfassen braucht „KI nutzen“; CSP-Header', async () => {
  const pl = await t.login('pl@demo.local');
  const leser = await t.login('leser@demo.local');
  const offer = (await mailsOf(pl, t.ids.views.agentur))[0];
  const adj = await t.api(leser).patch(`/tasks/${t.ids.tasks.t2}`, { sourceMailId: offer.id, title: 'x' });
  assert.equal(adj.statusCode, 403);
  const max = await t.login('max@demo.local');
  assert.equal((await t.api(max).patch(`/tasks/${t.ids.tasks.t2}`, { sourceMailId: '00000000-0000-0000-0000-000000000000', priority: 'high' })).statusCode, 403, 'unbekannte Mail');

  const gf = (await mailsOf(leser, t.ids.views.project)).find((m) => m.fromAddr === 'gf@demo.local');
  const cat = (await t.api(leser).get(`/mail/mails/${gf.id}/actions`)).json();
  const rule = (k: string) => cat.rule.find((a: any) => a.key === k);
  assert.equal(rule('task_log').enabled, false);
  assert.equal(rule('task_adjust').enabled, false);
  assert.match(rule('task_adjust').reason, /Leser/);
  assert.ok(cat.ai.every((a: any) => a.enabled === false && /KI im Projekt nicht aktiv/.test(a.reason)));
  assert.deepEqual(cat.ai.map((a: any) => a.key), ['summarize', 'essence_task', 'essence_page']);
  const plCat = (await t.api(pl).get(`/mail/mails/${gf.id}/actions`)).json();
  assert.equal(plCat.rule.find((a: any) => a.key === 'task_log').enabled, true);

  // Max: KI-Recht an der Ansicht, aber ohne „KI nutzen“ im Projekt
  await t.db.query(`update project_members set can_use_ai = false where project_id = $1 and user_id = $2`, [t.ids.projects.web, t.ids.users.max]);
  assert.equal((await t.api(max).post(`/mail/mails/${gf.id}/ai/summarize`)).statusCode, 403);

  const h = await t.app.inject({ method: 'GET', url: '/api/health' });
  assert.match(String(h.headers['content-security-policy']), /script-src 'self'/);
});
