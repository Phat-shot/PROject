import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { flushAgentRuns } from '../src/ai/agentEvents.js';
import { berlinWeek, claimCheck } from '../src/ai/agentChat.js';

/** Lokales LLM: Chat-Läufe (erkennbar am System-Prompt) bekommen reply/notes, Arbeitspaket-Läufe keine Aktion. */
const prompts: string[] = [];
let lastChatBody: any = null;
let nextNotes: { taskId: string; text: string }[] = [];
let nextReply: string | null = null;
/** Solange gesetzt, wartet ein Chat-Lauf nach dem Prompt auf die Freigabe (Lauf „läuft gerade“). */
let gate: Promise<void> | null = null;
const fakeFetch: typeof fetch = async (input, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (String(input) !== 'http://llm.local:8000/v1/chat/completions') return new Response('{}', { status: 404 });
  const system = body.messages?.[0]?.content ?? '';
  const user = body.messages?.[1]?.content ?? '';
  let content = 'bereit';
  if (body.response_format && system.includes('Man erreicht dich im Chat')) {
    prompts.push(user);
    lastChatBody = body;
    if (gate) await gate;
    content = JSON.stringify({ reply: nextReply ?? 'Das Angebot liegt vor, ich kläre die Lizenzen.', notes: nextNotes });
    nextNotes = [];
    nextReply = null;
  } else if (body.response_format) content = JSON.stringify({ note: 'nichts zu tun', actions: [{ type: 'none', reason: 'Test' }] });
  return new Response(JSON.stringify({ model: 'qwen3', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { status: 200 });
};
delete process.env.ANTHROPIC_API_KEY;
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());

test('KI-Agent im Chat: Direktnachricht, Erwähnung im Projektkanal mit Thread, Log-Eintrag am Arbeitspaket, nur sichtbare Arbeitspakete', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const web = t.ids.projects.web;
  const profile = (await t.api(admin).post('/ai/profiles', { name: 'Qwen', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'qwen3' })).json().profile;
  await t.api(admin).put('/ai/settings', { agentDailyBudget: 50 });
  const agent = (await t.api(admin).post('/agents', { name: 'Chatty' })).json().agent;
  assert.equal((await t.api(pl).put(`/projects/${web}/members/${agent.id}`, { role: 'member', agentCanMail: false })).statusCode, 200);
  assert.equal((await t.api(pl).patch(`/tasks/${t.ids.tasks.t4}`, { responsibleUserId: agent.id })).statusCode, 200);
  const secret = await t.db.one(`select id from tasks where title = 'Agenturvertrag verhandeln'`);
  assert.equal((await t.api(pl).patch(`/tasks/${secret.id}`, { responsibleUserId: agent.id })).statusCode, 200);
  await flushAgentRuns();

  // Agent ist als Gesprächspartner wählbar
  const people = (await t.api(max).get('/chat/people')).json().people;
  assert.equal(people.find((p: any) => p.id === agent.id)?.kind, 'agent');

  // Direktnachricht: Agent antwortet, sieht nur, was Max sehen darf, hält Information am Arbeitspaket fest
  const dm = await t.api(max).post('/chat/dm', { userId: agent.id });
  assert.equal(dm.statusCode, 200, dm.body);
  const cid = dm.json().channelId;
  nextNotes = [{ taskId: t.ids.tasks.t4, text: 'Max: Lizenzfrage ist mit dem Einkauf geklärt.' }, { taskId: secret.id, text: 'darf nicht ankommen' }];
  assert.equal((await t.api(max).post(`/chat/channels/${cid}/messages`, { body: 'Stand zum Angebot? Lizenzfrage ist geklärt.' })).statusCode, 200);
  await flushAgentRuns();
  const p1 = prompts.at(-1)!;
  assert.ok(p1.includes('Angebot Agentur'), 'eigenes Arbeitspaket im Kontext');
  assert.ok(!p1.includes('Agenturvertrag'), 'eingeschränktes Teilprojekt bleibt draußen');
  assert.ok(p1.includes('Stand zum Angebot?'));
  const msgs = (await t.api(max).get(`/chat/channels/${cid}/messages`)).json().messages;
  assert.equal(msgs.at(-1).userId, agent.id);
  assert.equal(msgs.at(-1).body, 'Das Angebot liegt vor, ich kläre die Lizenzen.');
  const log = await t.db.query(`select body from task_comments where task_id = $1 and user_id = $2 and body like 'Aus dem Chat%'`, [t.ids.tasks.t4, agent.id]);
  assert.equal(log.rows.length, 1);
  assert.match(log.rows[0].body, /Max Keller.*Lizenzfrage/);
  assert.equal((await t.db.one(`select count(*)::int as n from task_comments where task_id = $1 and body like 'Aus dem Chat%'`, [secret.id])).n, 0, 'nur Arbeitspakete aus dem Kontext');
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'chat.dm' and link = $2`, [t.ids.users.max, `/chat/${cid}`]));
  const run = await t.db.one(`select * from agent_runs where agent_user_id = $1 and trigger = 'chat' order by created_at desc limit 1`, [agent.id]);
  assert.equal(run.channel_id, cid);
  assert.equal(run.project_id, null);

  // Projektkanal: Erwähnung → Antwort im Thread; Folgeantwort im Thread ohne Erwähnung → Agent antwortet wieder
  const ch = (await t.api(pl).get(`/projects/${web}/chat`)).json().channel.id;
  const m = (await t.api(pl).post(`/chat/channels/${ch}/messages`, { body: '@Chatty wie ist der Stand?' })).json().message;
  await flushAgentRuns();
  const thread = (await t.api(pl).get(`/chat/channels/${ch}/messages?thread=${m.id}`)).json().messages;
  assert.equal(thread.length, 1);
  assert.equal(thread[0].userId, agent.id);
  assert.ok(!prompts.at(-1)!.includes('Agenturvertrag'), 'im Projektkanal keine eingeschränkten Teilprojekte, auch nicht für die PL');
  await t.api(pl).post(`/chat/channels/${ch}/messages`, { body: 'Danke, und bis wann?', threadId: m.id });
  await flushAgentRuns();
  assert.equal((await t.api(pl).get(`/chat/channels/${ch}/messages?thread=${m.id}`)).json().messages.filter((x: any) => x.userId === agent.id).length, 2);
  // Ohne Erwähnung im Kanal bleibt der Agent still
  const before = prompts.length;
  await t.api(pl).post(`/chat/channels/${ch}/messages`, { body: 'Allgemeine Info an alle.' });
  await flushAgentRuns();
  assert.equal(prompts.length, before);
});

test('Messenger: Gesprächsliste mit Projektkanälen und Direktnachrichten, Suche über Nachrichten mit Rechten', async () => {
  const max = await t.login('max@demo.local');
  const leser = await t.login('leser@demo.local');
  const convs = (await t.api(max).get('/chat/conversations')).json().conversations;
  const web = convs.find((c: any) => c.kind === 'project' && c.projectId === t.ids.projects.web);
  assert.ok(web, 'Projektkanal WEB');
  assert.equal(web.projectKey, 'WEB');
  assert.ok(convs.some((c: any) => c.kind === 'project' && c.projectId === t.ids.projects.erp), 'ERP-Kanal wird angelegt, auch ohne Nachrichten');
  const dm = convs.find((c: any) => c.kind === 'dm' && c.partner.kind === 'agent');
  assert.equal(dm.title, 'Chatty');
  assert.ok(web.unread >= 1, 'Nachrichten der PL im Kanal ungelesen');
  assert.ok(convs.indexOf(dm) < convs.findIndex((c: any) => c.projectId === t.ids.projects.erp), 'nach letzter Aktivität');
  const hits = (await t.api(max).get('/chat/search?q=Lizenzfrage')).json().messages;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, 'Chatty');
  assert.equal((await t.api(leser).get('/chat/search?q=Lizenzfrage')).json().messages.length, 0, 'fremde Direktnachrichten nicht');
  assert.equal((await t.api(leser).get('/chat/search?q=Allgemeine')).json().messages.length, 1, 'Projektkanal für Mitglieder');
  assert.equal((await t.api(max).get('/chat/search?q=%25')).json().messages.length, 0, 'Platzhalter werden maskiert');
});

test('Nachrichten während eines Chat-Laufs gehen nicht verloren: genau ein Folgelauf, der den Verlauf neu liest', async () => {
  const max = await t.login('max@demo.local');
  const agent = await t.db.one(`select id from users where name = 'Chatty' and kind = 'agent'`);
  const cid = (await t.api(max).post('/chat/dm', { userId: agent.id })).json().channelId;
  const replies = async () => (await t.api(max).get(`/chat/channels/${cid}/messages`)).json().messages.filter((m: any) => m.userId === agent.id).length;
  const r0 = await replies();
  let release!: () => void;
  gate = new Promise<void>((r) => { release = r; });
  const n0 = prompts.length;
  await t.api(max).post(`/chat/channels/${cid}/messages`, { body: 'Erste Frage: Wann kommt das Angebot?' });
  // Der Lauf hat begonnen und wartet auf das Modell; jetzt kommen zwei weitere Nachrichten
  for (let i = 0; i < 400 && prompts.length === n0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(prompts.length, n0 + 1, 'erster Lauf läuft');
  await t.api(max).post(`/chat/channels/${cid}/messages`, { body: 'Zweite Frage: Wer prüft es?' });
  await t.api(max).post(`/chat/channels/${cid}/messages`, { body: 'Dritte Frage: Bis wann?' });
  gate = null;
  release();
  await flushAgentRuns();
  assert.equal(prompts.length, n0 + 2, 'genau ein Folgelauf für beide Nachrichten');
  assert.ok(!prompts[n0].includes('Zweite Frage'));
  assert.match(prompts[n0 + 1], /Erste Frage[\s\S]*Zweite Frage[\s\S]*Dritte Frage/, 'Folgelauf liest den Verlauf neu');
  assert.equal(await replies(), r0 + 2);
});

test('Projektkanal: Erwähnungen in verschiedenen Threads während eines Laufs bekommen je eine Antwort im eigenen Thread', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const agent = await t.db.one(`select id from users where name = 'Chatty' and kind = 'agent'`);
  const ch = (await t.api(pl).get(`/projects/${t.ids.projects.web}/chat`)).json().channel.id;
  const answers = async (id: string) => (await t.api(pl).get(`/chat/channels/${ch}/messages?thread=${id}`)).json().messages.filter((m: any) => m.userId === agent.id).length;
  let release!: () => void;
  gate = new Promise<void>((r) => { release = r; });
  const n0 = prompts.length;
  const a = (await t.api(pl).post(`/chat/channels/${ch}/messages`, { body: '@Chatty Frage A' })).json().message;
  for (let i = 0; i < 400 && prompts.length === n0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(prompts.length, n0 + 1, 'Lauf für Thread A läuft');
  // Zwei neue Threads, während der Lauf für A noch wartet: keiner verdrängt den anderen
  const b = (await t.api(max).post(`/chat/channels/${ch}/messages`, { body: '@Chatty Frage B' })).json().message;
  const c = (await t.api(pl).post(`/chat/channels/${ch}/messages`, { body: '@Chatty Frage C' })).json().message;
  gate = null;
  release();
  await flushAgentRuns();
  assert.deepEqual([await answers(a.id), await answers(b.id), await answers(c.id)], [1, 1, 1]);
  assert.equal(prompts.length, n0 + 3, 'ein Lauf je Thread');
});

test('Kennzahlen-Woche (Europe/Berlin) und claimCheck (deterministisch, nur erste Person)', () => {
  const w = berlinWeek(new Date());
  assert.ok(w.sunday >= w.today);
  assert.equal(new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(new Date(w.sunday + 'T12:00:00Z')), 'Sun');
  assert.deepEqual(berlinWeek(new Date('2026-10-19T10:00:00Z')), { today: '2026-10-19', sunday: '2026-10-25' });
  assert.deepEqual(berlinWeek(new Date('2026-10-25T23:30:00Z')), { today: '2026-10-26', sunday: '2026-11-01' }, 'Sonntag 23:30 UTC ist in Berlin schon Montag');

  const c1 = claimCheck('Ich habe die Mail an Müller gesendet. Das Angebot liegt vor.', false);
  assert.equal(c1.text, 'Das konnte ich nicht ausführen: „Ich habe die Mail an Müller gesendet“. Das Angebot liegt vor.');
  assert.deepEqual(c1.replaced, ['Ich habe die Mail an Müller gesendet.']);
  assert.equal(claimCheck('Zu WEB-4: Das habe ich im Log eingetragen.', true).replaced.length, 0, 'mit Notiz ist „eingetragen“ wahr');
  assert.equal(claimCheck('Zu WEB-4: Das habe ich im Log eingetragen.', false).replaced.length, 1, 'ohne Notiz nicht');
  assert.equal(claimCheck('Die Aufgabe wurde von mir angelegt.', false).replaced.length, 1);
  assert.equal(claimCheck('Ich habe gesehen, dass Anna das Angebot freigegeben hat.', false).replaced.length, 0, 'Nebensatz über andere');
  assert.equal(claimCheck('Erledigt: WEB-4 ist abgeschlossen. Anna hat die Mail gesendet.', true).replaced.length, 0, 'nicht erste Person');
  assert.equal(claimCheck('Ich habe nichts gesendet, das macht die PL.', true).replaced.length, 0, 'Verneinung');
  assert.equal(claimCheck('Wir haben keine Aufgabe angelegt.', true).replaced.length, 0, 'Verneinung');
  assert.equal(claimCheck('Philipp, der Termin 6.–8.11. ist bereits angelegt und wartet auf Sven.', false).replaced.length, 1, 'Vollzug ohne Person und ohne Kennung');
  assert.equal(claimCheck('WEB-12 ist bereits angelegt.', false).replaced.length, 0, 'mit Kennung prüfbar');
  assert.equal(claimCheck('Der Termin ist bereits angelegt.', false, true).replaced.length, 0, 'mit ausgeführtem Befehl');
  const c2 = claimCheck('Philipp, ich habe den Auftrag für den Termin 6.–8.11. zur Hardwareauslagerung angelegt. Frist bis 24.10. gesetzt.', false);
  assert.deepEqual(c2.replaced, ['Philipp, ich habe den Auftrag für den Termin 6.–8.11. zur Hardwareauslagerung angelegt.'], 'Punkte in Daten trennen keine Sätze');
  assert.equal(c2.text, 'Das konnte ich nicht ausführen: „Philipp, ich habe den Auftrag für den Termin 6.–8.11. zur Hardwareauslagerung angelegt“. Frist bis 24.10. gesetzt.');
});

test('Chat-Thema: Kennung, Projektname, Verlauf, „über alle Projekte“, Rückfrage, fremde Kennung, Kennzahlen, claimCheck, Thread-Wurzel', async () => {
  const pl = await t.login('pl@demo.local');
  const anna = await t.login('anna@demo.local');
  const max = await t.login('max@demo.local');
  const agent = await t.db.one(`select id from users where name = 'Chatty' and kind = 'agent'`);
  const t4 = await t.db.one(`select number from tasks where id = $1`, [t.ids.tasks.t4]);
  // Chatty auch in ERP (Anna ist dort PL) mit einem eigenen Arbeitspaket: Max und Chatty haben nun zwei gemeinsame Projekte
  assert.equal((await t.api(anna).put(`/projects/${t.ids.projects.erp}/members/${agent.id}`, { role: 'member', agentCanMail: false })).statusCode, 200);
  const erpTask = await t.db.one(`select id, number from tasks where title = 'Schnittstellenliste Altsystem'`);
  assert.equal((await t.api(anna).patch(`/tasks/${erpTask.id}`, { responsibleUserId: agent.id })).statusCode, 200);
  await flushAgentRuns();
  const cid = (await t.api(max).post('/chat/dm', { userId: agent.id })).json().channelId;
  const say = async (who: Record<string, string>, channel: string, body: string, threadId?: string) => { const r = await t.api(who).post(`/chat/channels/${channel}/messages`, { body, threadId }); assert.equal(r.statusCode, 200, r.body); await flushAgentRuns(); return r.json().message; };
  const lastReply = async (channel: string) => (await t.api(max).get(`/chat/channels/${channel}/messages`)).json().messages.filter((m: any) => m.userId === agent.id).at(-1).body as string;

  // Kennung: nur dieses Projekt und dieses Arbeitspaket im Prompt, das andere Projekt fehlt vollständig
  const first = await say(max, cid, `Wie steht es mit WEB-${t4.number}?`);
  let p = prompts.at(-1)!;
  assert.match(p, new RegExp(`Thema: Arbeitspaket WEB-${t4.number} in Projekt WEB „Website-Relaunch“ \\(in der Nachricht genannt\\)`));
  assert.ok(p.includes('Angebot Agentur'));
  assert.ok(!p.includes('ERP') && !p.includes('Schnittstellenliste'), 'anderes Projekt fehlt vollständig');
  assert.match(p, new RegExp(`Kennzahlen zu WEB-${t4.number}: offen \\d+ · in Arbeit \\d+ · fällig diese Woche \\d+ · überfällig \\d+ · blockiert \\d+ · wartet \\d+`));
  assert.ok(!p.includes('stammt aus dem Verlauf'));
  // Anthropic Structured Outputs begrenzt Union-Typen (Typ-Listen, anyOf): das Chat-Schema kommt ohne aus
  const unions = (o: any): number => !o || typeof o !== 'object' ? 0 : (Array.isArray(o.type) || o.anyOf ? 1 : 0) + Object.values(o).reduce((n: number, v) => n + unions(v), 0);
  assert.equal(unions(lastChatBody.response_format.json_schema.schema), 0);
  let run = await t.db.one(`select * from agent_runs where agent_user_id = $1 and trigger = 'chat' order by created_at desc limit 1`, [agent.id]);
  assert.equal(run.status, 'ok');
  assert.match(run.reasoning, new RegExp(`Thema: WEB-${t4.number} \\(mentioned\\)`));

  // Kein Gedächtnis außerhalb eines Threads: dieselbe Folgefrage oben fragt nach dem Projekt (ohne LLM-Aufruf)
  let n1 = prompts.length;
  await say(max, cid, 'Und bis wann?');
  assert.equal(prompts.length, n1, 'kein Verlauf, keine Zuordnung: Rückfrage');
  assert.match(await lastReply(cid), /^Zu welchem Projekt\?/);
  // Dialog im Thread: das im Thread genannte Arbeitspaket bleibt das Thema, die Antwort beginnt mit „Zu WEB-n:“ und steht im Thread
  await say(max, cid, 'Und bis wann?', first.id);
  p = prompts.at(-1)!;
  assert.equal(prompts.length, n1 + 1);
  assert.match(p, /\(zuletzt im Thread genannt\)/);
  assert.ok(p.includes(`Das Thema stammt aus dem Verlauf (WEB-${t4.number})`));
  const inThread = (await t.api(max).get(`/chat/channels/${cid}/messages?thread=${first.id}`)).json().messages.filter((m: any) => m.userId === agent.id).at(-1);
  assert.ok(inThread?.body.startsWith(`Zu WEB-${t4.number}:`), 'Antwort im Thread mit Bezugszeile');
  assert.ok(p.includes('Angebot Agentur') && !p.includes('Schnittstellenliste'));

  // Projektname: nur ERP, ohne die eigenen Arbeitspakete aus WEB
  await say(max, cid, 'Was läuft gerade in der ERP-Einführung?');
  p = prompts.at(-1)!;
  assert.match(p, /Thema: Projekt ERP „ERP-Einführung“ \(in der Nachricht genannt\)/);
  assert.ok(p.includes(`ERP-${erpTask.number} „Schnittstellenliste Altsystem“`));
  assert.ok(!p.includes('Angebot Agentur') && !p.includes('Kennzahlen zu WEB'));
  assert.match(p, /Kennzahlen zu ERP: offen \d+/);

  // „über alle Projekte“: beide Projekte, je Zeile mit Kürzel, Kennzahlen je Projekt
  await say(max, cid, 'Wie sieht es über alle Projekte aus?');
  p = prompts.at(-1)!;
  assert.match(p, /Thema: Projekt ERP „ERP-Einführung“, WEB „Website-Relaunch“ \(alle gemeinsamen Projekte, ausdrücklich gefragt\)/);
  assert.match(p, /Kennzahlen zu ERP: offen \d+[\s\S]*Kennzahlen zu WEB: offen \d+/);
  assert.ok(p.includes(`- WEB-${t4.number} „Angebot Agentur`) && p.includes(`- ERP-${erpTask.number} „Schnittstellenliste`));

  // Mehrere gemeinsame Projekte ohne Anhaltspunkt: Rückfrage mit Projektnamen, keine Inhalte, kein LLM-Aufruf, kein Budget
  const plDm = (await t.api(pl).post('/chat/dm', { userId: agent.id })).json().channelId;
  let n0 = prompts.length;
  await say(pl, plDm, 'Hallo, wie ist der Stand?');
  assert.equal(prompts.length, n0, 'kein LLM-Aufruf');
  const ask = (await t.api(pl).get(`/chat/channels/${plDm}/messages`)).json().messages.at(-1);
  assert.equal(ask.userId, agent.id);
  assert.equal(ask.body, 'Zu welchem Projekt? ERP-Einführung (ERP) oder Website-Relaunch (WEB)?');
  run = await t.db.one(`select * from agent_runs where agent_user_id = $1 and trigger = 'chat' order by created_at desc limit 1`, [agent.id]);
  assert.equal(run.status, 'skipped');
  assert.equal(run.error, 'Rückfrage: Projekt nicht eindeutig');
  // Kürzel als Antwort genügt
  await say(pl, plDm, 'WEB');
  assert.equal(prompts.length, n0 + 1);
  assert.match(prompts.at(-1)!, /Thema: Projekt WEB „Website-Relaunch“ \(in der Nachricht genannt\)/);

  // Kennung aus einem Projekt, das Max nicht sieht: feste Absage ohne Titel, kein LLM-Aufruf
  const geh = (await t.api(pl).post('/projects', { key: 'GEH', name: 'Geheimprojekt' })).json().project;
  assert.equal((await t.api(pl).put(`/projects/${geh.id}/members/${agent.id}`, { role: 'member', agentCanMail: false })).statusCode, 200);
  const cols = new Map<string, string>((await t.db.query(`select id, name from board_columns where project_id = $1`, [geh.id])).rows.map((c: any) => [c.name, c.id]));
  const secret = (await t.api(pl).post(`/projects/${geh.id}/tasks`, { title: 'Streng vertraulich', columnId: cols.get('Geplant') })).json().task;
  n0 = prompts.length;
  await say(max, cid, `Was ist mit GEH-${secret.number}?`);
  assert.equal(prompts.length, n0, 'kein LLM-Aufruf');
  assert.equal(await lastReply(cid), 'Dazu kann ich dir hier nichts sagen.');
  run = await t.db.one(`select * from agent_runs where agent_user_id = $1 and trigger = 'chat' order by created_at desc limit 1`, [agent.id]);
  assert.equal(run.status, 'skipped');
  assert.equal(run.error, `Thema ohne gemeinsame Freigabe: GEH-${secret.number}`);
  // Gemischt: zum fremden nichts (ohne Titel), zum eigenen normal
  await say(max, cid, `WEB-${t4.number} und GEH-${secret.number}: wie weit?`);
  assert.equal(prompts.length, n0 + 1);
  assert.ok(!prompts.at(-1)!.includes('Streng vertraulich') && !prompts.at(-1)!.includes('Geheimprojekt'));
  assert.equal(await lastReply(cid), `Zu GEH-${secret.number} kann ich dir hier nichts sagen. Das Angebot liegt vor, ich kläre die Lizenzen.`);

  // Kennzahlen gegen eine Fixture: offen 5 (alle außer Erledigt), in Arbeit 2 (Offen, In Arbeit), fällig diese Woche 1 (heute), überfällig 1, blockiert 1, wartet 1
  const { today } = berlinWeek(new Date());
  const shift = (days: number) => { const [y, m, d] = today.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10); };
  const mk = async (title: string, col: string, dueDate: string | null) => (await t.api(pl).post(`/projects/${geh.id}/tasks`, { title, columnId: cols.get(col), dueDate })).json().task;
  const a = await mk('Angebot anfordern', 'Offen', today);
  const b = await mk('Vertrag prüfen', 'In Arbeit', shift(-3));
  const c = await mk('Kickoff vorbereiten', 'Geplant', null);
  await mk('Altes Konzept', 'Erledigt', shift(-10));
  await mk('Später', 'Zurückgestellt', shift(30));
  assert.equal((await t.api(pl).patch(`/tasks/${b.id}`, { blocked: true, blockedReason: 'Unterschrift fehlt' })).statusCode, 200);
  await t.db.query(`update tasks set agent_wait = $2 where id = $1`, [c.id, JSON.stringify({ kind: 'reply', reason: 'Antwort der PL', since: new Date().toISOString() })]);
  assert.equal((await t.api(pl).patch(`/tasks/${a.id}`, { responsibleUserId: agent.id })).statusCode, 200);
  await flushAgentRuns();
  const statusMsg = await say(pl, plDm, 'Status GEH?');
  p = prompts.at(-1)!;
  assert.ok(p.includes('Kennzahlen zu GEH: offen 5 · in Arbeit 2 · fällig diese Woche 1 · überfällig 1 · blockiert 1 · wartet 1'), p);
  assert.ok(p.includes(`- GEH-${a.number} „Angebot anfordern“`), 'eigene Arbeitspakete des Themas');
  assert.ok(p.includes('Weitere offene Arbeitspakete im Thema') && p.includes('Streng vertraulich'), 'fremde Arbeitspakete nur kompakt in der Liste für Aufträge (Konzept 7.2)');

  // claimCheck: Behauptung ohne Notiz wird ersetzt und im Lauf vermerkt; mit Notiz bleibt „vermerkt“ stehen
  nextReply = 'Ich habe die Mail an Müller gesendet. Das Angebot liegt vor.';
  await say(pl, plDm, 'Hast du die Mail an Müller geschickt?');
  assert.equal((await t.api(pl).get(`/chat/channels/${plDm}/messages`)).json().messages.at(-1).body, 'Das konnte ich nicht ausführen: „Ich habe die Mail an Müller gesendet“. Das Angebot liegt vor.');
  run = await t.db.one(`select * from agent_runs where agent_user_id = $1 and trigger = 'chat' order by created_at desc limit 1`, [agent.id]);
  assert.deepEqual(run.actions.find((x: any) => x.type === 'claim_check'), { type: 'claim_check', replaced: 1, text: 'Ich habe die Mail an Müller gesendet.' });
  nextReply = 'Ich habe das im Log vermerkt.';
  nextNotes = [{ taskId: a.id, text: 'PL: Angebot kommt Freitag.' }];
  // Information zum Thema im Thread (ohne Thread kennt der Agent das Projekt nicht mehr)
  await say(pl, plDm, 'Das Angebot kommt Freitag.', statusMsg.id);
  assert.equal((await t.api(pl).get(`/chat/channels/${plDm}/messages?thread=${statusMsg.id}`)).json().messages.at(-1).body, 'Ich habe das im Log vermerkt.');
  assert.equal((await t.db.one(`select count(*)::int as n from task_comments where task_id = $1 and body like 'Aus dem Chat%'`, [a.id])).n, 1);
  run = await t.db.one(`select * from agent_runs where agent_user_id = $1 and trigger = 'chat' order by created_at desc limit 1`, [agent.id]);
  assert.ok(!run.actions.some((x: any) => x.type === 'claim_check'));

  // Projektkanal mit Thread: die Kennung der Thread-Wurzel bestimmt das Arbeitspaket mit, Kennungen anderer Projekte zählen nicht
  const ch = (await t.api(pl).get(`/projects/${t.ids.projects.web}/chat`)).json().channel.id;
  const root = await say(pl, ch, `@Chatty zu WEB-${t4.number} und ERP-${erpTask.number}: wie weit?`);
  p = prompts.at(-1)!;
  assert.match(p, new RegExp(`Thema: Arbeitspaket WEB-${t4.number} in Projekt WEB „Website-Relaunch“ \\(Projekt dieses Kanals\\)`));
  assert.ok(!p.includes('Schnittstellenliste'));
  assert.ok((await t.api(pl).get(`/chat/channels/${ch}/messages?thread=${root.id}`)).json().messages.at(-1).body.startsWith(`Zu ERP-${erpTask.number} kann ich dir hier nichts sagen. `));
  await say(pl, ch, 'Und die Lizenzen?', root.id);
  p = prompts.at(-1)!;
  assert.match(p, new RegExp(`Thema: Arbeitspaket WEB-${t4.number} in Projekt WEB „Website-Relaunch“ \\(Projekt dieses Kanals\\)`));
  assert.match(p, new RegExp(`Kennzahlen zu WEB-${t4.number}:`));
});

test('Ohne Kontext: Gruß ohne Projektbezug bekommt keine Projektinfos; mit persönlichem Projekt nur dessen Doku und Arbeitspakete, Verlauf zählt dann nicht', async () => {
  const admin = await t.login('admin@demo.local');
  const max = await t.login('max@demo.local');
  const agent = await t.db.one(`select id from users where name = 'Chatty' and kind = 'agent'`);
  const cid = (await t.api(max).post('/chat/dm', { userId: agent.id })).json().channelId;
  const say = async (body: string) => { const r = await t.api(max).post(`/chat/channels/${cid}/messages`, { body }); assert.equal(r.statusCode, 200, r.body); await flushAgentRuns(); return prompts.at(-1)!; };
  // Max hat zwei gemeinsame Projekte (WEB, ERP) und noch kein persönliches: „hi“ → kein Projektbezug, keine Kennzahlen, keine Arbeitspakete
  let p = await say('hi Chatty');
  assert.match(p, /Thema: kein Projektbezug in der Nachricht/);
  assert.ok(!p.includes('Kennzahlen zu') && !p.includes('Angebot Agentur') && !p.includes('Schnittstellenliste'), 'keine Projektinfos');
  assert.match(p, /nur ein Gruß oder eine Kurzmeldung/);
  // Persönliches Projekt von Max mit Chatty als Mitglied und einer Doku-Seite
  assert.equal((await t.api(admin).put('/org/settings', { personalProjects: true })).statusCode, 200);
  // Org-Profil von Chatty auch in persönlichen Projekten freigeben, sonst ist der Agent dort gesperrt
  const prof = await t.db.one(`select id from ai_profiles where name = 'Qwen' and org_id = $1`, [t.ids.org]);
  assert.equal((await t.api(admin).patch(`/ai/profiles/${prof.id}`, { personalScope: true })).statusCode, 200);
  const r = await t.api(max).post('/projects', { key: 'MAXP', name: 'Max Assistent', personal: true });
  assert.equal(r.statusCode, 200, r.body);
  const pid = r.json().project.id;
  assert.equal((await t.api(max).put(`/projects/${pid}/members/${agent.id}`, { role: 'member', agentCanMail: false })).statusCode, 200);
  await t.db.query(`insert into doc_pages (project_id, folder_id, title, content_md, content_html, status, created_by, updated_by) values ($1,null,'Notizen Urlaub','# Urlaub\nFlug am 3.11. ab Frankfurt.','<h1>Urlaub</h1>','draft',$2,$2)`, [pid, t.ids.users.max]);
  p = await say('hi');
  assert.match(p, /Thema: Projekt MAXP „Max Assistent“ \(persönliches Projekt des Absenders/);
  assert.ok(p.includes('Doku im persönlichen Projekt') && p.includes('„Notizen Urlaub“'), 'Doku des persönlichen Projekts');
  assert.ok(!p.includes('Angebot Agentur') && !p.includes('Schnittstellenliste') && !p.includes('stammt aus dem Verlauf'), 'nichts aus anderen Projekten, kein Verlauf');
  // Frage ohne Nennung: trotz Verlauf (WEB, ERP) bleibt das persönliche Projekt das Thema, mit passender Seite und Ausschnitt
  p = await say('Wann geht mein Flug?');
  assert.match(p, /Thema: Projekt MAXP/);
  assert.ok(p.includes('Flug am 3.11.'), 'Ausschnitt aus der Suche');
  assert.ok(!p.includes('Angebot Agentur'));
  // Ausdrückliche Nennung holt das andere Projekt zurück
  p = await say('Was läuft gerade in der ERP-Einführung?');
  assert.match(p, /Thema: Projekt ERP „ERP-Einführung“ \(in der Nachricht genannt\)/);
});
