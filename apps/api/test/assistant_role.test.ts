import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { flushAgentRuns } from '../src/ai/agentEvents.js';
import { aiAllowed } from '../src/ai/policy.js';
import { TEXT } from '../src/projectPolicy.js';
import { initialsOf } from '../src/personalProject.js';

/**
 * Persönlicher Assistent („Jarvis“) je Benutzer: Einladung mit Opt-out-Haken legt bei Annahme das persönliche Projekt an;
 * Freigabe je Person (personalProjectAllowed) durch die Verwaltung; LLM-Freigabe je Profil (personalUse none/all/users);
 * Assistent als eigener Agententyp (agent_role assistant): nur Eigentümer, nur einer, nur freigegebenes LLM, nicht einladbar,
 * ignoriert Kanal-Erwähnungen, Direktnachricht gilt ohne Rückfrage als persönlich; persönliches Projekt schlank.
 */
const prompts: string[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (String(input) !== 'http://llm.local:8000/v1/chat/completions') return new Response('{}', { status: 404 });
  const system = body.messages?.[0]?.content ?? '';
  let content = 'bereit';
  if (body.response_format && system.includes('Man erreicht dich im Chat')) { prompts.push(String(body.messages?.[1]?.content ?? '')); content = JSON.stringify({ reply: 'Gern, hier die Antwort.', notes: [], answers: [], commands: [] }); }
  else if (body.response_format) content = JSON.stringify({ note: 'nichts zu tun', actions: [{ type: 'none', reason: 'Test' }] });
  return new Response(JSON.stringify({ model: 'qwen', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { status: 200 });
};
delete process.env.ANTHROPIC_API_KEY;
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());

const accept = async (admin: any, email: string, name: string, personalProject?: boolean) => {
  const inv = await t.api(admin).post('/invitations', { email, name, ...(personalProject === undefined ? {} : { personalProject }) });
  assert.equal(inv.statusCode, 200, inv.body);
  const token = inv.json().invitation.link.split('/einladung/')[1];
  const info = await t.app.inject({ method: 'GET', url: `/api/invitations/accept/${token}` });
  const acc = await t.app.inject({ method: 'POST', url: `/api/invitations/accept/${token}`, payload: { password: 'sicheres-passwort-1' } });
  assert.equal(acc.statusCode, 200, acc.body);
  return { invitation: inv.json().invitation, info: info.json(), user: acc.json().user, personalProjectId: acc.json().personalProjectId as string | null, cookies: { pt_session: acc.cookies.find((c) => c.name === 'pt_session')!.value } };
};

let ninaPid = ''; let nina: any; let max: any; let maxPid = ''; let llm: any; let assistant: any; let dm = '';

test('Kürzel aus Initialen', () => {
  assert.equal(initialsOf('Max Keller'), 'MK');
  assert.equal(initialsOf('Max'), 'MP');
  assert.equal(initialsOf('Anna-Lena Müller-Lüdenscheidt'), 'ALML');
});

test('Einladung ohne Projekt: Haken (Standard an) legt bei Annahme das persönliche Projekt an, auch ohne Mandantenschalter; ohne Haken nicht', async () => {
  const admin = await t.login('admin@demo.local');
  assert.equal((await t.api(admin).get('/org/settings')).json().settings.personalProjects ?? false, false, 'Mandantenschalter aus');
  const without = await accept(admin, 'ohne@extern.de', 'Olaf Ohne', false);
  assert.equal(without.invitation.personalProject, false);
  assert.equal(without.personalProjectId, null);
  assert.equal(without.user.personalProjectAllowed, null, 'folgt dem Mandantenschalter');
  assert.equal((await t.api(without.cookies).post('/projects', { key: 'OO', name: 'Olaf', personal: true })).statusCode, 403, 'ohne Freigabe kein persönliches Projekt');

  const r = await accept(admin, 'nina@extern.de', 'Nina Neu');
  nina = r.cookies;
  assert.equal(r.invitation.personalProject, true, 'Standard an');
  assert.equal(r.info.personalProject, true);
  assert.equal(r.user.personalProjectAllowed, true);
  assert.ok(r.personalProjectId);
  ninaPid = r.personalProjectId!;
  const p = (await t.api(nina).get(`/projects/${ninaPid}`)).json();
  assert.equal(p.project.personal, true);
  assert.equal(p.project.key, 'NN1');
  assert.equal(p.project.name, 'Persönlich – Nina Neu');
  assert.equal(p.project.myRole, 'pl');
  // F: schlank
  assert.deepEqual(p.columns.map((c: any) => [c.name, c.kind]), [['Offen', 'active'], ['Erledigt', 'done']]);
  assert.deepEqual((await t.db.query(`select name from doc_folders where project_id = $1`, [ninaPid])).rows.map((f: any) => f.name), ['Notizen']);
  assert.equal(p.project.planningDepth, 'checkliste');
  assert.equal(p.project.escalation.enabled, false);
  assert.equal(p.project.reporting.enabled, false);
  assert.equal(p.project.slim, true);
  assert.equal(p.project.showAllTabs, false);
  assert.equal((await t.api(nina).patch(`/projects/${ninaPid}`, { showAllTabs: true })).json().project.slim, false, 'alle Reiter einschalten');
  assert.equal((await t.api(nina).patch(`/projects/${ninaPid}`, { showAllTabs: 'x' })).statusCode, 400);
  // Einladung mit Projekt: kein Haken, kein persönliches Projekt
  const pl = await t.login('pl@demo.local');
  const inProject = await t.api(pl).post('/invitations', { email: 'web@extern.de', name: 'Wiebke Web', projectId: t.ids.projects.web });
  assert.equal(inProject.json().invitation.personalProject, false);
});

test('Verwaltung setzt personalProjectAllowed: true legt das Projekt an, false sperrt die KI darin (Hinweis), null folgt dem Mandanten', async () => {
  const admin = await t.login('admin@demo.local');
  max = await t.login('max@demo.local');
  assert.equal((await t.api(max).post('/projects', { key: 'MX', name: 'x', personal: true })).statusCode, 403);
  assert.equal((await t.api(admin).patch(`/users/${t.ids.users.max}`, { personalProjectAllowed: 'ja' })).statusCode, 400);
  const r = await t.api(admin).patch(`/users/${t.ids.users.max}`, { personalProjectAllowed: true });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().user.personalProjectAllowed, true);
  maxPid = r.json().personalProject.id;
  assert.equal(r.json().personalProject.key, 'MK1');
  assert.equal((await t.api(max).get(`/projects/${maxPid}`)).json().project.myRole, 'pl');
  assert.ok((await t.api(admin).get('/users')).json().users.find((u: any) => u.id === t.ids.users.max).personalProjectAllowed === true);
  // Erneut true: kein zweites Projekt
  assert.equal((await t.api(admin).patch(`/users/${t.ids.users.max}`, { personalProjectAllowed: true })).json().personalProject.id, maxPid);
  // false: Projekt bleibt, KI gesperrt (G)
  const off = await t.api(admin).patch(`/users/${t.ids.users.max}`, { personalProjectAllowed: false });
  assert.equal(off.statusCode, 200);
  assert.match(off.json().notice, /KI .* gesperrt/);
  assert.equal((await t.api(max).get(`/projects/${maxPid}`)).statusCode, 200, 'Projekt bleibt');
  const d = await aiAllowed(t.db, { userId: t.ids.users.max, projectId: maxPid, feature: 'agent.chat' });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, TEXT.personalBlocked);
  assert.equal(d.reason, 'Persönliche KI für diese Person gesperrt (Verwaltung)');
  assert.ok((await aiAllowed(t.db, { userId: t.ids.users.max, projectId: t.ids.projects.web, feature: 'agent.chat' })).allowed, 'normale Projekte unberührt');
  // null: Mandantenschalter gilt (aus → gesperrt, an → frei)
  assert.equal((await t.api(admin).patch(`/users/${t.ids.users.max}`, { personalProjectAllowed: null })).json().user.personalProjectAllowed, null);
  assert.equal((await aiAllowed(t.db, { userId: t.ids.users.max, projectId: maxPid, feature: 'agent.chat' })).allowed, false);
  await t.api(admin).put('/org/settings', { personalProjects: true });
  assert.ok((await aiAllowed(t.db, { userId: t.ids.users.max, projectId: maxPid, feature: 'agent.chat' })).allowed);
  await t.api(admin).put('/org/settings', { personalProjects: false });
  await t.api(admin).patch(`/users/${t.ids.users.max}`, { personalProjectAllowed: true });
  // Agenten nicht
  const agentRow = await t.db.maybeOne(`select id from users where kind = 'agent' limit 1`);
  if (agentRow) assert.equal((await t.api(admin).patch(`/users/${agentRow.id}`, { personalProjectAllowed: true })).statusCode, 400);
});

test('LLM-Freigabe je Profil: none (Standard) sperrt persönliche Projekte, users nur für genannte Personen, all für alle; personalScope bleibt als Alias', async () => {
  const admin = await t.login('admin@demo.local');
  llm = (await t.api(admin).post('/ai/profiles', { name: 'Qwen', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'qwen' })).json().profile;
  assert.equal(llm.personalUse, 'none');
  assert.equal(llm.personalScope, false);
  const names = async (c: any, pid: string) => (await t.api(c).get(`/projects/${pid}/assistant`)).json().profiles.map((x: any) => x.name);
  assert.ok(!(await names(max, maxPid)).includes('Qwen'), 'none');
  let st = (await t.api(max).get(`/projects/${maxPid}/assistant`)).json();
  assert.equal(st.assistant, null);
  assert.equal(st.canCreate, false);
  assert.deepEqual(st.blocked, [TEXT.assistantNoProfile]);
  // users: nur Max
  assert.equal((await t.api(admin).patch(`/ai/profiles/${llm.id}`, { personalUse: 'users', personalUserIds: [t.ids.users.max] })).statusCode, 200);
  const p = (await t.api(admin).get('/ai/status')).json().profiles.find((x: any) => x.id === llm.id);
  assert.equal(p.personalUse, 'users');
  assert.deepEqual(p.personalUserIds, [t.ids.users.max]);
  assert.ok((await names(max, maxPid)).includes('Qwen'), 'users: Max');
  assert.ok(!(await names(nina, ninaPid)).includes('Qwen'), 'users: Nina nicht');
  // Org-Agent mit diesem LLM: nur in Max' persönlichem Projekt einsetzbar (aiAllowed / agentUsableIn)
  const orgAgent = (await t.api(admin).post('/agents', { name: 'Orga', aiProfileId: llm.id })).json().agent;
  assert.equal((await t.api(nina).put(`/projects/${ninaPid}/members/${orgAgent.id}`, { role: 'member' })).statusCode, 400, 'LLM für Nina nicht freigegeben');
  assert.equal((await t.api(max).put(`/projects/${maxPid}/members/${orgAgent.id}`, { role: 'member' })).statusCode, 200);
  assert.ok((await aiAllowed(t.db, { userId: orgAgent.id, projectId: maxPid, feature: 'agent.chat', budget: false })).allowed);
  // all
  assert.equal((await t.api(admin).patch(`/ai/profiles/${llm.id}`, { personalUse: 'all' })).statusCode, 200);
  assert.ok((await names(nina, ninaPid)).includes('Qwen'), 'all');
  assert.equal((await t.api(admin).patch(`/ai/profiles/${llm.id}`, { personalUse: 'egal' })).statusCode, 400);
  // Alias: personalScope false → none
  assert.equal((await t.api(admin).patch(`/ai/profiles/${llm.id}`, { personalScope: false })).json().profile.personalUse, 'none');
  assert.ok(!(await names(nina, ninaPid)).includes('Qwen'));
  assert.equal((await t.api(admin).patch(`/ai/profiles/${llm.id}`, { personalScope: true })).json().profile.personalUse, 'all');
  assert.equal((await t.api(max).del(`/projects/${maxPid}/members/${orgAgent.id}`)).statusCode, 200);
});

test('Assistent anlegen: nur der Eigentümer, nur ein freigegebenes LLM, höchstens einer; gebunden ans persönliche Projekt mit Standardrechten', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  assert.equal((await t.api(admin).get(`/projects/${maxPid}/assistant`)).statusCode, 403, 'Org-Admin ist kein Mitglied');
  assert.equal((await t.api(max).post(`/projects/${t.ids.projects.web}/assistant`, { profileId: llm.id })).statusCode, 403, 'kein persönliches Projekt');
  assert.equal((await t.api(pl).post(`/projects/${t.ids.projects.web}/assistant`, { profileId: llm.id })).statusCode, 403, 'normales Projekt');
  const other = (await t.api(admin).post('/ai/profiles', { name: 'Nur Projekte', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'x' })).json().profile;
  let r = await t.api(max).post(`/projects/${maxPid}/assistant`, { profileId: other.id });
  assert.equal(r.statusCode, 400); assert.equal(r.json().error, TEXT.assistantProfileNotReleased);
  assert.equal((await t.api(max).post(`/projects/${maxPid}/assistant`, {})).statusCode, 400);
  const st = (await t.api(max).get(`/projects/${maxPid}/assistant`)).json();
  assert.equal(st.canCreate, true);
  assert.deepEqual(st.blocked, []);
  r = await t.api(max).post(`/projects/${maxPid}/assistant`, { name: 'Jarvis', profileId: llm.id, persona: 'knapp und freundlich' });
  assert.equal(r.statusCode, 200, r.body);
  assistant = r.json().assistant;
  assert.equal(assistant.name, 'Jarvis');
  assert.equal(assistant.aiProfileId, llm.id);
  assert.equal(assistant.dailyBudget, null, 'Tagesbudget aus dem Mandanten');
  assert.ok(assistant.channelId);
  dm = assistant.channelId;
  assert.equal(r.json().canCreate, false);
  const row = await t.db.one(`select * from users where id = $1`, [assistant.id]);
  assert.equal(row.kind, 'agent'); assert.equal(row.agent_role, 'assistant'); assert.equal(row.agent_project_id, maxPid);
  assert.deepEqual(row.agent_rights, (await import('@projekttool/shared')).DEFAULT_AGENT_RIGHTS);
  const m = await t.db.one(`select * from project_members where project_id = $1 and user_id = $2`, [maxPid, assistant.id]);
  assert.equal(m.role, 'pl'); assert.equal(m.is_deputy, true);
  assert.equal((await t.db.one(`select agent_user_id from projects where id = $1`, [maxPid])).agent_user_id, assistant.id, 'Projektagent');
  // nur einer
  r = await t.api(max).post(`/projects/${maxPid}/assistant`, { profileId: llm.id });
  assert.equal(r.statusCode, 409); assert.equal(r.json().error, TEXT.assistantExists);
  // Chat: angepinnt als Assistent
  assert.equal((await t.api(max).get('/chat/assistant')).json().assistant.id, assistant.id);
  // Verwaltung: Rolle sichtbar; die Person pflegt Name und Persona selbst, der Org-Admin nur (de)aktivieren
  assert.equal((await t.api(admin).get('/agents')).json().agents.find((a: any) => a.id === assistant.id).role, 'assistant');
  assert.equal((await t.api(max).patch(`/agents/${assistant.id}`, { name: 'Jarvis 2', persona: 'direkt' })).statusCode, 200);
  assert.equal((await t.api(max).patch(`/agents/${assistant.id}`, { aiProfileId: other.id })).statusCode, 400, 'nicht freigegebenes LLM');
  assert.equal((await t.api(admin).patch(`/agents/${assistant.id}`, { name: 'Fremd' })).statusCode, 403);
  assert.equal((await t.api(admin).patch(`/agents/${assistant.id}`, { active: true })).statusCode, 200);
  await t.api(max).patch(`/agents/${assistant.id}`, { name: 'Jarvis' });
});

test('Assistent getrennt von Projektagenten: nicht in andere Projekte einladbar, kein Projektagent anderswo, Kanal-Erwähnung ignoriert', async () => {
  const pl = await t.login('pl@demo.local');
  let r = await t.api(pl).put(`/projects/${t.ids.projects.web}/members/${assistant.id}`, { role: 'member' });
  assert.equal(r.statusCode, 403); assert.equal(r.json().error, TEXT.assistantBound);
  r = await t.api(pl).put(`/projects/${t.ids.projects.web}/agent`, { agentUserId: assistant.id });
  assert.equal(r.statusCode, 403); assert.equal(r.json().error, TEXT.assistantBound);
  assert.ok(!(await t.api(pl).get(`/projects/${t.ids.projects.web}/agents`)).json().candidates.some((a: any) => a.id === assistant.id), 'kein Kandidat anderswo');
  // Erwähnung im Projektkanal des persönlichen Projekts: keine Antwort, kein Lauf
  const convs = (await t.api(max).get('/chat/conversations')).json().conversations;
  const channel = convs.find((c: any) => c.kind === 'project' && c.projectId === maxPid);
  assert.ok(channel, 'Projektkanal');
  const n = prompts.length;
  assert.equal((await t.api(max).post(`/chat/channels/${channel.channelId}/messages`, { body: '@Jarvis was steht an?' })).statusCode, 200);
  await flushAgentRuns();
  assert.equal(prompts.length, n, 'kein LLM-Aufruf');
  assert.equal((await t.db.one(`select count(*)::int as c from chat_messages where channel_id = $1 and user_id = $2`, [channel.channelId, assistant.id])).c, 0, 'keine Antwort im Kanal');
  assert.equal((await t.db.one(`select count(*)::int as c from agent_runs where agent_user_id = $1`, [assistant.id])).c, 0);
});

test('Direktnachricht an den Assistenten: „persönlich“ ist sicherer Standard ohne Rückfrage; genanntes Projekt → „nicht Mitglied“; Sperre der Person → Grund', async () => {
  const admin = await t.login('admin@demo.local');
  const say = async (body: string) => { const n = prompts.length; const r = await t.api(max).post(`/chat/channels/${dm}/messages`, { body }); assert.equal(r.statusCode, 200, r.body); await flushAgentRuns(); return { calls: prompts.length - n, prompt: prompts.at(-1) ?? '' }; };
  const messages = async () => (await t.api(max).get(`/chat/channels/${dm}/messages`)).json().messages as any[];
  const lastReply = async () => (await messages()).filter((m) => m.userId === assistant.id).at(-1)?.body as string;
  // Statusfrage, die bei einem Projektagenten alle gemeinsamen Projekte meinte: beim Assistenten persönlich, sicher, ohne Hinweis
  let r = await say('Was steht heute an?');
  assert.equal(r.calls, 1);
  assert.match(r.prompt, /Thema: Projekt MK1 „Persönlich – Max Keller“ \(persönliches Projekt des Absenders/);
  assert.match(r.prompt, /Rolle: Du bist hier persönlicher Assistent von Max Keller\./);
  assert.ok(!(await lastReply()).includes('Ich nehme'), 'kein Hinweis auf eine Annahme');
  assert.equal((await messages()).filter((m) => m.kind === 'system' && m.meta?.card === 'choices').length, 0, 'keine Rückfrage');
  let run = await t.db.one(`select * from agent_runs where agent_user_id = $1 and trigger = 'chat' order by created_at desc limit 1`, [assistant.id]);
  assert.equal(run.status, 'ok');
  // Unbestimmte Nachricht, die bei einem Projektagenten eine Rückfrage auslösen könnte: ebenfalls persönlich
  r = await say('Kannst du dich darum kümmern?');
  assert.equal(r.calls, 1);
  assert.match(r.prompt, /persönliches Projekt des Absenders/);
  // Ausdrücklicher Projektbezug: Assistent ist dort nicht Mitglied, bestehende Antwort ohne LLM-Aufruf
  r = await say('Wie weit ist WEB?');
  assert.equal(r.calls, 0);
  assert.match(await lastReply(), /In WEB „Website-Relaunch“ bin ich nicht Mitglied.*als dein Assistent arbeite ich nur in deinem persönlichen Projekt/);
  // Marker „allgemein“ bleibt
  r = await say('Allgemein: Was ist der Unterschied zwischen Brutto und Netto?');
  assert.equal(r.calls, 1);
  assert.match(r.prompt, /Thema: allgemeine Anfrage ohne Projektbezug/);
  // Sperre der Person (G): Grund statt Antwort, kein LLM-Aufruf
  await t.api(admin).patch(`/users/${t.ids.users.max}`, { personalProjectAllowed: false });
  r = await say('Erinnere mich morgen an die Steuer');
  assert.equal(r.calls, 0);
  assert.match(await lastReply(), /Persönliche KI für diese Person gesperrt \(Verwaltung\)/);
  await t.api(admin).patch(`/users/${t.ids.users.max}`, { personalProjectAllowed: true });
  r = await say('Erinnere mich morgen an die Steuer');
  assert.equal(r.calls, 1);
});

test('Mail des Assistenten nur über eigene Konten der Person (ownOnly): zentrale Postfächer „für alle Projekte“ sind im persönlichen Projekt nicht bindbar', async () => {
  const admin = await t.login('admin@demo.local');
  const c = await t.api(admin).post('/mail/accounts', { kind: 'central', name: 'Vertrieb', address: 'vertrieb@demo.local', provider: 'dev' });
  assert.equal(c.statusCode, 200, c.body);
  const r = (await t.api(max).get(`/projects/${maxPid}/mail/accounts`)).json();
  assert.ok(!r.bindable.some((a: any) => a.id === c.json().account.id), 'zentrales Postfach nicht wählbar');
  assert.ok(r.bindable.every((a: any) => (a.managedBy.kind === 'user' && a.managedBy.userId === t.ids.users.max) || (a.managedBy.kind === 'project' && a.managedBy.projectId === maxPid)), JSON.stringify(r.bindable));
  assert.equal((await t.api(max).post(`/mail/accounts/${c.json().account.id}/uses`, { use: 'project', projectId: maxPid })).statusCode, 403);
});
