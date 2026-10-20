import test from 'node:test';
import assert from 'node:assert/strict';
import { composeEcho, testApp } from './helpers.js';
import { flushAgentRuns } from '../src/ai/agentEvents.js';
import { runAgentOnTask } from '../src/ai/agent.js';
import { filterQuery, inWindow, nextWindowStart, safeUrl } from '../src/ai/web.js';
import { runScheduledMails } from '../src/ai/scheduledMail.js';

/** Lokales LLM (Runden: erst research, dann doc_create), SearXNG und zwei Webseiten gefälscht; Anthropic mit web_search-Blöcken. */
let rounds: any[][] = [];
const prompts: string[] = [];
const searxCalls: string[] = [];
const fetched: string[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const echo = composeEcho(body);
  if (echo) return echo;
  if (url === 'http://llm.local:8000/v1/chat/completions') {
    prompts.push(String(body.messages?.at(-1)?.content ?? ''));
    const actions = rounds.length ? rounds.shift() : [{ type: 'none', reason: 'Test' }];
    const content = body.response_format ? JSON.stringify({ note: 'Recherche-Test', actions }) : 'bereit';
    return new Response(JSON.stringify({ model: 'qwen', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
  }
  if (url.startsWith('http://searx.local/search')) {
    searxCalls.push(url);
    return new Response(JSON.stringify({ results: [
      { url: 'http://pages.example/elektro-a', title: 'Elektro A GmbH', content: 'Elektroinstallation im Edertal' },
      { url: 'http://127.0.0.1:8080/admin', title: 'Intern', content: 'darf nicht abgerufen werden' },
      { url: 'http://pages.example/elektro-b', title: 'Elektro B', content: 'Meisterbetrieb' }
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.startsWith('http://pages.example/')) { fetched.push(url); return new Response('<html><head><title>x</title><script>alert(1)</script></head><body><h1>Elektro A GmbH</h1><p>Wir installieren im Edertal seit 1990.</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } }); }
  if (url.startsWith('http://127.0.0.1')) { fetched.push(url); return new Response('intern', { status: 200, headers: { 'content-type': 'text/html' } }); }
  if (url.startsWith('https://api.anthropic.com/v1/messages')) {
    const content = [
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'Elektriker Edertal' } },
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://www.elektro-c.de/', title: 'Elektro C', encrypted_content: 'x', page_age: null }] },
      { type: 'text', text: 'Elektro C ist ein Meisterbetrieb im Edertal.', citations: [{ type: 'web_search_result_location', url: 'https://www.elektro-c.de/', title: 'Elektro C', cited_text: 'Meisterbetrieb seit 1985', encrypted_index: 'y' }] }
    ];
    return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content, stop_reason: 'end_turn', usage: { input_tokens: 50, output_tokens: 30, server_tool_use: { web_search_requests: 1 } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 404 });
};
delete process.env.ANTHROPIC_API_KEY;
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());

const web = () => t.ids.projects.web;
let agent: any; let profile: any; let task: any;
const agentRow = () => ({ id: agent.id, name: agent.name, org_id: t.ids.org, persona: null });

test('Hilfsfunktionen: Suchbegriffe ohne Adressen und Namen, nur öffentliche URLs, Arbeitszeitfenster', () => {
  assert.equal(filterQuery('Elektriker Edertal max.keller@demo.local Tel. 0561 123456 Petra Lenz Angebot', ['Petra Lenz', 'Max Keller']), 'Elektriker Edertal Tel. Angebot');
  assert.equal(safeUrl('http://127.0.0.1/x'), null); assert.equal(safeUrl('http://10.1.2.3/'), null); assert.equal(safeUrl('http://localhost:3000/'), null); assert.equal(safeUrl('ftp://a.de/'), null); assert.equal(safeUrl('http://user:pw@a.de/'), null);
  assert.ok(safeUrl('https://www.elektro-c.de/kontakt'));
  const w = { enabled: true, days: [1, 2, 3, 4, 5], from: '07:00', to: '19:00' };
  assert.equal(inWindow(w, new Date('2026-10-18T10:00:00Z')), false, 'Sonntag');
  assert.equal(inWindow(w, new Date('2026-10-19T08:00:00Z')), true, 'Montag 10:00 Berlin');
  assert.equal(inWindow(w, new Date('2026-10-19T17:30:00Z')), false, 'Montag 19:30 Berlin');
  assert.equal(nextWindowStart(w, new Date('2026-10-18T10:00:00Z')).toISOString(), '2026-10-19T05:00:00.000Z', 'Montag 07:00 Berlin (Sommerzeit)');
  assert.equal(nextWindowStart(w, new Date('2026-10-19T17:30:00Z')).toISOString(), '2026-10-20T05:00:00.000Z');
  assert.equal(inWindow({ ...w, enabled: false }, new Date('2026-10-18T10:00:00Z')), true);
});

test('Gesperrt (agent.web Standard): Recherche nicht möglich, Begründung im Prompt und im Lauf; Freigabe über Regel, Profil und Suchdienst', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  profile = (await t.api(admin).post('/ai/profiles', { name: 'Qwen', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'qwen' })).json().profile;
  await t.api(admin).put('/ai/settings', { defaultProfileId: profile.id, agentDailyBudget: 50 });
  agent = (await t.api(admin).post('/agents', { name: 'Rechercheur' })).json().agent;
  await t.api(pl).put(`/projects/${web()}/members/${agent.id}`, { role: 'pl', agentCanMail: true, canFinalize: true });
  await t.api(pl).put(`/projects/${web()}/agent-policy`, { mode: 'auto' });
  const r = await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Elektriker recherchieren', columnId: (await t.db.one(`select id from board_columns where project_id = $1 and name = 'Offen'`, [web()])).id, responsibleUserId: agent.id });
  task = r.json().task;
  await flushAgentRuns();
  rounds = [[{ type: 'research', text: 'Elektriker Edertal' }]];
  let run = await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow(), task.id, 'manual');
  assert.match(prompts.at(-2) ?? '', /Online-Recherche: nein \(Standard: gesperrt, bis die Verwaltung „Online-Recherche“ freigibt/);
  assert.match(run.error ?? '', /research: Standard: gesperrt/);
  assert.match(prompts.at(-1) ?? '', /Recherche „Elektriker Edertal“: nicht möglich/);
  // Regel erlaubt, Profil noch ohne Recherche
  assert.equal((await t.api(admin).put('/ai/policies', { projectId: null, userId: agent.id, groupId: null, note: null, feature: 'agent.web', effect: 'allow' })).statusCode, 200);
  rounds = [[{ type: 'research', text: 'Elektriker Edertal' }]];
  run = await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow(), task.id, 'manual');
  assert.match(run.error ?? '', /Profil Qwen ohne Online-Recherche/);
  assert.equal((await t.api(admin).patch(`/ai/profiles/${profile.id}`, { webSearch: true })).statusCode, 200);
  assert.equal((await t.api(admin).get('/ai/status')).json().profiles.find((p: any) => p.id === profile.id).webSearch, true);
  rounds = [[{ type: 'research', text: 'Elektriker Edertal' }]];
  run = await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow(), task.id, 'manual');
  assert.match(run.error ?? '', /kein Suchdienst für lokale Profile/);
  assert.equal((await t.api(pl).put('/ai/settings', { web: { provider: 'searxng', url: 'http://searx.local/' } })).statusCode, 403, 'nur KI-Verwaltung');
  assert.equal((await t.api(admin).put('/ai/settings', { web: { provider: 'searxng', url: 'http://searx.local/', maxPerRun: 2, dailyPerAgent: 3, blockedDomains: ['facebook.com'] } })).statusCode, 200);
  const st = (await t.api(admin).get('/ai/status')).json();
  assert.equal(st.web.provider, 'searxng'); assert.equal(st.web.url, 'http://searx.local'); assert.deepEqual(st.web.blockedDomains, ['facebook.com']);
  assert.equal((await t.api(admin).put('/ai/settings', { web: { allowedDomains: ['a.de'], blockedDomains: ['b.de'] } })).statusCode, 400);
});

test('Lokales Profil mit SearXNG: Suche, Seitenabruf (nur öffentliche URLs), Leserunde mit Quellen, Seite bekommt den Abschnitt „Quellen“, Zähler und Tagesbudget', async () => {
  const pl = await t.login('pl@demo.local');
  rounds = [
    [{ type: 'research', text: 'Elektriker Edertal max.keller@demo.local Petra Lenz' }],
    [{ type: 'doc_create', title: 'Elektriker Edertal', folder: 'Protokolle', text: '# Elektriker im Edertal\n\n- Elektro A GmbH [1]\n- Elektro B [3]' }]
  ];
  const run = await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow(), task.id, 'manual');
  assert.equal(run.status, 'ok', run.error ?? '');
  assert.ok(prompts.at(-2)?.includes('Online-Recherche: ja (research; bis zu 2 Suchen je Lauf, heute noch 3'), 'Fähigkeit im Prompt');
  assert.equal(searxCalls.length, 1);
  assert.ok(!decodeURIComponent(searxCalls[0]).includes('max.keller') && !decodeURIComponent(searxCalls[0]).includes('Petra'), 'Suchbegriffe gefiltert');
  assert.ok(fetched.every((u) => !u.startsWith('http://127.0.0.1')), 'private Adresse nicht abgerufen');
  assert.ok(fetched.some((u) => u === 'http://pages.example/elektro-a'));
  const p2 = prompts.at(-1) ?? '';
  assert.match(p2, /Recherche „Elektriker Edertal“ \(1 Suche\)/);
  assert.match(p2, /\[1\] Elektro A GmbH – http:\/\/pages.example\/elektro-a/);
  assert.ok(p2.includes('Wir installieren im Edertal seit 1990.') && !p2.includes('alert(1)'), 'Textauszug ohne Skript');
  assert.ok(!p2.includes('127.0.0.1'), 'gesperrter Treffer fehlt');
  const sources = (await t.db.query(`select * from agent_web_sources where task_id = $1 order by retrieved_at`, [task.id])).rows;
  assert.equal(sources.length, 2);
  assert.equal(sources[0].run_id, run.runId); assert.equal(sources[0].query, 'Elektriker Edertal');
  const page = await t.db.one(`select * from doc_pages where title = 'Elektriker Edertal'`);
  assert.match(page.content_md, /## Quellen \(abgerufen am \d{1,2}\.\d{1,2}\.\d{4}\)/);
  assert.match(page.content_md, /\[Elektro A GmbH\]\(http:\/\/pages.example\/elektro-a\)/);
  assert.equal(sources[0].page_id, page.id);
  assert.equal((await t.db.one(`select web_searches from agent_runs where id = $1`, [run.runId])).web_searches, 1);
  const src = (await t.api(pl).get(`/tasks/${task.id}/web-sources`)).json().sources;
  assert.equal(src.length, 2);
  // Tagesbudget 3: zwei weitere Suchen, dann gesperrt
  rounds = [[{ type: 'research', text: 'Elektriker Fritzlar' }, { type: 'research', text: 'Elektriker Korbach' }], [{ type: 'none', reason: 'ok' }]];
  await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow(), task.id, 'manual');
  rounds = [[{ type: 'research', text: 'noch eine' }]];
  const r3 = await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow(), task.id, 'manual');
  assert.match(r3.error ?? '', /Tagesbudget der Recherche für Rechercheur erreicht \(3 Suchen\)/);
});

test('Anthropic-Profil: Server-Tool web_search, Zitate werden Quellen', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const anth = (await t.api(admin).post('/ai/profiles', { name: 'Claude', provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'sk-test', webSearch: true })).json().profile;
  await t.api(admin).put('/ai/settings', { web: { dailyPerAgent: 50 } });
  const { research, webSettings } = await import('../src/ai/web.js');
  const cfg = { profileId: anth.id, name: 'Claude', provider: 'anthropic' as const, apiKey: 'sk-test', model: 'claude-sonnet-4-6', baseUrl: null };
  const r = await research(t.db, cfg, fakeFetch, { question: 'Elektriker Edertal', settings: await webSettings(t.db, t.ids.org), names: [] });
  assert.equal(r.error, undefined);
  assert.equal(r.searches, 1);
  assert.match(r.text, /Elektro C ist ein Meisterbetrieb/);
  assert.equal(r.sources.length, 1); assert.equal(r.sources[0].url, 'https://www.elektro-c.de/'); assert.equal(r.sources[0].citedText, 'Meisterbetrieb seit 1985');
  void pl;
});

test('Arbeitszeitfenster: Mail nach außen am Sonntag wird für Montag 07:00 geplant und vom Worker gesendet', async () => {
  const admin = await t.login('admin@demo.local');
  assert.equal((await t.api(admin).put('/ai/settings', { externalWindow: { enabled: true, days: [1, 2, 3, 4, 5], from: '07:00', to: '19:00' } })).statusCode, 200);
  assert.equal((await t.api(admin).put('/ai/settings', { externalWindow: { enabled: true, days: [1], from: '19:00', to: '07:00' } })).statusCode, 400);
  const sunday = new Date('2026-10-18T10:00:00Z');
  rounds = [[{ type: 'mail', to: ['admin@demo.local'], subject: 'Anfrage Sonntag', text: 'Guten Tag,\n\nbitte ein Angebot.\n\nRechercheur (KI-Agent, Projekt WEB)' }]];
  const run = await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow(), task.id, 'manual', sunday);
  assert.equal(run.status, 'ok', run.error ?? '');
  const d = await t.db.one(`select * from mail_drafts where subject = 'Anfrage Sonntag'`);
  assert.equal(d.status, 'scheduled');
  assert.equal(new Date(d.send_at).toISOString(), '2026-10-19T05:00:00.000Z');
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and body like 'Mail an admin@demo.local wartet auf das Arbeitszeitfenster (Mo, Di, Mi, Do, Fr 07:00–19:00)%'`, [task.id]));
  assert.equal(t.mail.dev.sent.filter((m: any) => m.msg.subject === 'Anfrage Sonntag').length, 0);
  assert.equal(await runScheduledMails(t.db, t.mail, new Date('2026-10-19T04:00:00Z')), 0, 'noch nicht fällig');
  assert.equal(await runScheduledMails(t.db, t.mail, new Date('2026-10-19T05:01:00Z')), 1);
  assert.equal(t.mail.dev.sent.filter((m: any) => m.msg.subject === 'Anfrage Sonntag').length, 1);
  assert.equal((await t.db.one(`select status from mail_drafts where id = $1`, [d.id])).status, 'sent');
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and body like 'Geplante Mail gesendet an admin@demo.local%'`, [task.id]));
  // Im Fenster geht die Mail direkt
  rounds = [[{ type: 'mail', to: ['admin@demo.local'], subject: 'Anfrage Montag', text: 'Guten Tag,\n\nnoch eine Frage.\n\nRechercheur (KI-Agent, Projekt WEB)' }]];
  await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow(), task.id, 'manual', new Date('2026-10-19T08:00:00Z'));
  assert.equal(t.mail.dev.sent.filter((m: any) => m.msg.subject === 'Anfrage Montag').length, 1);
  await t.api(admin).put('/ai/settings', { externalWindow: { enabled: false, days: [1, 2, 3, 4, 5], from: '07:00', to: '19:00' } });
});
