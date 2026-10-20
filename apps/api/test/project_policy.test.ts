import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { testApp } from './helpers.js';
import { projectPolicy, createProjectReason, TEXT } from '../src/projectPolicy.js';

delete process.env.ANTHROPIC_API_KEY;
const t = await testApp();
test.after(() => t.close());

test('projectPolicy: neun Abweichungen als Entscheidungen, sonst identisch', () => {
  const n = projectPolicy({ personal: false });
  const p = projectPolicy({ personal: true });
  assert.equal(createProjectReason({ kind: 'person', globalRole: 'user' }, true, false), TEXT.createDenied);
  assert.equal(createProjectReason({ kind: 'person', globalRole: 'user' }, true, true), null);
  assert.equal(createProjectReason({ kind: 'agent', globalRole: 'user' }, true, true), 'Persönliche Projekte sind im Mandanten nicht freigegeben (Verwaltung)', 'Agenten nie');
  assert.equal(createProjectReason({ kind: 'person', globalRole: 'user' }, false, true), 'Nur Projektersteller dürfen Projekte anlegen');
  assert.equal(createProjectReason({ kind: 'person', globalRole: 'project_creator' }, true, false), null);
  assert.deepEqual(p.members, { onlyOwnerAndAgents: true, groups: false, invitations: false });
  assert.deepEqual(n.members, { onlyOwnerAndAgents: false, groups: true, invitations: true });
  assert.equal(p.visibility.org, false); assert.equal(n.visibility.org, true);
  assert.deepEqual(p.adminAccess, { content: false, accounts: false, auditDetails: false, listed: false, lead: false });
  assert.deepEqual(n.adminAccess, { content: true, accounts: true, auditDetails: true, listed: true, lead: true });
  assert.deepEqual(p.mail, { ownOnly: true, orgFallback: false }); assert.deepEqual(n.mail, { ownOnly: false, orgFallback: true });
  assert.equal(p.ai.ownLlm('personal'), true); assert.equal(n.ai.ownLlm('personal'), false); assert.equal(n.ai.ownLlm('all'), true); assert.equal(p.ai.ownLlm('off'), false);
  assert.equal(p.ai.orgProfilesNeedRelease, true); assert.equal(n.ai.orgProfilesNeedRelease, false);
  assert.equal(p.channelPosts, false); assert.equal(n.channelPosts, true);
  assert.deepEqual(p.scaffold, { defaultFolders: false, template: false }); assert.deepEqual(n.scaffold, { defaultFolders: true, template: true });
  assert.equal(p.label, 'persönliches Projekt'); assert.equal(n.label, 'Projekt');
});

test('Statisch: das Flag „personal“ wird außerhalb von projectPolicy.ts nirgends ausgewertet (nur geladen)', async () => {
  const files: string[] = [];
  const walk = async (dir: string) => { for (const e of await readdir(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) await walk(f); else if (f.endsWith('.ts')) files.push(f); } };
  await walk(path.resolve(import.meta.dirname, '../src'));
  // Auswertung in JS (!p.personal, proj.personal &&, ? p.personal) und in SQL-Prädikaten (and p.personal, not p.personal, when p.personal)
  const js = /[!(&|?:]\s*[A-Za-z_$][\w$.]*\.personal\b(?![\w'])/g;
  const sql = /\b(and|or|not|when|where)\s+(\w+\.)?personal\b(?![\w'])/gi;
  const allowed: Record<string, { js: number; sql: number }> = {
    'projectPolicy.ts': { js: Infinity, sql: Infinity },
    'routes/projects.ts': { js: 1, sql: 0 }, // mapProject: personal: Boolean(r.personal)
  };
  const bad: string[] = [];
  for (const f of files) {
    const rel = path.relative(path.resolve(import.meta.dirname, '../src'), f);
    const src = await readFile(f, 'utf8');
    const nJs = (src.match(js) ?? []).length; const nSql = (src.match(sql) ?? []).length;
    const lim = allowed[rel] ?? { js: 0, sql: 0 };
    if (nJs > lim.js || nSql > lim.sql) bad.push(`${rel}: js=${nJs} sql=${nSql}`);
  }
  assert.deepEqual(bad, [], 'Abweichungen gehören nach projectPolicy.ts');
  assert.ok(/case when \$\{p\}\.personal/.test(await readFile(path.resolve(import.meta.dirname, '../src/projectPolicy.ts'), 'utf8')), 'Selbsttest: das Muster erkennt Auswertungen');
  assert.equal(('if (!p.personal) x; where p.personal and y'.match(js) ?? []).length, 1);
  assert.equal(('where id = $1 and personal'.match(sql) ?? []).length, 1);
  assert.equal(('select personal, created_by from projects'.match(sql) ?? []).length, 0, 'Laden bleibt erlaubt');
});

test('Persönliches Projekt im Betrieb: Vorlage 400, keine Gruppen, keine Einladung, keine Org-Sichtbarkeit, Admin-Liste/PL-Wechsel gesperrt, kein Projektkanal-Beitrag, Mail-Schritt ohne Org-Rückfall', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const tpl = await t.db.one(`insert into project_templates (org_id, name, spec, created_by) values ($1, 'Leer', '{"folders":["Doku"]}'::jsonb, $2) returning id`, [t.ids.org, t.ids.users.admin]);
  assert.equal((await t.api(pl).post('/projects', { key: 'PPX', name: 'Mit Vorlage', personal: true, templateId: tpl.id })).statusCode, 400, TEXT.noTemplate);
  const r = await t.api(pl).post('/projects', { key: 'PP1', name: 'Petra privat', personal: true });
  assert.equal(r.statusCode, 200, r.body);
  const pid = r.json().project.id;
  assert.equal((await t.db.one(`select count(*)::int as c from doc_folders where project_id = $1`, [pid])).c, 0, 'leer');
  assert.equal((await t.api(pl).patch(`/projects/${pid}`, { visibility: 'org' })).statusCode, 400);
  assert.equal((await t.api(pl).put(`/projects/${pid}/members/${t.ids.users.anna}`, { role: 'member' })).statusCode, 403);
  const g = (await t.api(admin).post('/groups', { name: 'PP-Gruppe' })).json().group;
  assert.equal((await t.api(pl).put(`/projects/${pid}/groups/${g.id}`, { role: 'member' })).statusCode, 403);
  assert.equal((await t.api(pl).post('/invitations', { email: 'neu@extern.de', name: 'Neu', projectId: pid })).statusCode, 403);
  assert.ok(!(await t.api(admin).get('/admin/projects')).json().projects.some((p: any) => p.id === pid), 'nicht in der Verwaltungsliste');
  assert.equal((await t.api(admin).put(`/admin/projects/${pid}/lead`, { userId: t.ids.users.anna })).statusCode, 403);
  assert.equal((await t.api(admin).get(`/projects/${pid}`)).statusCode, 403, 'kein Inhaltszugriff');
  // Meldung mit chat=project: in normalen Projekten Systembeitrag im Projektkanal, hier nicht (der Kanal existiert)
  assert.equal((await t.api(pl).put(`/projects/${pid}/notification-rules`, { rules: [{ event: 'assigned', recipients: ['responsible', 'pl'], channels: { chat: 'project', log: true } }] })).statusCode, 200);
  const llm = (await t.api(admin).post('/ai/profiles', { name: 'Agenten-LLM', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'x', personalScope: true })).json().profile;
  const agent = (await t.api(admin).post('/agents', { name: 'PP-Agent', aiProfileId: llm.id })).json().agent;
  assert.equal((await t.api(pl).put(`/projects/${pid}/members/${agent.id}`, { role: 'member' })).statusCode, 200, 'Agenten ja');
  const col = (await t.api(pl).get(`/projects/${pid}`)).json().columns[0].id;
  const task = (await t.api(pl).post(`/projects/${pid}/tasks`, { title: 'Kanaltest privat', columnId: col, responsibleUserId: agent.id })).json().task;
  assert.ok(task?.id, 'AP angelegt');
  const chat = (await t.api(pl).get(`/projects/${pid}/chat`)).json();
  assert.equal(chat.messages.filter((m: any) => m.kind === 'system').length, 0, 'keine Systembeiträge im Kanal des persönlichen Projekts');
  // Workflow-Mailschritt: kein Projektkonto → kein Rückfall auf das Org-Postfach
  await t.api(admin).post('/mail/accounts', { type: 'org', name: 'Org', address: 'org-pp@demo.local', provider: 'dev' });
  const def = (await t.api(admin).post('/workflows', { name: 'Mail PP', steps: [{ type: 'mail', title: 'Info', toStarter: true, subject: 'Hallo', text: 'Text' }] })).json().definition;
  const before = t.mail.dev.sent.length;
  const run = (await t.api(pl).post(`/projects/${pid}/workflows/${def.id}/start`, { name: 'Lauf PP' })).json().run;
  const after = (await t.api(pl).get(`/workflow-runs/${run.id}`)).json().run;
  assert.equal(t.mail.dev.sent.length, before, 'nichts über das Org-Postfach');
  assert.match(String(after.lastError ?? ''), new RegExp(TEXT.noOrgFallback));
  // Normales Projekt: Rückfall auf das Org-Postfach bleibt
  const run2 = (await t.api(pl).post(`/projects/${t.ids.projects.erp}/workflows/${def.id}/start`, { name: 'Lauf ERP' })).json().run;
  const after2 = (await t.api(pl).get(`/workflow-runs/${run2.id}`)).json().run;
  assert.equal(after2.lastError ?? null, null, 'ERP ohne Projektkonto sendet über das Org-Postfach');
  assert.equal(t.mail.dev.sent.length, before + 1);
});
