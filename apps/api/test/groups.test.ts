import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { DEMO_PASSWORD } from '../src/seed.js';
import { syncProjectGroups } from '../src/rights.js';

// Rechte, Rollen, Gruppen (Konzept Abschnitt 2): Gruppen als Projektmitglied (Regel M), Gruppenverwalter, Benutzerverwaltung, PL neu bestimmen
const t = await testApp();
test.after(() => t.close());

/** Agenten gehören zu einem LLM: einmal anlegen, dann wiederverwenden. */
let llmId = '';
const llmFor = async (admin: Record<string, string>) => llmId || (llmId = (await t.api(admin).post('/ai/profiles', { name: 'Test-LLM', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'm' })).json().profile.id);

const ids = t.ids.users;

const row = (projectId: string, userId: string) => t.db.maybeOne(`select * from project_members where project_id = $1 and user_id = $2`, [projectId, userId]);
let seq = 0;
async function newProject(): Promise<string> {
  const pl = await t.login('pl@demo.local');
  const r = await t.api(pl).post('/projects', { key: `GR${++seq}`, name: `Gruppenprojekt ${seq}` });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().project.id;
}
async function newGroup(name: string, memberIds: string[], managerIds: string[] = []): Promise<string> {
  const admin = await t.login('admin@demo.local');
  const r = await t.api(admin).post('/groups', { name, memberIds, managerIds });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().group.id;
}
async function newUser(email: string, name: string, globalRole = 'user'): Promise<string> {
  const admin = await t.login('admin@demo.local');
  const r = await t.api(admin).post('/users', { email, name, password: DEMO_PASSWORD, globalRole });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().user.id;
}

test('Gruppe als Projektmitglied: Personen werden Mitglied mit Herkunft Gruppe und den Rechten der Gruppe', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const pid = await newProject();
  const gid = await newGroup('Elektro-Team', [ids.max, ids.leser]);
  assert.equal(await row(pid, ids.max), null);
  assert.equal((await t.api(max).get(`/projects/${pid}`)).statusCode, 403);

  assert.equal((await t.api(max).put(`/projects/${pid}/groups/${gid}`, { role: 'member' })).statusCode, 403, 'nur PL');
  assert.equal((await t.api(pl).put(`/projects/${pid}/groups/${gid}`, { role: 'pl' })).statusCode, 400, 'PL und Stellvertretung sind einzelne Personen');
  assert.equal((await t.api(pl).put(`/projects/${pid}/groups/00000000-0000-4000-8000-000000000000`, { role: 'member' })).statusCode, 404);
  const r = await t.api(pl).put(`/projects/${pid}/groups/${gid}`, { role: 'member', canApprove: true });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual({ ...r.json().group, memberIds: [...r.json().group.memberIds].sort() }, { projectId: pid, groupId: gid, name: 'Elektro-Team', role: 'member', canEditPlan: false, canApprove: true, canFinalize: false, canUseAi: true, memberIds: [ids.max, ids.leser].sort() });
  const m = await row(pid, ids.max);
  assert.equal(m.origin, 'group');
  assert.equal(m.role, 'member');
  assert.equal(m.is_deputy, false);
  assert.equal(m.can_approve, true);
  assert.equal(m.can_use_ai, true, '„KI nutzen“ für Mitglieder vorbelegt');
  assert.equal(m.can_edit_plan, false);
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'group.project.set' and project_id = $1 and object_id = $2`, [pid, gid]));

  const d = await t.api(max).get(`/projects/${pid}`);
  assert.equal(d.statusCode, 200, 'Zugriff über die Gruppe');
  // Als Mitglied (über die Gruppe) holt Max keine Gruppen ins Projekt: nur die PL vergibt so Rechte
  const g2pre = await newGroup('Nachzügler', [ids.anna]);
  const asMember = await t.api(max).put(`/projects/${pid}/groups/${g2pre}`, { role: 'member', canEditPlan: true });
  assert.equal(asMember.statusCode, 403, asMember.body);
  assert.match(asMember.body, /Rolle pl erforderlich/);
  assert.equal(await row(pid, ids.anna), null);
  // Gruppen eines anderen Mandanten gibt es hier nicht
  const foreignOrg = (await t.db.one(`insert into orgs (name) values ('Fremdmandant') returning id`)).id;
  const foreignGroup = (await t.db.one(`insert into groups (org_id, name) values ($1, 'Fremde Gruppe') returning id`, [foreignOrg])).id;
  assert.equal((await t.api(pl).put(`/projects/${pid}/groups/${foreignGroup}`, { role: 'member' })).statusCode, 404, 'nur Gruppen des eigenen Mandanten');
  assert.equal(await t.db.maybeOne(`select 1 from project_groups where group_id = $1`, [foreignGroup]), null);
  assert.equal(d.json().members.find((x: any) => x.userId === ids.max).origin, 'group');
  assert.equal(d.json().members.find((x: any) => x.userId === ids.pl).origin, 'direct');
  assert.deepEqual(d.json().groups.map((g: any) => g.name), ['Elektro-Team']);
  assert.equal((await t.api(max).post(`/projects/${pid}/tasks`, { title: 'Über Gruppe angelegt' })).statusCode, 200, 'Mitgliedsrechte');

  // Lesergruppe: nur „KI nutzen“ (vorbelegt aus), Einzelrechte für Mitglieder entfallen
  const g2 = await newGroup('Lesekreis', [ids.anna]);
  const r2 = await t.api(pl).put(`/projects/${pid}/groups/${g2}`, { role: 'reader', canEditPlan: true, canApprove: true, canFinalize: true });
  assert.equal(r2.statusCode, 200, r2.body);
  assert.deepEqual([r2.json().group.canEditPlan, r2.json().group.canApprove, r2.json().group.canFinalize, r2.json().group.canUseAi], [false, false, false, false]);
  const a = await row(pid, ids.anna);
  assert.deepEqual([a.role, a.origin, a.can_edit_plan, a.can_use_ai], ['reader', 'group', false, false]);
  assert.equal((await t.api(pl).put(`/projects/${pid}/groups/${g2}`, { role: 'reader', canUseAi: true })).json().group.canUseAi, true, 'Leser mit „KI nutzen“ möglich');
  assert.equal((await row(pid, ids.anna)).can_use_ai, true);
});

test('Regel M: höchste Rolle zwischen Gruppen, Einzelrechte ODER-verknüpft; Direkteintrag überschreibt alle Gruppen; Gruppenrechte übernehmen', async () => {
  const pl = await t.login('pl@demo.local');
  const leser = await t.login('leser@demo.local');
  const pid = await newProject();
  const ga = await newGroup('Regel M A', [ids.leser]);
  const gb = await newGroup('Regel M B', [ids.leser]);
  const gc = await newGroup('Regel M C', [ids.leser]);
  await t.api(pl).put(`/projects/${pid}/groups/${ga}`, { role: 'reader', canUseAi: true });
  let m = await row(pid, ids.leser);
  assert.deepEqual([m.role, m.can_use_ai, m.can_edit_plan], ['reader', true, false]);
  await t.api(pl).put(`/projects/${pid}/groups/${gb}`, { role: 'member', canEditPlan: true, canUseAi: false });
  m = await row(pid, ids.leser);
  assert.deepEqual([m.role, m.can_edit_plan, m.can_use_ai, m.can_finalize], ['member', true, true, false], 'höchste Rolle (Mitglied), „KI nutzen“ aus A bleibt');
  await t.api(pl).put(`/projects/${pid}/groups/${gc}`, { role: 'member', canFinalize: true, canUseAi: false });
  m = await row(pid, ids.leser);
  assert.deepEqual([m.role, m.can_edit_plan, m.can_finalize, m.can_use_ai, m.can_approve, m.origin], ['member', true, true, true, false, 'group']);

  // Direkteintrag überschreibt alle Gruppen, auch spätere Änderungen an ihnen
  const direct = await t.api(pl).put(`/projects/${pid}/members/${ids.leser}`, { role: 'reader' });
  assert.equal(direct.statusCode, 200, direct.body);
  assert.equal(direct.json().membership.origin, 'direct');
  await t.api(pl).put(`/projects/${pid}/groups/${gb}`, { role: 'member', canEditPlan: true, canApprove: true, canUseAi: false });
  m = await row(pid, ids.leser);
  assert.deepEqual([m.role, m.origin, m.can_edit_plan, m.can_approve, m.can_finalize, m.can_use_ai], ['reader', 'direct', false, false, false, false], 'Gruppen ändern den Direkteintrag nicht');
  assert.equal((await t.api(leser).post(`/projects/${pid}/tasks`, { title: 'x' })).statusCode, 403, 'als Leser eingetragen');
  const listed = (await t.api(pl).get(`/projects/${pid}`)).json();
  assert.equal(listed.members.find((x: any) => x.userId === ids.leser).origin, 'direct');
  assert.ok(listed.groups.filter((g: any) => g.memberIds.includes(ids.leser)).length === 3, 'Oberfläche: „überschreibt …“ aus den Gruppen des Projekts');

  // Gruppenrechte übernehmen = Direkteintrag löschen → Gruppen gelten wieder
  const back = await t.api(pl).del(`/projects/${pid}/members/${ids.leser}`);
  assert.equal(back.statusCode, 200, back.body);
  assert.equal(back.json().membership.origin, 'group');
  assert.equal(back.json().membership.role, 'member');
  assert.equal(back.json().membership.canApprove, true, 'neue Rechte der Gruppe B');
  assert.equal((await t.api(pl).del(`/projects/${pid}/members/${ids.leser}`)).statusCode, 400, 'Gruppenzeile entfernt man über die Gruppe');
  assert.equal((await row(pid, ids.leser)).origin, 'group');

  // Gruppen entfernen → bis keine mehr zählt
  assert.equal((await t.api(leser).del(`/projects/${pid}/groups/${gb}`)).statusCode, 403, 'nur PL');
  assert.equal((await t.api(pl).del(`/projects/${pid}/groups/${gb}`)).statusCode, 200);
  assert.equal((await t.api(pl).del(`/projects/${pid}/groups/${gc}`)).statusCode, 200);
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'group.project.remove' and project_id = $1 and object_id = $2`, [pid, gc]));
  m = await row(pid, ids.leser);
  assert.deepEqual([m.role, m.can_edit_plan, m.can_use_ai], ['reader', false, true], 'nur noch A');
  assert.equal((await t.api(pl).del(`/projects/${pid}/groups/${gc}`)).statusCode, 404);
  await t.api(pl).del(`/projects/${pid}/groups/${ga}`);
  assert.equal(await row(pid, ids.leser), null);
  assert.equal((await t.api(leser).get(`/projects/${pid}`)).statusCode, 403);
});

test('Gruppenmitglieder ändern und Gruppe löschen ziehen die Projektmitgliedschaft nach; Direkteinträge bleiben', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const pid = await newProject();
  const gid = await newGroup('Montage', [ids.max]);
  await t.api(pl).put(`/projects/${pid}/groups/${gid}`, { role: 'member' });
  await t.api(pl).put(`/projects/${pid}/members/${ids.anna}`, { role: 'reader' });
  assert.equal((await t.api(admin).patch(`/groups/${gid}`, { memberIds: [ids.max, ids.anna, ids.leser] })).statusCode, 200);
  assert.equal((await row(pid, ids.leser)).origin, 'group', 'neues Gruppenmitglied wird Projektmitglied');
  assert.deepEqual([(await row(pid, ids.anna)).role, (await row(pid, ids.anna)).origin], ['reader', 'direct']);
  assert.equal((await t.api(admin).patch(`/groups/${gid}`, { memberIds: [ids.anna] })).statusCode, 200);
  assert.equal(await row(pid, ids.max), null, 'aus der Gruppe entfernt');
  assert.equal(await row(pid, ids.leser), null);
  assert.equal((await row(pid, ids.anna)).origin, 'direct');
  await t.api(admin).patch(`/groups/${gid}`, { memberIds: [ids.anna, ids.max] });
  assert.equal((await row(pid, ids.max)).origin, 'group');
  assert.equal((await t.api(admin).del(`/groups/${gid}`)).statusCode, 200);
  assert.equal(await row(pid, ids.max), null, 'Gruppe gelöscht → Gruppenzeilen weg');
  assert.equal((await row(pid, ids.anna)).origin, 'direct');
});

test('Agenten werden nie Gruppenmitglied; persönliche Projekte nehmen keine Gruppen auf', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const agent = (await t.api(admin).post('/agents', { name: 'Gruppenagent', aiProfileId: await llmFor(admin) })).json().agent;
  assert.equal((await t.api(admin).post('/groups', { name: 'Mit Agent', memberIds: [ids.max, agent.id] })).statusCode, 400);
  assert.equal(await t.db.maybeOne(`select 1 from groups where name = 'Mit Agent'`), null, 'keine leere Gruppe angelegt');
  assert.equal((await t.api(admin).post('/groups', { name: 'Mit Agent', memberIds: [ids.max], managerIds: [agent.id] })).statusCode, 400, 'auch nicht als Verwalter');
  assert.equal((await t.api(admin).post('/groups', { name: 'Mit Agent', memberIds: [ids.max] })).statusCode, 200, 'zweiter Versuch ohne Agent');
  const gid = await newGroup('Ohne Agent', [ids.max]);
  const p = await t.api(admin).patch(`/groups/${gid}`, { name: 'Umbenannt mit Agent', memberIds: [ids.max, agent.id] });
  assert.equal(p.statusCode, 400);
  assert.match(p.json().error ?? p.body, /KI-Agenten werden nie Gruppenmitglied/);
  const unchanged = (await t.api(admin).get('/groups')).json().groups.find((g: any) => g.id === gid);
  assert.deepEqual([unchanged.name, unchanged.memberIds], ['Ohne Agent', [ids.max]], 'nichts halb geändert');
  // Bestand (Agent bereits in der Gruppe): der Abgleich macht ihn nie zum Projektmitglied
  const pid = await newProject();
  await t.db.query(`insert into group_members (group_id, user_id) values ($1,$2)`, [gid, agent.id]);
  await t.api(pl).put(`/projects/${pid}/groups/${gid}`, { role: 'member' });
  assert.equal((await row(pid, ids.max)).origin, 'group');
  assert.equal(await row(pid, agent.id), null);

  // Persönliches Projekt
  await t.api(admin).put('/org/settings', { personalProjects: true });
  const max = await t.login('max@demo.local');
  const pp = (await t.api(max).post('/projects', { key: 'GRP', name: 'Max persönlich', personal: true })).json().project.id;
  const g2 = await newGroup('Für Persönlich', [ids.anna]);
  assert.equal((await t.api(max).put(`/projects/${pp}/groups/${g2}`, { role: 'reader' })).statusCode, 403);
  await t.db.query(`insert into project_groups (project_id, group_id, role) values ($1,$2,'member')`, [pp, g2]);
  await syncProjectGroups(t.db, { projectId: pp });
  assert.equal(await row(pp, ids.anna), null, 'auch eine Verknüpfung im Bestand wirkt nicht');
});

test('syncProjectGroups: Umfang Gruppe zieht nur deren Projekte nach, ohne Umfang alles', async () => {
  const pl = await t.login('pl@demo.local');
  const p1 = await newProject();
  const p2 = await newProject();
  const g1 = await newGroup('Umfang 1', [ids.max]);
  const g2 = await newGroup('Umfang 2', [ids.max]);
  await t.api(pl).put(`/projects/${p1}/groups/${g1}`, { role: 'reader' });
  await t.api(pl).put(`/projects/${p2}/groups/${g2}`, { role: 'reader' });
  // Rechte direkt in der Datenbank ändern, dann gezielt abgleichen
  await t.db.query(`update project_groups set role = 'member' where group_id = any($1::uuid[])`, [[g1, g2]]);
  await syncProjectGroups(t.db, { groupId: g1 });
  assert.equal((await row(p1, ids.max)).role, 'member');
  assert.equal((await row(p2, ids.max)).role, 'reader', 'Projekt der anderen Gruppe unberührt');
  await syncProjectGroups(t.db, { userId: ids.anna });
  assert.equal((await row(p2, ids.max)).role, 'reader', 'Umfang Benutzer: nur diese Person');
  await syncProjectGroups(t.db);
  assert.equal((await row(p2, ids.max)).role, 'member');
});

test('Benutzer: Rolle, Org-Rechte, Deaktivieren und Reaktivieren (Gruppenzeilen ruhen); eigener Zugang und letzter Org-Admin geschützt', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const gina = await newUser('gina@demo.local', 'Gina Gruppe');
  const pid = await newProject();
  const other = await newProject();
  const gid = await newGroup('Ginas Team', [gina]);
  await t.api(pl).put(`/projects/${pid}/groups/${gid}`, { role: 'member' });
  await t.api(pl).put(`/projects/${other}/members/${gina}`, { role: 'member' });
  assert.equal((await row(pid, gina)).origin, 'group');
  await t.login('gina@demo.local');

  assert.equal((await t.api(pl).patch(`/users/${gina}`, { active: false })).statusCode, 403, 'nur Org-Admin');
  assert.equal((await t.api(admin).patch(`/users/${gina}`, { name: 'x' })).statusCode, 400);
  assert.equal((await t.api(admin).patch(`/users/${gina}`, { active: 'nein' })).statusCode, 400);
  const off = await t.api(admin).patch(`/users/${gina}`, { active: false });
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(off.json().user.active, false);
  assert.equal(await row(pid, gina), null, 'Gruppenzeile entfällt');
  assert.equal((await row(other, gina)).origin, 'direct', 'Direkteintrag bleibt');
  assert.equal((await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'gina@demo.local', password: DEMO_PASSWORD } })).statusCode, 401);
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'user.deactivate' and object_id = $1`, [gina]));
  assert.ok(!(await t.api(admin).get('/users')).json().users.some((u: any) => u.id === gina), 'Liste ohne Deaktivierte');
  assert.equal((await t.api(admin).get('/users?all=1')).json().users.find((u: any) => u.id === gina).active, false, 'Verwaltung sieht Deaktivierte');
  assert.ok(!(await t.api(pl).get('/users?all=1')).json().users.some((u: any) => u.id === gina), 'nur der Org-Admin');

  const on = await t.api(admin).patch(`/users/${gina}`, { active: true });
  assert.equal(on.statusCode, 200, on.body);
  assert.equal(on.json().user.active, true);
  assert.equal((await row(pid, gina)).origin, 'group', 'Gruppenzeile kommt zurück');
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'user.reactivate' and object_id = $1`, [gina]));
  assert.ok(await t.login('gina@demo.local'), 'Anmeldung wieder möglich');

  // Rolle und Org-Rechte
  const role = await t.api(admin).patch(`/users/${gina}`, { globalRole: 'project_creator', orgRights: ['groups_admin'] });
  assert.equal(role.statusCode, 200, role.body);
  assert.deepEqual([role.json().user.globalRole, role.json().user.orgRights], ['project_creator', ['groups_admin']]);
  const entry = await t.db.one(`select details from audit_log where action = 'user.role' and object_id = $1 order by created_at desc limit 1`, [gina]);
  assert.deepEqual(entry.details.before, { globalRole: 'user', orgRights: [] });
  assert.equal((await t.api(admin).patch(`/users/${gina}`, { globalRole: 'user' })).json().user.orgRights.length, 1, 'Org-Rechte bleiben ohne Angabe');

  // Eigener Zugang: nicht selbst deaktivieren (PATCH und POST)
  assert.equal((await t.api(admin).patch(`/users/${ids.admin}`, { active: false })).statusCode, 403);
  assert.equal((await t.api(admin).post(`/users/${ids.admin}/deactivate`)).statusCode, 403);
  // Letzter aktiver Org-Admin: nicht herabstufen
  const last = await t.api(admin).patch(`/users/${ids.admin}`, { globalRole: 'user' });
  assert.equal(last.statusCode, 400);
  assert.match(last.body, /letzte aktive Org-Admin/);
  assert.equal((await t.db.one(`select global_role from users where id = $1`, [ids.admin])).global_role, 'org_admin');
  // Mit einer zweiten Org-Admin darf sich eine von beiden herabstufen
  const olga = await newUser('olga@demo.local', 'Olga Org', 'org_admin');
  const olgaS = await t.login('olga@demo.local');
  const self = await t.api(olgaS).patch(`/users/${olga}`, { globalRole: 'user' });
  assert.equal(self.statusCode, 200, self.body);
  assert.equal(self.json().user.globalRole, 'user');
  // Eine weitere Org-Admin deaktivieren geht (die aufrufende bleibt)
  const olga2 = await newUser('olga2@demo.local', 'Olga Zwei', 'org_admin');
  assert.equal((await t.api(admin).post(`/users/${olga2}/deactivate`)).statusCode, 200);
  assert.equal((await t.api(admin).patch(`/users/${ids.admin}`, { globalRole: 'user' })).statusCode, 400, 'deaktivierte Org-Admins zählen nicht');

  // Agenten: keine Rolle, kein Aktiv-Status über diese Route
  const agent = (await t.api(admin).post('/agents', { name: 'Rollenagent', aiProfileId: await llmFor(admin) })).json().agent;
  assert.equal((await t.api(admin).patch(`/users/${agent.id}`, { globalRole: 'project_creator' })).statusCode, 400);
  assert.equal((await t.api(admin).patch(`/users/${agent.id}`, { active: false })).statusCode, 400);
});

test('Gruppenverwaltung: groups_admin pflegt alle Gruppen, Verwalter einer Gruppe nur deren Mitglieder', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const gid = await newGroup('Bau', [ids.leser], [ids.max]);
  const g = (await t.api(admin).get('/groups')).json().groups.find((x: any) => x.id === gid);
  assert.deepEqual([...g.memberIds].sort(), [ids.max, ids.leser].sort(), 'Verwalter sind Mitglied');
  assert.deepEqual(g.managerIds, [ids.max]);
  const other = await newGroup('Fremd', [ids.leser]);
  const max = await t.login('max@demo.local');
  const leser = await t.login('leser@demo.local');
  assert.equal((await t.api(max).get('/auth/me')).json().user.managesGroups, true);
  assert.equal((await t.api(leser).get('/auth/me')).json().user.managesGroups, false);
  // Anmeldung und eigene Einstellungen liefern es ebenso (die Web-App ersetzt damit den Benutzer)
  assert.equal((await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'max@demo.local', password: DEMO_PASSWORD } })).json().user.managesGroups, true);
  assert.equal((await t.api(max).patch('/me', { settings: { theme: 'dark' } })).json().user.managesGroups, true);
  assert.equal((await t.api(leser).patch('/me', { settings: { theme: 'dark' } })).json().user.managesGroups, false);

  const pid = await newProject();
  await t.api(pl).put(`/projects/${pid}/groups/${gid}`, { role: 'reader' });
  assert.equal((await t.api(leser).patch(`/groups/${gid}`, { memberIds: [ids.max] })).statusCode, 403, 'kein Verwalter');
  assert.equal((await t.api(max).post('/groups', { name: 'Neu' })).statusCode, 403);
  const add = await t.api(max).patch(`/groups/${gid}`, { memberIds: [ids.max, ids.leser, ids.anna] });
  assert.equal(add.statusCode, 200, add.body);
  assert.ok(add.json().group.memberIds.includes(ids.anna));
  assert.deepEqual(add.json().group.managerIds, [ids.max], 'Verwalter bleiben');
  assert.equal((await row(pid, ids.anna)).origin, 'group', 'Änderung des Verwalters wirkt im Projekt');
  assert.equal((await t.api(max).patch(`/groups/${gid}`, { name: 'Umbenannt' })).statusCode, 403);
  assert.equal((await t.api(max).patch(`/groups/${gid}`, { memberIds: [ids.leser], managerIds: [] })).statusCode, 403);
  assert.equal((await t.api(max).patch(`/groups/${gid}`, { memberIds: [ids.leser, ids.anna] })).statusCode, 400, 'Verwalter bleiben Mitglied');
  assert.equal((await t.api(max).patch(`/groups/${other}`, { memberIds: [ids.leser, ids.max] })).statusCode, 403, 'fremde Gruppe');
  assert.equal((await t.api(max).del(`/groups/${gid}`)).statusCode, 403);
  assert.equal((await t.api(max).patch(`/groups/${gid}`, { memberIds: [ids.max, ids.leser] })).statusCode, 200);
  assert.equal(await row(pid, ids.anna), null);

  // Org-Recht groups_admin: alle Gruppen samt Verwaltern
  const anna = await t.login('anna@demo.local');
  assert.equal((await t.api(anna).post('/groups', { name: 'Vor dem Recht' })).statusCode, 403);
  await t.api(admin).patch(`/users/${ids.anna}`, { orgRights: ['groups_admin'] });
  const created = await t.api(anna).post('/groups', { name: 'Von Anna', memberIds: [ids.leser], managerIds: [ids.pl] });
  assert.equal(created.statusCode, 200, created.body);
  assert.deepEqual(created.json().group.managerIds, [ids.pl]);
  const renamed = await t.api(anna).patch(`/groups/${other}`, { name: 'Fremd (neu)', managerIds: [ids.leser] });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.deepEqual([renamed.json().group.name, renamed.json().group.managerIds], ['Fremd (neu)', [ids.leser]]);
  assert.equal((await t.api(anna).del(`/groups/${created.json().group.id}`)).statusCode, 200);
  await t.api(admin).patch(`/users/${ids.anna}`, { orgRights: [] });
});

test('Org-Admin bestimmt die verantwortliche PL neu, ohne Inhaltszugriff; die bisherige wird Stellvertretung', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const pid = await newProject();
  const task = (await t.api(pl).post(`/projects/${pid}/tasks`, { title: 'Direkt bei der PL', responsibleUserId: ids.pl })).json().task;
  const list = await t.api(admin).get('/admin/projects');
  assert.equal(list.statusCode, 200);
  const entry = list.json().projects.find((p: any) => p.id === pid);
  assert.deepEqual(entry.lead, { userId: ids.pl, name: 'Petra Lenz', active: true });
  assert.deepEqual(Object.keys(entry).sort(), ['id', 'key', 'lead', 'name', 'status'], 'nur Kennung, Name, PL');
  assert.ok(!list.json().projects.some((p: any) => p.key === 'GRP'), 'persönliche Projekte nicht');
  assert.equal((await t.api(pl).get('/admin/projects')).statusCode, 403);
  assert.equal((await t.api(pl).put(`/admin/projects/${pid}/lead`, { userId: ids.max })).statusCode, 403, 'nur Org-Admin, auch nicht die PL selbst');

  const agent = (await t.api(admin).post('/agents', { name: 'Leitagent', aiProfileId: await llmFor(admin) })).json().agent;
  assert.equal((await t.api(admin).put(`/admin/projects/${pid}/lead`, { userId: agent.id })).statusCode, 400, 'nur Personen');
  const dora = await newUser('dora@demo.local', 'Dora Deaktiviert');
  assert.equal((await t.api(admin).patch(`/users/${dora}`, { active: false })).statusCode, 200);
  assert.equal((await t.api(admin).put(`/admin/projects/${pid}/lead`, { userId: dora })).statusCode, 400, 'nur aktive Personen');
  // Nie sich selbst: das wäre Zugriff auf die Projektinhalte über die Verwaltung
  const self = await t.api(admin).put(`/admin/projects/${pid}/lead`, { userId: ids.admin });
  assert.equal(self.statusCode, 403, self.body);
  assert.equal(await row(pid, ids.admin), null);
  assert.equal((await t.api(admin).get(`/projects/${pid}`)).statusCode, 403);
  assert.deepEqual([(await row(pid, ids.pl)).role, (await row(pid, ids.pl)).is_deputy], ['pl', false], 'PL unverändert');
  const r = await t.api(admin).put(`/admin/projects/${pid}/lead`, { userId: ids.max, transferTasks: true });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().transferred, 1);
  const lead = await row(pid, ids.max);
  assert.deepEqual([lead.role, lead.is_deputy, lead.origin, lead.can_approve], ['pl', false, 'direct', true]);
  const before = await row(pid, ids.pl);
  assert.deepEqual([before.role, before.is_deputy], ['pl', true]);
  assert.equal(await row(pid, ids.admin), null, 'Org-Admin wird nicht Mitglied');
  assert.equal((await t.api(admin).get(`/projects/${pid}`)).statusCode, 403, 'kein Inhaltszugriff');
  assert.equal((await t.db.one(`select responsible_user_id from tasks where id = $1`, [task.id])).responsible_user_id, ids.max);
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'project.lead' and project_id = $2`, [ids.max, pid]));
  const told = await t.db.maybeOne(`select title, body from notifications where user_id = $1 and type = 'project.lead' and project_id = $2`, [ids.pl, pid]);
  assert.ok(told, 'die bisherige PL erfährt es');
  assert.match(told.title, /Verantwortliche PL neu bestimmt/);
  assert.match(told.body, /Max Keller.*Stellvertretung/);
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'project.lead' and project_id = $1`, [pid]));

  const pp = (await t.db.one(`select id from projects where key = 'GRP'`)).id;
  assert.equal((await t.api(admin).put(`/admin/projects/${pp}/lead`, { userId: ids.anna })).statusCode, 403, 'persönliche Projekte gehören ihrem Ersteller');
});

test('„KI nutzen“ einheitlich vorbelegt: Mitglied an, Leser aus (API und Einladung)', async () => {
  const pl = await t.login('pl@demo.local');
  const pid = await newProject();
  await t.api(pl).put(`/projects/${pid}/members/${ids.max}`, { role: 'member' });
  await t.api(pl).put(`/projects/${pid}/members/${ids.leser}`, { role: 'reader' });
  assert.equal((await row(pid, ids.max)).can_use_ai, true);
  assert.equal((await row(pid, ids.leser)).can_use_ai, false);
  await t.api(pl).put(`/projects/${pid}/members/${ids.leser}`, { role: 'reader', canUseAi: true });
  assert.equal((await row(pid, ids.leser)).can_use_ai, true, 'ausdrücklich gesetzt');
  for (const [email, projectRole, expected] of [['neu-leser@demo.local', 'reader', false], ['neu-mitglied@demo.local', 'member', true]] as const) {
    const inv = await t.api(pl).post('/invitations', { email, name: 'Neu', projectId: pid, projectRole });
    assert.equal(inv.statusCode, 200, inv.body);
    const token = (await t.db.one(`select token from invitations where email = $1`, [email])).token;
    const acc = await t.app.inject({ method: 'POST', url: `/api/invitations/accept/${token}`, payload: { password: 'ein-langes-passwort' } });
    assert.equal(acc.statusCode, 200, acc.body);
    assert.equal((await row(pid, acc.json().user.id)).can_use_ai, expected, projectRole);
  }
});
