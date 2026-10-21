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

/** Agenten gehören zu einem LLM: einmal anlegen, dann wiederverwenden. */
let llmId = '';
const llmFor = async (admin: Record<string, string>) => llmId || (llmId = (await t.api(admin).post('/ai/profiles', { name: 'Test-LLM', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'm' })).json().profile.id);

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
  // … und darf im Zielprojekt planen (Verschieben scheitert dann nur am Teilprojekt) und in WEB freigeben
  await t.db.query(`update project_members set can_edit_plan = true where project_id = $1 and user_id = $2`, [t.ids.projects.erp, ids.max]);
  await t.db.query(`update project_members set can_approve = true where project_id = $1 and user_id = $2`, [web, ids.max]);
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
  const proposal = async () => (await t.db.one(`insert into ai_proposals (org_id, project_id, kind, task_id, payload) values ($1,$2,'task_update',$3,'{"logEntry":"Vertraulich"}') returning id`, [t.ids.org, web, secret.id])).id;
  const toApprove = await proposal();
  const toReject = await proposal();
  const meeting = (await t.db.one(`insert into meetings (project_id, title, starts_at, ends_at, created_by) values ($1, 'Jour fixe', now(), now() + interval '1 hour', $2) returning id`, [web, ids.pl])).id;
  const raid = (await t.db.one(`insert into raid_items (project_id, number, kind, title, created_by) values ($1, 900, 'risk', 'Lieferverzug', $2) returning id`, [web, ids.pl])).id;
  const subCount = async () => (await t.db.one(`select count(*)::int as c from subprojects where name like 'Vertrag und Budget%'`)).c;
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
    ['AP im Teilprojekt anlegen', () => t.api(max).post(`/projects/${web}/tasks`, { title: 'Nebenabrede', subprojectId: vertrag })],
    ['Agentenläufe am AP', () => t.api(max).get(`/projects/${web}/agent-runs?taskId=${secret.id}`)],
    ['Vorschlag freigeben', () => t.api(max).post(`/ai/proposals/${toApprove}/approve`, {})],
    ['Vorschlag ablehnen', () => t.api(max).post(`/ai/proposals/${toReject}/reject`, {})],
    ['Essenz zum AP', () => t.api(max).post(`/mail/mails/${mail}/ai/essence`, { taskId: secret.id })],
    ['Zeit am AP buchen', () => t.api(max).post(`/projects/${web}/time`, { taskId: secret.id, minutes: 5 })],
    ['Aktionspunkt einer Besprechung', () => t.api(max).post(`/meetings/${meeting}/tasks`, { taskId: secret.id })],
    ['Mail-Entwurf zum AP', () => t.api(max).post('/mail/drafts', { viewId: t.ids.views.project, projectId: web, taskId: secret.id, to: ['k.mueller@mueller-design.de'], subject: 'Vertrag', body: 'Entwurf' })],
    ['RAID-Eintrag zum AP', () => t.api(max).post(`/projects/${web}/raid`, { title: 'Haftungsrisiko', taskId: secret.id })],
    ['RAID-Eintrag ans AP hängen', () => t.api(max).patch(`/projects/${web}/raid/${raid}`, { taskId: secret.id })],
    ['TP kopieren', () => t.api(max).post(`/projects/${web}/subprojects/${vertrag}/copy`, { parts: ['tasks', 'checklist'] })],
    ['TP in anderes Projekt', () => t.api(max).post(`/projects/${web}/subprojects/${vertrag}/move-to-project`, { targetProjectId: t.ids.projects.erp, parts: ['tasks'] })]
  ];
  for (const [name, call] of routes) {
    const r = await call();
    assert.equal(r.statusCode, 403, `${name}: ${r.body}`);
    // Am Teilprojekt gescheitert (nicht an Rolle, Recht oder KI); die Mail meldet nur „keine Berechtigung“
    assert.match(r.body, name === 'Kopie einer Mail lesen' ? /keine Berechtigung/ : /eingeschränkt/, `${name}: ${r.body}`);
  }
  assert.equal((await t.db.one(`select count(*)::int as c from checklist_items where task_id = $1`, [secret.id])).c, 1, 'nichts geändert');
  assert.equal(await subCount(), 1, 'keine Kopie des Teilprojekts');
  assert.equal((await t.db.one(`select project_id from subprojects where id = $1`, [vertrag])).project_id, web, 'Teilprojekt nicht verschoben');
  assert.equal((await t.db.one(`select count(*)::int as c from ai_proposals where task_id = $1 and status = 'pending'`, [secret.id])).c, 2, 'Vorschläge unentschieden');
  for (const [table, where] of [['time_entries', 'task_id = $1'], ['meeting_tasks', 'task_id = $1'], ['mail_drafts', 'task_id = $1'], ['raid_items', 'task_id = $1']]) {
    assert.equal((await t.db.one(`select count(*)::int as c from ${table} where ${where}`, [secret.id])).c, 0, `${table}: nichts angelegt`);
  }
  assert.equal((await t.db.one(`select visibility from task_comments where id = $1`, [comment])).visibility, 'internal');
  assert.equal((await t.db.one(`select archived_at from tasks where id = $1`, [secret.id])).archived_at, null);

  // Mit Zugriff auf das Teilprojekt gehen dieselben Wege (Gegenprobe)
  await t.db.query(`insert into subproject_access (subproject_id, user_id) values ($1,$2)`, [vertrag, ids.max]);
  for (const [name, call] of routes) {
    // Essenz braucht ein LLM; die übrigen würden das AP bzw. TP wegbewegen
    if (['Anhang löschen', 'in anderes Projekt', 'archive', 'Essenz zum AP', 'TP in anderes Projekt'].includes(name)) continue;
    const r = await call();
    assert.notEqual(r.statusCode, 403, `${name} mit Zugriff: ${r.body}`);
  }
  assert.equal(await subCount(), 2, 'mit Zugriff kopiert');
  await t.db.query(`delete from subprojects where name = 'Vertrag und Budget (Kopie)'`);
  assert.equal((await t.api(max).get(`/mail/mails/${copied}`)).statusCode, 200, 'Kopie lesbar, sobald das Arbeitspaket sichtbar ist');
  assert.equal((await t.api(max).del(`/attachments/${attachment}`)).statusCode, 200);
  await t.db.query(`delete from subproject_access where subproject_id = $1 and user_id = $2`, [vertrag, ids.max]);
  await t.db.query(`update tasks set responsible_user_id = null where id = $1`, [secret.id]);
  await t.db.query(`update project_members set can_edit_plan = false where project_id = $1 and user_id = $2`, [t.ids.projects.erp, ids.max]);
  await t.db.query(`update project_members set can_approve = false where project_id = $1 and user_id = $2`, [web, ids.max]);
});

test('Eingeschränkte Teilprojekte in Listen: Läufe, Vorschläge, Besprechungen, Zeiten, Meilensteine, Übersicht, Eskalationen nur mit Sicht', async () => {
  const admin = await t.login('admin@demo.local');
  const max = await t.login('max@demo.local');
  const pl = await t.login('pl@demo.local');
  const t2 = t.ids.tasks.t2;
  const agent = (await t.api(admin).post('/agents', { name: 'Listenagent', aiProfileId: await llmFor(admin) })).json().agent.id;
  for (const [task, reasoning] of [[secret.id, 'Konditionen 12% Rabatt'], [t2, 'Wireframes geprüft'], [null, 'Projektlauf']]) {
    await t.db.query(`insert into agent_runs (org_id, agent_user_id, project_id, task_id, trigger, reasoning) values ($1,$2,$3,$4,'manual',$5)`, [t.ids.org, agent, web, task, reasoning]);
  }
  for (const task of [secret.id, t2]) await t.db.query(`insert into ai_proposals (org_id, project_id, kind, task_id, payload) values ($1,$2,'task_update',$3,'{"logEntry":"Listenprobe"}')`, [t.ids.org, web, task]);
  const meeting = (await t.db.one(`insert into meetings (project_id, title, starts_at, ends_at, created_by) values ($1, 'Lenkungsrunde', now(), now() + interval '1 hour', $2) returning id`, [web, ids.pl])).id;
  await t.db.query(`insert into meeting_tasks (meeting_id, task_id) values ($1,$2), ($1,$3)`, [meeting, secret.id, t2]);
  // Max hat früher am vertraulichen AP gebucht (eigene Buchung bleibt sichtbar, der Titel nicht)
  await t.db.query(`insert into time_entries (project_id, task_id, user_id, date, minutes, note) values ($1,$2,$3,current_date,30,'Vorgespräch'), ($1,$2,$4,current_date,60,'Verhandlung')`, [web, secret.id, ids.max, ids.pl]);
  await t.db.query(`insert into milestones (project_id, subproject_id, name, date) values ($1,$2,'Vertragsunterzeichnung',current_date)`, [web, vertrag]);
  await t.db.query(`update tasks set escalation_level = 1 where id = $1`, [secret.id]);

  const as = async (who: Record<string, string>) => {
    const runs = (await t.api(who).get(`/projects/${web}/agent-runs`)).json().runs;
    const proposals = (await t.api(who).get(`/projects/${web}/ai/proposals`)).json().proposals;
    const meetings = (await t.api(who).get(`/projects/${web}/meetings`)).json().meetings;
    const time = (await t.api(who).get(`/projects/${web}/time`)).json();
    const detail = (await t.api(who).get(`/projects/${web}`)).json();
    const overview = (await t.api(who).get(`/projects/${web}/overview`)).json();
    const escalations = (await t.api(who).get(`/projects/${web}/escalations`)).json().escalations;
    return {
      runs: runs.filter((r: any) => r.agentId === agent).map((r: any) => r.reasoning).sort(),
      proposals: proposals.filter((p: any) => p.taskId === secret.id).length,
      proposalsT2: proposals.filter((p: any) => p.taskId === t2).length,
      meeting: meetings.find((m: any) => m.id === meeting).tasks.map((x: any) => x.id).sort(),
      ownSecretEntry: time.entries.find((e: any) => e.taskId === secret.id && e.userId === ids.max),
      bySub: time.bySubproject.map((b: any) => b.name),
      milestones: detail.milestones.map((m: any) => m.name),
      overviewSubs: overview.perSubproject.map((x: any) => x.id),
      overviewMilestones: overview.milestones.map((m: any) => m.name),
      overviewEsc: overview.escalations.map((e: any) => e.taskId),
      escalations: escalations.map((e: any) => e.taskId)
    };
  };
  const m = await as(max);
  assert.deepEqual(m.runs, ['Projektlauf', 'Wireframes geprüft'], 'Läufe ohne das vertrauliche AP');
  assert.equal(m.proposals, 0, 'Vorschläge ohne das vertrauliche AP');
  assert.equal(m.proposalsT2, 1);
  assert.deepEqual(m.meeting, [t2], 'Aktionspunkte ohne das vertrauliche AP');
  assert.equal(m.ownSecretEntry.minutes, 30, 'eigene Buchung bleibt');
  assert.equal(m.ownSecretEntry.taskTitle, null, 'ohne Titel des vertraulichen AP');
  assert.ok(!m.bySub.includes('Vertrag und Budget'), 'Auswertung ohne das eingeschränkte TP');
  assert.ok(!m.milestones.includes('Vertragsunterzeichnung'), 'Meilensteine ohne das eingeschränkte TP');
  assert.ok(!m.overviewSubs.includes(vertrag));
  assert.ok(!m.overviewMilestones.includes('Vertragsunterzeichnung'));
  assert.ok(!m.overviewEsc.includes(secret.id), 'Übersicht ohne Eskalation des vertraulichen AP');
  assert.ok(!m.escalations.includes(secret.id), 'Eskalationen ohne das vertrauliche AP');
  assert.ok(m.overviewSubs.length >= 3, 'die übrigen Teilprojekte bleiben');

  // Gegenprobe: die PL sieht alles
  const p = await as(pl);
  assert.deepEqual(p.runs, ['Konditionen 12% Rabatt', 'Projektlauf', 'Wireframes geprüft']);
  assert.equal(p.proposals, 1);
  assert.deepEqual(p.meeting, [secret.id, t2].sort());
  assert.equal(p.ownSecretEntry.taskTitle, (await t.db.one(`select title from tasks where id = $1`, [secret.id])).title);
  assert.ok(p.bySub.includes('Vertrag und Budget'));
  assert.ok(p.milestones.includes('Vertragsunterzeichnung'));
  assert.ok(p.overviewSubs.includes(vertrag));
  assert.ok(p.overviewMilestones.includes('Vertragsunterzeichnung'));
  assert.ok(p.overviewEsc.includes(secret.id));
  assert.ok(p.escalations.includes(secret.id));
  await t.db.query(`update tasks set escalation_level = 0 where id = $1`, [secret.id]);
  await t.db.query(`delete from milestones where name = 'Vertragsunterzeichnung'`);
});

test('Mail-Kopie im AP: nur ausdrückliche Mitglieder mit Sicht auf das Teilprojekt, nie implizite Leser (Sichtbarkeit „org“)', async () => {
  const admin = await t.login('admin@demo.local');
  assert.equal((await t.api(admin).post('/users', { email: 'nina-org@demo.local', name: 'Nina Nichtmitglied', password: DEMO_PASSWORD })).statusCode, 200);
  const ninaS = await t.login('nina-org@demo.local');
  const max = await t.login('max@demo.local');
  const leser = await t.login('leser@demo.local');
  const copied = (await t.db.one(`insert into mails (account_id, folder, uid, from_addr, subject, text_body) values ($1, 'INBOX', 'rights-copy-org', 'kunde@kunde.example', 'Angebot', 'Guten Tag Frau Lenz, anbei unser Angebot') returning id`, [t.ids.accounts.personal])).id;
  await t.db.query(`insert into mail_task_links (mail_id, task_id, copied) values ($1,$2,true)`, [copied, t.ids.tasks.t2]);
  await t.db.query(`update projects set visibility = 'org' where id = $1`, [web]);
  assert.equal((await t.api(ninaS).get(`/projects/${web}`)).statusCode, 200, 'Nina liest das Projekt als implizite Leserin');
  const r = await t.api(ninaS).get(`/mail/mails/${copied}`);
  assert.equal(r.statusCode, 403, r.body);
  assert.ok(!r.body.includes('anbei unser Angebot'));
  assert.equal((await t.api(max).get(`/mail/mails/${copied}`)).statusCode, 200, 'Mitglied');
  assert.equal((await t.api(leser).get(`/mail/mails/${copied}`)).statusCode, 200, 'ausdrücklicher Leser');
  await t.db.query(`update projects set visibility = 'members' where id = $1`, [web]);
  assert.equal((await t.api(ninaS).get(`/mail/mails/${copied}`)).statusCode, 403);
});

test('Zeiten am AP: PL sieht alle Buchungen, Mitglieder nur die eigenen, Leser keine', async () => {
  const t2 = t.ids.tasks.t2;
  await t.db.query(`insert into time_entries (project_id, task_id, user_id, date, minutes, note) values ($1,$2,$3,current_date,90,'Gespräch Gehalt')`, [web, t2, ids.pl]);
  const get = async (email: string) => (await t.api(await t.login(email)).get(`/tasks/${t2}/time`)).json();
  const pl = await get('pl@demo.local');
  assert.ok(pl.entries.some((e: any) => e.userId === ids.pl) && pl.entries.some((e: any) => e.userId === ids.max), 'PL: alle');
  assert.equal(pl.totalMinutes, pl.entries.reduce((a: number, e: any) => a + e.minutes, 0));
  const max = await get('max@demo.local');
  assert.ok(max.entries.length > 0);
  assert.ok(max.entries.every((e: any) => e.userId === ids.max), 'Mitglied: nur eigene');
  assert.ok(!JSON.stringify(max).includes('Gespräch Gehalt'));
  assert.equal(max.totalMinutes, max.entries.reduce((a: number, e: any) => a + e.minutes, 0), 'Summe nur über die eigenen');
  assert.ok(max.totalMinutes < pl.totalMinutes);
  const leser = await get('leser@demo.local');
  assert.deepEqual([leser.entries, leser.totalMinutes], [[], 0], 'Leser: keine');
});

test('groupRecipients: aktive Personen der Gruppe mit Projektsicht und Sicht auf das Teilprojekt', async () => {
  const admin = await t.login('admin@demo.local');
  const make = async (email: string, name: string) => (await t.api(admin).post('/users', { email, name, password: DEMO_PASSWORD })).json().user.id as string;
  const inactive = await make('ruhend@demo.local', 'Rita Ruhend');
  const outsider = await make('aussen@demo.local', 'Otto Außen');
  const pl = await t.login('pl@demo.local');
  await t.api(pl).put(`/projects/${web}/members/${inactive}`, { role: 'member' });
  await t.db.query(`update users set active = false where id = $1`, [inactive]);
  const agent = (await t.api(admin).post('/agents', { name: 'Empfangsagent', aiProfileId: await llmFor(admin) })).json().agent;
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
