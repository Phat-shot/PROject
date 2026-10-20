import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { flushAgentRuns, registerAgentRunner } from '../src/ai/agentEvents.js';
import { runForTask } from '../src/ai/agent.js';

const t = await testApp();
test.after(() => t.close());

const mailsOf = async (c: any, viewId: string) => (await t.api(c).get(`/mail/views/${viewId}/mails`)).json().mails as any[];

test('Arbeitspaket aus Mail: Zuständige nur Mitglieder, Agenten nur durch die PL, Teilprojekt aus dem Projekt, Benachrichtigung', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const admin = await t.login('admin@demo.local');
  const web = t.ids.projects.web;
  const mail = (await mailsOf(max, t.ids.views.project)).find((m) => m.fromAddr === 'gf@demo.local');
  const llm = (await t.api(admin).post('/ai/profiles', { name: 'Agenten-LLM', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'x', personalScope: true })).json().profile;
  const agent = (await t.api(admin).post('/agents', { name: 'Postbote', aiProfileId: llm.id })).json().agent;
  assert.equal((await t.api(pl).put(`/projects/${web}/members/${agent.id}`, { role: 'member' })).statusCode, 200);

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
  // Begründung aus den KI-Freigaben (Prüfstufen in fester Reihenfolge): Leser scheitern an der Ebene der PL vor der Projekt-KI
  assert.ok(cat.ai.every((a: any) => a.enabled === false && /Leser stellen nur Fragen ans Projekt/.test(a.reason)));
  assert.ok((await t.api(pl).get(`/mail/mails/${gf.id}/actions`)).json().ai.every((a: any) => a.enabled === false && /KI im Projekt nicht aktiv/.test(a.reason)), 'PL: Projekt-KI fehlt');
  assert.deepEqual(cat.ai.map((a: any) => a.key), ['summarize', 'essence_task', 'essence_page']);
  const plCat = (await t.api(pl).get(`/mail/mails/${gf.id}/actions`)).json();
  assert.equal(plCat.rule.find((a: any) => a.key === 'task_log').enabled, true);

  // Max: KI-Recht an der Ansicht, aber ohne „KI nutzen“ im Projekt
  await t.db.query(`update project_members set can_use_ai = false where project_id = $1 and user_id = $2`, [t.ids.projects.web, t.ids.users.max]);
  assert.equal((await t.api(max).post(`/mail/mails/${gf.id}/ai/summarize`)).statusCode, 403);

  const h = await t.app.inject({ method: 'GET', url: '/api/health' });
  assert.match(String(h.headers['content-security-policy']), /script-src 'self'/);
});

test('Entwurf eines Agenten ohne Ansicht: ändern und ablehnen darf, wer das Konto verwaltet; Ablehnen steht im Log und startet einen Lauf', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const admin = await t.login('admin@demo.local');
  const web = t.ids.projects.web;
  const agent = (await t.api(admin).post('/agents', { name: 'Entwerfer' })).json().agent;
  await t.api(pl).put(`/projects/${web}/members/${agent.id}`, { role: 'member', agentCanMail: false });
  // So legt der Agent ohne Senderecht einen Entwurf am Projektkonto an (ohne Ansicht)
  const draft = async (subject: string) => (await t.db.one(`insert into mail_drafts (account_id, task_id, project_id, user_id, to_addrs, cc_addrs, subject, body, status) values ($1,$2,$3,$4,'["lieferant@example.com"]','[]',$5,'Bitte um Angebot.','pending_approval') returning id`, [t.ids.accounts.project, t.ids.tasks.t2, web, agent.id, subject])).id as string;
  const d1 = await draft('Anfrage Angebot');
  // Mitglied ohne Kontoverwaltung: weder ändern noch ablehnen
  assert.equal((await t.api(max).patch(`/mail/drafts/${d1}`, { body: 'anders' })).statusCode, 403);
  assert.equal((await t.api(max).del(`/mail/drafts/${d1}`)).statusCode, 403);
  // PL (verwaltet das Projektkonto): ändern
  const ed = await t.api(pl).patch(`/mail/drafts/${d1}`, { subject: 'Anfrage Angebot (überarbeitet)' });
  assert.equal(ed.statusCode, 200, ed.body);
  assert.equal(ed.json().draft.subject, 'Anfrage Angebot (überarbeitet)');
  // Ablehnen: Log-Eintrag am Arbeitspaket und Lauf des Agenten mit Anlass „rejected“
  const runs: [string, string][] = [];
  registerAgentRunner(async (taskId, trigger) => { runs.push([taskId, trigger]); });
  try {
    assert.equal((await t.api(pl).del(`/mail/drafts/${d1}`)).statusCode, 200);
    await flushAgentRuns();
    assert.deepEqual(runs, [[t.ids.tasks.t2, 'rejected']]);
    const log = await t.db.one(`select body, source, user_id from task_comments where task_id = $1 order by created_at desc limit 1`, [t.ids.tasks.t2]);
    assert.match(log.body, /Mail-Entwurf von Entwerfer an lieferant@example\.com abgelehnt \(nicht gesendet\): „Anfrage Angebot \(überarbeitet\)“/);
    assert.equal(log.source, 'system');
    assert.equal(log.user_id, t.ids.users.pl);
    assert.equal(await t.db.maybeOne(`select 1 from mail_drafts where id = $1`, [d1]), null);
    // Eigene Entwürfe von Personen: Löschen ist kein Ablehnen (kein Log, kein Lauf)
    const own = (await t.api(pl).post('/mail/drafts', { accountId: t.ids.accounts.project, projectId: web, taskId: t.ids.tasks.t2, to: ['x@example.com'], subject: 'Eigener Entwurf', body: 'Text' })).json().draft;
    assert.equal((await t.api(pl).del(`/mail/drafts/${own.id}`)).statusCode, 200);
    await flushAgentRuns();
    assert.equal(runs.length, 1);
  } finally {
    registerAgentRunner((taskId, trigger) => runForTask(t.db, t.mail, fetch, taskId, trigger));
  }
});
