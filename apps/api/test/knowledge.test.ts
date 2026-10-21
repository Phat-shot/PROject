import test from 'node:test';
import assert from 'node:assert/strict';
import { composeEcho, testApp } from './helpers.js';
import { flushAgentRuns } from '../src/ai/agentEvents.js';
import { runAgentOnTask } from '../src/ai/agent.js';
import { findCandidates, runProjectReviews, search } from '../src/ai/knowledge.js';

/** Lokales LLM: je Aufruf die nächste Antwort aus `queue` (AP-Lauf: actions; Projektdurchlauf: brief + actions). */
let queue: any[] = [];
const prompts: string[] = [];
const systems: string[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const echo = composeEcho(body);
  if (echo) return echo;
  if (String(input) !== 'http://llm.local:8000/v1/chat/completions') return new Response('{}', { status: 404 });
  prompts.push(String(body.messages?.at(-1)?.content ?? ''));
  systems.push(String(body.messages?.[0]?.content ?? ''));
  const next = queue.shift() ?? { actions: [{ type: 'none', reason: 'nichts' }] };
  const content = body.response_format ? JSON.stringify(body.response_format.json_schema.schema.properties.brief ? { brief: next.brief ?? '', actions: next.actions ?? [] } : { note: next.note ?? 'Wissens-Test', actions: next.actions ?? [] }) : 'bereit';
  return new Response(JSON.stringify({ model: 'qwen', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
};
delete process.env.ANTHROPIC_API_KEY;
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());

const web = () => t.ids.projects.web;
let agent: any; let profile: any; let a: any; let b: any; let refB = '';
const agentRow = () => ({ id: agent.id, name: agent.name, org_id: t.ids.org, persona: null });
const col = async (name: string) => (await t.db.one(`select id from board_columns where project_id = $1 and name = $2`, [web(), name])).id;

test('Vorbereitung: Kandidaten ohne Token (Signale terms und contact), Suche nur im Sichtbaren', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  profile = (await t.api(admin).post('/ai/profiles', { name: 'Qwen', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'qwen' })).json().profile;
  await t.api(admin).put('/ai/settings', { agentDailyBudget: 50 });
  agent = (await t.api(admin).post('/agents', { name: 'Wissen' })).json().agent;
  assert.equal((await t.api(pl).put(`/projects/${web()}/members/${agent.id}`, { role: 'member' })).statusCode, 200);
  await t.api(pl).put(`/projects/${web()}/agent-policy`, { mode: 'confirm_critical' });
  const open = await col('Offen');
  a = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Hosting-Angebot Lieferant Nordcloud einholen', description: 'Angebot für Hosting und Backup beim Lieferanten Nordcloud einholen, Vergleich der Tarife.', columnId: open, responsibleUserId: agent.id })).json().task;
  b = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Hosting-Vertrag Nordcloud prüfen', description: 'Vertrag für Hosting und Backup mit Nordcloud prüfen, Tarife und Laufzeit.', columnId: open, responsibleUserId: t.ids.users.max })).json().task;
  refB = `WEB-${b.number}`;
  await flushAgentRuns();
  const cands = await findCandidates(t.db, { projectId: web(), taskId: a.id, agentId: agent.id, max: 3 });
  assert.ok(cands.some((c) => c.taskId === b.id && c.signals.some((s) => s.type === 'terms')), JSON.stringify(cands));
  // Suche: Seite im gesperrten Ordner bleibt unsichtbar
  const folder = await t.db.one(`insert into doc_folders (project_id, name, agent_access) values ($1,'Geheim','none') returning id`, [web()]);
  await t.db.query(`insert into doc_pages (project_id, folder_id, title, content_md, content_html, status, created_by, updated_by) values ($1,$2,'Nordcloud Konditionen intern','# Nordcloud\nRabatt 30 %','<h1>Nordcloud</h1>','draft',$3,$3)`, [web(), folder.id, t.ids.users.pl]);
  await t.db.query(`insert into doc_pages (project_id, folder_id, title, content_md, content_html, status, created_by, updated_by) values ($1,null,'Nordcloud Tarifübersicht','# Tarife\nNordcloud Basic 49 €, Pro 99 €','<h1>Tarife</h1>','final',$2,$2)`, [web(), t.ids.users.pl]);
  const r = await search(t.db, { projectId: web(), agentId: agent.id, query: 'Nordcloud Tarife' });
  assert.ok(r.pages.some((p) => p.title === 'Nordcloud Tarifübersicht' && p.excerpt?.includes('Basic 49')));
  assert.ok(!r.pages.some((p) => p.title.includes('intern')), 'gesperrter Ordner unsichtbar');
  assert.ok(r.tasks.some((x) => x.id === a.id) && r.tasks.some((x) => x.id === b.id));
});

test('AP-Lauf: Überblick im System, Kandidaten und passende Seiten im Prompt, Leserunde search + read_task, relate stellt Frage synergy an die PL, Kontextstatistik', async () => {
  queue = [
    { actions: [{ type: 'search', text: 'Nordcloud Tarife' }, { type: 'read_task', ref: refB }, { type: 'comment', text: 'wird verworfen' }] },
    { actions: [{ type: 'relate', ref: refB, kind: 'related', text: 'gleicher Lieferant, Angebot und Vertrag gehören zusammen' }, { type: 'comment', text: 'Angebot angefragt.' }] }
  ];
  const run = await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow(), a.id, 'manual');
  assert.equal(run.status, 'ok', run.error ?? '');
  assert.deepEqual(run.actions.map((x: any) => x.type), ['relate', 'comment']);
  const p1 = prompts.at(-2)!; const p2 = prompts.at(-1)!;
  assert.ok(systems.at(-1)!.includes('# Projektüberblick'), 'Überblick im Systemteil');
  assert.ok(p1.includes('Mögliche Überschneidungen') && p1.includes(refB), 'Kandidat im Prompt');
  assert.ok(p1.includes('„Nordcloud Tarifübersicht“') && !p1.includes('Konditionen intern'), 'passende Seite, gesperrte nicht');
  assert.ok(p2.includes('### Suche „Nordcloud Tarife“') && p2.includes(`### ${refB} „Hosting-Vertrag Nordcloud prüfen“`), 'Leserunde mit Suche und fremdem AP');
  const rel = await t.db.one(`select * from task_relations where (task_a = $1 or task_b = $1)`, [a.id]);
  assert.equal(rel.status, 'asked'); assert.equal(rel.kind, 'related');
  const q = await t.db.one(`select * from questions where id = $1`, [rel.question_id]);
  assert.equal(q.kind, 'synergy'); assert.equal(q.addressee_id, t.ids.users.pl, 'Agent zuständig → Frage an die PL');
  assert.ok((q.options ?? []).some((o: any) => o.key === 'sync' && /Lead/.test(o.label)));
  const stats = (await t.db.one(`select context_stats from agent_runs where id = $1`, [run.runId])).context_stats;
  assert.ok(stats && stats.limit > 0 && stats.before > 0 && stats.candidates >= 1, JSON.stringify(stats));
  // Sichtbar im TaskDrawer beider APs
  const pl = await t.login('pl@demo.local');
  const rels = (await t.api(pl).get(`/tasks/${b.id}/relations`)).json().relations;
  assert.equal(rels.length, 1); assert.equal(rels[0].other.id, a.id); assert.equal(rels[0].status, 'asked');
  // Nochmal melden: schon offen
  queue = [{ actions: [{ type: 'relate', ref: refB, kind: 'related', text: 'nochmal' }] }];
  const run2 = await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow(), a.id, 'manual');
  assert.match(run2.error ?? '', /schon offen/);
  assert.ok(prompts.at(-1)!.includes('Beziehungen dieses Arbeitspakets'), 'bestehende Beziehung im Prompt');
});

test('Entscheidung: Antwort auf die Frage synergy (sync) legt Querverweise an; Abhängigkeit nur PL/Plan; Leser darf nicht', async () => {
  const pl = await t.login('pl@demo.local');
  const rel = await t.db.one(`select * from task_relations where (task_a = $1 or task_b = $1)`, [a.id]);
  const r = await t.api(pl).post(`/questions/${rel.question_id}/answer`, { option: 'sync' });
  assert.equal(r.statusCode, 200, r.body);
  const after = await t.db.one(`select * from task_relations where id = $1`, [rel.id]);
  assert.equal(after.status, 'accepted'); assert.equal(after.kind, 'sync'); assert.equal(after.decided_by, t.ids.users.pl);
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and body like 'Zusammenhang mit %synchron bearbeiten%'`, [a.id]));
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and body like 'Zusammenhang mit %synchron bearbeiten%'`, [b.id]));
  // Zweite Beziehung (dependency) direkt über die Route
  const open = await col('Offen');
  const c = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'DNS-Umstellung Nordcloud', description: 'DNS nach Hosting-Vertrag umstellen', columnId: open, responsibleUserId: t.ids.users.anna })).json().task;
  await flushAgentRuns();
  queue = [{ actions: [{ type: 'relate', ref: `WEB-${c.number}`, kind: 'dependency', text: 'erst Vertrag, dann DNS' }] }];
  const run = await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow(), a.id, 'manual');
  assert.equal(run.status, 'ok', run.error ?? '');
  const rel2 = await t.db.one(`select * from task_relations where kind = 'dependency' and (task_a = $1 or task_b = $1)`, [c.id]);
  assert.equal(rel2.status, 'asked');
  const leser = await t.login('leser@demo.local');
  assert.equal((await t.api(leser).post(`/relations/${rel2.id}/decide`, { option: 'independent' })).statusCode, 403);
  assert.equal((await t.api(pl).post(`/relations/${rel2.id}/decide`, { option: 'egal' })).statusCode, 400);
  const d = await t.api(pl).post(`/relations/${rel2.id}/decide`, { option: 'dependency', leadTaskId: a.id });
  assert.equal(d.statusCode, 200, d.body);
  assert.equal(d.json().relation.status, 'accepted');
  assert.ok(await t.db.maybeOne(`select 1 from task_dependencies where predecessor_id = $1 and successor_id = $2`, [a.id, c.id]), 'Abhängigkeit gesetzt');
  assert.equal((await t.db.one(`select status from questions where id = $1`, [rel2.question_id])).status, 'cancelled');
  assert.equal((await t.api(pl).post(`/relations/${rel2.id}/decide`, { option: 'independent' })).statusCode, 400, 'schon entschieden');
});

test('Policy synergies: off blendet Kandidaten aus und verwirft relate; use (nur Selbstständig) vermerkt Querverweise ohne Frage; withdraw zieht zurück', async () => {
  const pl = await t.login('pl@demo.local');
  const open = await col('Offen');
  const d = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Backup-Konzept Nordcloud', description: 'Backup und Hosting Nordcloud Tarife', columnId: open, responsibleUserId: t.ids.users.max })).json().task;
  const refD = `WEB-${d.number}`;
  await flushAgentRuns();
  assert.equal((await t.api(pl).put(`/projects/${web()}/agent-policy`, { mode: 'confirm_critical', synergies: 'off' })).statusCode, 200);
  let e = (await t.api(pl).get(`/projects/${web()}/agent-policy?agentId=${agent.id}`)).json().effective;
  assert.equal(e.synergies, 'off');
  queue = [{ actions: [{ type: 'relate', ref: refD, kind: 'related', text: 'x' }] }];
  let run = await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow(), a.id, 'manual');
  assert.match(run.error ?? '', /Überschneidungen sind in der Agenten-Policy aus/);
  assert.ok(!prompts.at(-1)!.includes('Mögliche Überschneidungen'), 'keine Kandidaten');
  // use ohne auto → ask
  assert.equal((await t.api(pl).put(`/projects/${web()}/agent-policy`, { mode: 'confirm_critical', synergies: 'use' })).statusCode, 200);
  e = (await t.api(pl).get(`/projects/${web()}/agent-policy?agentId=${agent.id}`)).json().effective;
  assert.equal(e.synergies, 'ask'); assert.match(e.origin.synergies, /nutzen nur bei Selbstständig/);
  assert.equal((await t.api(pl).put(`/projects/${web()}/agent-policy`, { mode: 'auto', synergies: 'use' })).statusCode, 200);
  e = (await t.api(pl).get(`/projects/${web()}/agent-policy?agentId=${agent.id}`)).json().effective;
  assert.equal(e.synergies, 'use');
  queue = [{ actions: [{ type: 'relate', ref: refD, kind: 'related', text: 'gleiche Tarife' }] }];
  run = await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow(), a.id, 'manual');
  assert.equal(run.status, 'ok', run.error ?? '');
  const rel = await t.db.one(`select * from task_relations where (task_a = $1 or task_b = $1) and (task_a = $2 or task_b = $2)`, [a.id, d.id]);
  assert.equal(rel.status, 'accepted'); assert.equal(rel.question_id, null);
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and body like 'Zusammenhang mit %Querverweis (Wissen): gleiche Tarife%'`, [d.id]));
  // withdraw: nur eigene offene Beziehungen
  queue = [{ actions: [{ type: 'withdraw', ref: refD }] }];
  run = await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow(), a.id, 'manual');
  assert.match(run.error ?? '', /keine eigene offene Beziehung/);
  const e2 = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Nordcloud Rechnung prüfen', description: 'Rechnung Hosting Nordcloud', columnId: open, responsibleUserId: t.ids.users.max })).json().task;
  await flushAgentRuns();
  await t.api(pl).put(`/projects/${web()}/agent-policy`, { mode: 'confirm_critical' });
  queue = [{ actions: [{ type: 'relate', ref: `WEB-${e2.number}`, kind: 'related', text: 'Rechnung zum Angebot' }] }];
  run = await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow(), a.id, 'manual');
  assert.equal(run.status, 'ok', run.error ?? '');
  const open1 = await t.db.one(`select * from task_relations where (task_a = $1 or task_b = $1) and (task_a = $2 or task_b = $2)`, [a.id, e2.id]);
  assert.equal(open1.status, 'asked');
  queue = [{ actions: [{ type: 'withdraw', ref: `WEB-${e2.number}` }, { type: 'comment', text: 'zurückgezogen' }] }];
  run = await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow(), a.id, 'manual');
  assert.equal(run.status, 'ok', run.error ?? '');
  assert.equal(await t.db.maybeOne(`select 1 from task_relations where id = $1`, [open1.id]), null);
  assert.equal((await t.db.one(`select status from questions where id = $1`, [open1.question_id])).status, 'cancelled');
});

test('Kontextbudget: kleines Kontextfenster kürzt in fester Reihenfolge, das eigene AP bleibt; Leserunden höchstens sechs Zugriffe', async () => {
  const admin = await t.login('admin@demo.local');
  assert.equal((await t.api(admin).patch(`/ai/profiles/${profile.id}`, { contextTokens: 3999 })).statusCode, 400);
  assert.equal((await t.api(admin).patch(`/ai/profiles/${profile.id}`, { contextTokens: 4000 })).statusCode, 200);
  assert.equal((await t.api(admin).get('/ai/status')).json().profiles.find((p: any) => p.id === profile.id).contextTokens, 4000);
  const long = 'Langer Logeintrag zum Angebot mit vielen Details zu Tarifen, Laufzeiten, Kündigungsfristen und Ansprechpartnern. '.repeat(4);
  for (let i = 0; i < 12; i++) await t.db.query(`insert into task_comments (task_id, user_id, body) values ($1,$2,$3)`, [a.id, t.ids.users.pl, `${i}: ${long}`]);
  queue = [{ actions: [{ type: 'read_task', ref: refB }, { type: 'read_task', ref: refB }, { type: 'read_task', ref: refB }, { type: 'read_task', ref: refB }, { type: 'read_task', ref: refB }, { type: 'read_task', ref: refB }, { type: 'search', text: 'Nordcloud' }] }, { actions: [{ type: 'none', reason: 'genug gelesen' }] }];
  const run = await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow(), a.id, 'manual');
  assert.equal(run.status, 'ok', run.error ?? '');
  const stats = (await t.db.one(`select context_stats from agent_runs where id = $1`, [run.runId])).context_stats;
  assert.equal(stats.limit, 3000); assert.equal(stats.contextTokens, 4000);
  assert.ok(stats.after < stats.before && Object.keys(stats.trimmed).length > 0, JSON.stringify(stats));
  assert.ok(prompts.at(-1)!.includes(`Arbeitspaket WEB-${a.number} „Hosting-Angebot Lieferant Nordcloud einholen“`) && prompts.at(-1)!.includes('Vergleich der Tarife'), 'eigenes AP vollständig');
  assert.match(prompts.at(-1)!, /Zugriffslimit erreicht \(6 je Lauf\)/);
  await t.api(admin).patch(`/ai/profiles/${profile.id}`, { contextTokens: null });
});

test('Projektdurchlauf: nur mit Projektagent und Reichweite „ganzes Projekt“; Steckbrief, Hinweis, relate zwischen fremden APs; Worker werktags einmal täglich', async () => {
  const pl = await t.login('pl@demo.local');
  const admin = await t.login('admin@demo.local');
  assert.equal((await t.api(pl).post(`/projects/${web()}/agent-review`)).statusCode, 400, 'kein Projektagent');
  assert.equal((await t.api(pl).put(`/projects/${web()}/agent`, { agentUserId: agent.id, agentMail: 'off' })).statusCode, 200);
  assert.equal((await t.api(pl).post(`/projects/${web()}/agent-review`)).statusCode, 400, 'Reichweite task');
  assert.equal((await t.api(pl).put(`/projects/${web()}/agent-policy`, { mode: 'confirm_critical', scope: 'project' })).statusCode, 200);
  const refA = `WEB-${a.number}`;
  queue = [{ brief: 'Relaunch der Website mit Hosting bei Nordcloud; offen: Vertrag und DNS.', actions: [{ type: 'note', ref: refA, text: 'Angebot und Vertrag laufen parallel.' }, { type: 'relate', ref: refB, ref2: `WEB-${b.number}`, kind: 'duplicate', text: 'gleich' }, { type: 'ask', ref: refA, text: 'Soll Nordcloud gesetzt sein?' }] }];
  const r = await t.api(pl).post(`/projects/${web()}/agent-review`);
  assert.equal(r.statusCode, 200, r.body);
  const run = r.json().run;
  assert.equal(run.status, 'error', 'relate mit gleichem AP meldet Fehler, der Rest läuft');
  assert.match(run.error, /gleiches Arbeitspaket/);
  assert.deepEqual(run.actions.map((x: any) => x.type), ['brief', 'note', 'ask']);
  assert.ok(systems.at(-1)!.includes('# Projektdurchlauf'), 'PROJECT_RULES');
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and body like 'Hinweis aus dem Projektdurchlauf:%'`, [a.id]));
  assert.ok(await t.db.maybeOne(`select 1 from questions where task_id = $1 and asked_by = $2 and body = 'Soll Nordcloud gesetzt sein?' and addressee_id = $3`, [a.id, agent.id, t.ids.users.pl]));
  const dg = (await t.api(pl).get(`/projects/${web()}/digest`)).json().digest;
  assert.equal(dg.brief, 'Relaunch der Website mit Hosting bei Nordcloud; offen: Vertrag und DNS.'); assert.equal(dg.scope, 'project'); assert.equal(dg.reviewAt, '06:45');
  assert.ok(dg.structure.includes('Arbeitspakete je Status') && dg.structure.includes('Projekt WEB'));
  const runs = (await t.api(pl).get(`/projects/${web()}/agent-runs`)).json().runs;
  assert.ok(runs.some((x: any) => x.scope === 'project' && x.trigger === 'project_review' && x.taskId === null));
  // AP-Lauf danach sieht den Steckbrief im Überblick
  queue = [{ actions: [{ type: 'none', reason: 'nur Kontext' }] }];
  await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow(), a.id, 'manual');
  assert.ok(systems.at(-1)!.includes('Steckbrief (vom Projektagenten):\nRelaunch der Website'));
  // Worker: Werktag nach reviewAt → ein Durchlauf (unverändert → übersprungen ohne LLM), danach heute nichts mehr; Wochenende nichts
  await t.db.query(`delete from agent_runs where scope = 'project'`);
  await t.api(pl).get(`/projects/${web()}/digest`); // Quell-Hash auf den aktuellen Stand
  const before = prompts.length;
  assert.equal(await runProjectReviews(t.db, t.mail, fakeFetch, new Date('2026-10-16T12:00:00Z')), 1, 'Freitag mittags');
  assert.equal(prompts.length, before, 'Quell-Hash unverändert: kein LLM-Aufruf');
  assert.equal((await t.db.one(`select status, error from agent_runs where scope = 'project' order by created_at desc limit 1`)).status, 'skipped');
  assert.equal(await runProjectReviews(t.db, t.mail, fakeFetch, new Date('2026-10-16T12:00:00Z')), 0, 'heute schon gelaufen');
  await t.db.query(`delete from agent_runs where scope = 'project'`);
  assert.equal(await runProjectReviews(t.db, t.mail, fakeFetch, new Date('2026-10-17T12:00:00Z')), 0, 'Samstag');
  assert.equal(await runProjectReviews(t.db, t.mail, fakeFetch, new Date('2026-10-16T04:00:00Z')), 0, 'vor 06:45');
  // Uhrzeit des Projektdurchlaufs setzt die PL am Projekt
  const projPolicy = (await t.api(pl).get(`/projects/${web()}/agent-policy`)).json().project;
  assert.equal((await t.api(pl).put(`/projects/${web()}/agent-policy`, { ...projPolicy, reviewAt: '09:00' })).statusCode, 200);
  assert.equal((await t.api(pl).get(`/projects/${web()}/digest`)).json().digest.reviewAt, '09:00');
  assert.equal(await runProjectReviews(t.db, t.mail, fakeFetch, new Date('2026-10-16T06:00:00Z')), 0, '08:00 Berlin, vor 09:00');
  await t.api(pl).put(`/projects/${web()}/agent-policy`, projPolicy);
});
