import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { testApp } from './helpers.js';
import { DEMO_PASSWORD } from '../src/seed.js';
import { canSeeTask, groupRecipients, requireTask } from '../src/rights.js';
import { HttpError } from '../src/errors.js';
import { mapUser } from '../src/auth.js';

// Rechteprüfung an Arbeitspaketen (requireTask: Projektrolle und eingeschränkte Teilprojekte zusammen) und Empfänger aus Gruppen
const t = await testApp();
test.after(() => t.close());
const ids = t.ids.users;
const web = t.ids.projects.web;

// Vertrauliches Arbeitspaket im eingeschränkten Teilprojekt „Vertrag und Budget“ (sichtbar für PL, Anna und den Lenkungskreis)
const secret = await t.db.one(`select t.* from tasks t where t.mail_code = 'c0ffee11'`);
const vertrag = secret.subproject_id as string;
const userRow = async (id: string) => mapUser(await t.db.one(`select * from users where id = $1`, [id]));

test('requireTask: Arbeitspaket mit Rolle und Teilprojekt; canSeeTask als Ja/Nein', async () => {
  const max = await userRow(ids.max);
  const pl = await userRow(ids.pl);
  const leser = await userRow(ids.leser);
  await assert.rejects(requireTask(t.db, max, secret.id), (e: any) => e instanceof HttpError && e.status === 403 && /eingeschränkt/.test(e.message));
  await assert.rejects(requireTask(t.db, max, '00000000-0000-4000-8000-000000000000'), (e: any) => e instanceof HttpError && e.status === 404);
  const ok = await requireTask(t.db, pl, secret.id, 'pl');
  assert.equal(ok.task.id, secret.id);
  assert.equal(ok.membership.role, 'pl');
  const open = (await t.db.one(`select id from tasks where id = $1`, [t.ids.tasks.t2])).id;
  await assert.rejects(requireTask(t.db, leser, open, 'member'), (e: any) => e instanceof HttpError && e.status === 403, 'Mindestrolle');
  assert.equal((await requireTask(t.db, leser, open)).membership.role, 'reader');
  assert.equal(await canSeeTask(t.db, max, secret.id), false);
  assert.equal(await canSeeTask(t.db, pl, secret.id), true);
  assert.equal(await canSeeTask(t.db, max, '00000000-0000-4000-8000-000000000000'), false);
});

test('Eingeschränkte Teilprojekte (Lücke 6): Mitglieder ohne Zugriff erreichen das Arbeitspaket über keine Route', async () => {
  const max = await t.login('max@demo.local');
  // Max ist Mitglied mit „Projektplan ändern“ und sogar zuständig, sieht das Teilprojekt aber nicht
  await t.db.query(`update tasks set responsible_user_id = $2 where id = $1`, [secret.id, ids.max]);
  // … und darf im Zielprojekt planen (Verschieben scheitert dann nur am Teilprojekt)
  await t.db.query(`update project_members set can_edit_plan = true where project_id = $1 and user_id = $2`, [t.ids.projects.erp, ids.max]);
  const column = (await t.db.one(`select id from board_columns where project_id = $1 order by position limit 1`, [web])).id;
  const item = (await t.db.one(`insert into checklist_items (task_id, title, position) values ($1, 'Vertraulich prüfen', 0) returning id`, [secret.id])).id;
  const comment = (await t.db.one(`insert into task_comments (task_id, user_id, body) values ($1, $2, 'Konditionen intern') returning id`, [secret.id, ids.pl])).id;
  const file = path.join(os.tmpdir(), `pt-rights-${Date.now()}.txt`);
  await writeFile(file, 'Vertrag');
  const attachment = (await t.db.one(`insert into attachments (project_id, task_id, filename, mime, size, storage_path, uploaded_by) values ($1,$2,'vertrag.txt','text/plain',7,$3,$4) returning id`, [web, secret.id, file, ids.pl])).id;
  const mail = (await t.db.one(`select m.id from mail_view_matches x join mails m on m.id = x.mail_id where x.view_id = $1 limit 1`, [t.ids.views.project])).id;
  // Mail aus dem persönlichen Konto der PL ohne Ansicht, nur als Kopie am vertraulichen Arbeitspaket
  const copied = (await t.db.one(`insert into mails (account_id, folder, uid, from_addr, subject, text_body) values ($1, 'INBOX', 'rights-copy', 'anwalt@kanzlei.example', 'Vertragsentwurf', 'Vertraulich') returning id`, [t.ids.accounts.personal])).id;
  await t.db.query(`insert into mail_task_links (mail_id, task_id, copied) values ($1,$2,true)`, [copied, secret.id]);
  const upload = () => {
    const boundary = '----pt' + Math.random().toString(36).slice(2);
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="notiz.txt"\r\nContent-Type: text/plain\r\n\r\nHallo\r\n--${boundary}--\r\n`;
    return t.app.inject({ method: 'POST', url: `/api/attachments?taskId=${secret.id}`, cookies: max, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
  };
  const routes: [string, () => Promise<{ statusCode: number; body: string }>][] = [
    ['GET /tasks/:id', () => t.api(max).get(`/tasks/${secret.id}`)],
    ['PATCH /tasks/:id', () => t.api(max).patch(`/tasks/${secret.id}`, { title: 'x' })],
    ['move', () => t.api(max).post(`/tasks/${secret.id}/move`, { columnId: column })],
    ['archive', () => t.api(max).post(`/tasks/${secret.id}/archive`)],
    ['unarchive', () => t.api(max).post(`/tasks/${secret.id}/unarchive`)],
    ['restore', () => t.api(max).post(`/tasks/${secret.id}/restore`)],
    ['shift-successors', () => t.api(max).post(`/tasks/${secret.id}/shift-successors`, {})],
    ['escalate', () => t.api(max).post(`/tasks/${secret.id}/escalate`, { level: 1 })],
    ['checklist anlegen', () => t.api(max).post(`/tasks/${secret.id}/checklist`, { title: 'neu' })],
    ['checklist ändern', () => t.api(max).patch(`/tasks/${secret.id}/checklist/${item}`, { done: true })],
    ['checklist löschen', () => t.api(max).del(`/tasks/${secret.id}/checklist/${item}`)],
    ['Kommentar', () => t.api(max).post(`/tasks/${secret.id}/comments`, { body: 'Hallo' })],
    ['Kommentar-Sichtbarkeit', () => t.api(max).patch(`/tasks/${secret.id}/comments/${comment}`, { visibility: 'external' })],
    ['Zeiten', () => t.api(max).get(`/tasks/${secret.id}/time`)],
    ['Anhang hochladen', upload],
    ['Anhang laden', () => t.api(max).get(`/attachments/${attachment}`)],
    ['Anhang löschen', () => t.api(max).del(`/attachments/${attachment}`)],
    ['kopieren', () => t.api(max).post(`/tasks/${secret.id}/copy`, {})],
    ['in anderes Projekt', () => t.api(max).post(`/tasks/${secret.id}/move-to-project`, { targetProjectId: t.ids.projects.erp })],
    ['Mail verknüpfen', () => t.api(max).post(`/mail/mails/${mail}/link`, { taskId: secret.id })],
    ['Kopie einer Mail lesen', () => t.api(max).get(`/mail/mails/${copied}`)],
    ['AP im Teilprojekt anlegen', () => t.api(max).post(`/projects/${web}/tasks`, { title: 'Nebenabrede', subprojectId: vertrag })]
  ];
  for (const [name, call] of routes) {
    const r = await call();
    assert.equal(r.statusCode, 403, `${name}: ${r.body}`);
  }
  assert.equal((await t.db.one(`select count(*)::int as c from checklist_items where task_id = $1`, [secret.id])).c, 1, 'nichts geändert');
  assert.equal((await t.db.one(`select visibility from task_comments where id = $1`, [comment])).visibility, 'internal');
  assert.equal((await t.db.one(`select archived_at from tasks where id = $1`, [secret.id])).archived_at, null);

  // Mit Zugriff auf das Teilprojekt gehen dieselben Wege (Gegenprobe)
  await t.db.query(`insert into subproject_access (subproject_id, user_id) values ($1,$2)`, [vertrag, ids.max]);
  for (const [name, call] of routes) {
    if (name === 'Anhang löschen' || name === 'in anderes Projekt' || name === 'archive') continue;
    const r = await call();
    assert.notEqual(r.statusCode, 403, `${name} mit Zugriff: ${r.body}`);
  }
  assert.equal((await t.api(max).get(`/mail/mails/${copied}`)).statusCode, 200, 'Kopie lesbar, sobald das Arbeitspaket sichtbar ist');
  assert.equal((await t.api(max).del(`/attachments/${attachment}`)).statusCode, 200);
  await t.db.query(`delete from subproject_access where subproject_id = $1 and user_id = $2`, [vertrag, ids.max]);
  await t.db.query(`update tasks set responsible_user_id = null where id = $1`, [secret.id]);
  await t.db.query(`update project_members set can_edit_plan = false where project_id = $1 and user_id = $2`, [t.ids.projects.erp, ids.max]);
});

test('groupRecipients: aktive Personen der Gruppe mit Projektsicht und Sicht auf das Teilprojekt', async () => {
  const admin = await t.login('admin@demo.local');
  const make = async (email: string, name: string) => (await t.api(admin).post('/users', { email, name, password: DEMO_PASSWORD })).json().user.id as string;
  const inactive = await make('ruhend@demo.local', 'Rita Ruhend');
  const outsider = await make('aussen@demo.local', 'Otto Außen');
  const pl = await t.login('pl@demo.local');
  await t.api(pl).put(`/projects/${web}/members/${inactive}`, { role: 'member' });
  await t.db.query(`update users set active = false where id = $1`, [inactive]);
  const agent = (await t.api(admin).post('/agents', { name: 'Empfangsagent' })).json().agent;
  await t.api(pl).put(`/projects/${web}/members/${agent.id}`, { role: 'member' });
  const gid = (await t.api(admin).post('/groups', { name: 'Empfänger', memberIds: [ids.pl, ids.anna, ids.max, ids.leser, inactive, outsider] })).json().group.id;
  await t.db.query(`insert into group_members (group_id, user_id) values ($1,$2)`, [gid, agent.id]);

  assert.deepEqual(await groupRecipients(t.db, { groupId: gid, projectId: web }), [ids.anna, ids.leser, ids.max, ids.pl], 'ohne Deaktivierte, Agenten und Personen ohne Projektsicht');
  assert.deepEqual(await groupRecipients(t.db, { groupId: gid, projectId: web, subprojectId: vertrag }), [ids.anna, ids.pl], 'eingeschränktes Teilprojekt: nur mit Sicht');
  const erp = t.ids.projects.erp;
  assert.deepEqual(await groupRecipients(t.db, { groupId: gid, projectId: erp }), [ids.anna, ids.max, ids.pl]);
  await t.db.query(`update projects set visibility = 'org' where id = $1`, [erp]);
  assert.deepEqual(await groupRecipients(t.db, { groupId: gid, projectId: erp }), [ids.anna, ids.leser, ids.max, outsider, ids.pl], 'Sichtbarkeit „org“: alle aktiven Personen');
  await t.db.query(`update projects set visibility = 'members' where id = $1`, [erp]);
});
