import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { testApp } from './helpers.js';
import { normNumber } from '../src/telephony/phone.js';

/** Lokales LLM für das Telefon: liefert die nächste vorbereitete Antwort und merkt sich die Prompts. */
const prompts: string[] = [];
const replies: Record<string, unknown>[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (String(input) !== 'http://phone-llm.example/v1/chat/completions') return new Response('{}', { status: 404 });
  const system = body.messages?.[0]?.content ?? '';
  if (!system.includes('am Telefon')) return new Response('{}', { status: 500 });
  prompts.push(body.messages?.[1]?.content ?? '');
  const r = { say: 'Verstanden.', end: false, name: '', callback: '', concern: '', project: '', eventTitle: '', eventStart: '', eventEnd: '', ...(replies.shift() ?? {}) };
  return new Response(JSON.stringify({ model: 'schnell', choices: [{ message: { role: 'assistant', content: JSON.stringify(r) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
};
delete process.env.ANTHROPIC_API_KEY;
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());

let secret = '';
let ioUrl = '';
const LINE = '+49 211 1111111';
const flow = (ev: Record<string, unknown>, headers: Record<string, string> = { 'x-api-token': secret }) =>
  t.app.inject({ method: 'POST', url: `/api/telephony/flow/${t.ids.org}`, headers: { 'content-type': 'application/json', ...headers }, payload: JSON.stringify(ev) });
const session = (id: string, from: string) => ({ id, account_id: 'acc', phone_number: '492111111111', direction: 'inbound', from_phone_number: from, to_phone_number: '492111111111' });

test('Rufnummern normalisieren', () => {
  assert.equal(normNumber('+49 211 111-1111'), '492111111111');
  assert.equal(normNumber('0049 (211) 1111111'), '492111111111');
  assert.equal(normNumber('0211/1111111'), '492111111111');
  assert.equal(normNumber('492111111111'), '492111111111');
});

test('Telefonie einrichten: nur Org-Admin, Schlüssel einmal sichtbar, Rufnummer mit Projekt, Agent und Profil', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  assert.equal((await t.api(pl).get('/telephony')).statusCode, 403);
  const s = await t.api(admin).post('/telephony/secret');
  assert.equal(s.statusCode, 200, s.body);
  secret = s.json().secret;
  ioUrl = new URL(s.json().ioUrl).pathname;
  assert.ok(secret.length > 20);
  assert.equal((await t.api(admin).put('/telephony', { enabled: true })).statusCode, 200);
  const cfg = (await t.api(admin).get('/telephony')).json();
  assert.equal(cfg.enabled, true);
  assert.equal(JSON.stringify(cfg).includes(secret), false, 'Schlüssel nur bei der Erzeugung');
  const profile = (await t.api(admin).post('/ai/profiles', { name: 'Telefon schnell', provider: 'local', baseUrl: 'http://phone-llm.example/v1', model: 'schnell' })).json().profile;
  const agent = (await t.api(admin).post('/agents', { name: 'Jana', aiProfileId: profile.id })).json().agent;
  const bad = await t.api(admin).post('/telephony/lines', { number: LINE, projectId: t.ids.projects.web, agentUserId: agent.id });
  assert.equal(bad.statusCode, 400, 'Agent muss Mitglied des Projekts sein');
  assert.equal((await t.api(pl).put(`/projects/${t.ids.projects.web}/members/${agent.id}`, { role: 'member' })).statusCode, 200);
  const line = await t.api(admin).post('/telephony/lines', { number: LINE, label: 'Hotline Website', projectId: t.ids.projects.web, agentUserId: agent.id, aiProfileId: profile.id });
  assert.equal(line.statusCode, 200, line.body);
  assert.equal(line.json().line.number, '492111111111');
  assert.equal((await t.api(admin).post('/telephony/lines', { number: '0211 1111111' })).statusCode, 400, 'Nummer doppelt');
});

test('Flow: ohne gültigen Schlüssel abgelehnt; Token oder HMAC-Signatur', async () => {
  const ev = { type: 'session_start', session: session('11111111-1111-4111-8111-111111111111', '4930999') };
  assert.equal((await flow(ev, { 'x-api-token': 'falsch' })).statusCode, 401);
  assert.equal((await flow(ev, {})).statusCode, 401);
  const raw = JSON.stringify(ev);
  const sig = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  const r = await t.app.inject({ method: 'POST', url: `/api/telephony/flow/${t.ids.org}`, headers: { 'content-type': 'application/json', 'x-sipgate-signature': sig }, payload: raw });
  assert.equal(r.statusCode, 200, r.body);
});

test('Flow, externer Anrufer: Begrüßung als KI, Anliegen aufnehmen, Terminvorschlag, Auflegen; danach Arbeitspaket, vorläufiger Termin, Meldung an die PL', async () => {
  const sid = '22222222-2222-4222-8222-222222222222';
  const start = await flow({ type: 'session_start', session: session(sid, '4917012345') });
  assert.equal(start.statusCode, 200, start.body);
  const actions = start.json();
  assert.equal(actions[0].type, 'configure_transcription');
  assert.equal(actions[1].type, 'speak');
  assert.match(actions[1].text, /Jana, dem KI-Assistenten .* Website-Relaunch/);
  replies.push({ say: 'Gern. Wie ist Ihr Name?', concern: 'Möchte ein Angebot für die Pflege der Website.' });
  const s1 = (await flow({ type: 'user_speak', session: session(sid, '4917012345'), text: 'Ich hätte gern ein Angebot für die Website-Pflege.' })).json();
  assert.deepEqual([s1[0].type, s1[0].text], ['speak', 'Gern. Wie ist Ihr Name?']);
  assert.match(prompts.at(-1)!, /Anrufer-Nummer: 4917012345/);
  assert.ok(!prompts.at(-1)!.includes('Kennzahlen'), 'Externe bekommen keine Projektinfos');
  replies.push({ say: 'Danke, Herr Kurz. Ich notiere den Termin am 5. November um 10 Uhr als Vorschlag. Auf Wiederhören.', end: true, name: 'Herr Kurz', callback: '0170 12345', eventTitle: 'Rückruf Angebot Pflege', eventStart: '2026-11-05T10:00', eventEnd: '2026-11-05T10:30' });
  await flow({ type: 'user_speak', session: session(sid, '4917012345'), text: 'Kurz, Elektro Kurz. Rufen Sie mich am 5.11. um 10 an.' });
  assert.deepEqual((await flow({ type: 'assistant_speech_ended', session: session(sid, '4917012345') })).json(), [{ session_id: sid, type: 'hangup' }]);
  await flow({ type: 'session_end', session: session(sid, '4917012345') });
  const call = await t.db.one(`select * from calls where external_id = $1`, [sid]);
  assert.equal(call.status, 'ended');
  assert.ok(call.task_id && call.meeting_id);
  const task = await t.db.one(`select title, description, project_id from tasks where id = $1`, [call.task_id]);
  assert.equal(task.project_id, t.ids.projects.web);
  assert.match(task.title, /^Anruf von Herr Kurz: Möchte ein Angebot/);
  assert.match(task.description, /Rückruf: 0170 12345/);
  const log = await t.db.one(`select body from task_comments where task_id = $1 and body like 'Gesprächsverlauf%'`, [call.task_id]);
  assert.match(log.body, /Anrufer: Ich hätte gern ein Angebot/);
  const meeting = await t.db.one(`select tentative, starts_at from meetings where id = $1`, [call.meeting_id]);
  assert.equal(meeting.tentative, true);
  assert.equal(new Date(meeting.starts_at).toISOString(), '2026-11-05T09:00:00.000Z', '10:00 Europe/Berlin (MEZ)');
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'call.message' and title = 'Anruf von Herr Kurz'`, [t.ids.users.pl]));
  // Doppeltes session_end legt nichts doppelt an
  await flow({ type: 'session_end', session: session(sid, '4917012345') });
  assert.equal((await t.db.one(`select count(*)::int as c from tasks where title like 'Anruf von Herr Kurz%'`)).c, 1);
});

test('Flow, interner Anrufer (Telefonnummer am Benutzer): Begrüßung per Vorname, Stand aus Kennzahlen, ohne Nachricht kein Arbeitspaket', async () => {
  const pl = await t.login('pl@demo.local');
  assert.equal((await t.api(pl).put('/me/phone', { phone: '0171 5555555' })).statusCode, 200);
  assert.equal((await t.api(pl).get('/me/phone')).json().phone, '491715555555');
  const anna = await t.login('anna@demo.local');
  assert.equal((await t.api(anna).put('/me/phone', { phone: '+49 171 5555555' })).statusCode, 400, 'eine Nummer je Person');
  const sid = '33333333-3333-4333-8333-333333333333';
  const start = (await flow({ type: 'session_start', session: session(sid, '491715555555') })).json();
  assert.match(start[1].text, /^Hallo Petra/);
  replies.push({ say: 'Im Website-Relaunch sind einige Pakete offen, eines ist überfällig.', end: true });
  await flow({ type: 'user_speak', session: session(sid, '491715555555'), text: 'Wie ist der Stand?' });
  assert.match(prompts.at(-1)!, /Kennzahlen zu WEB: offen \d+/);
  assert.match(prompts.at(-1)!, /Offene Arbeitspakete \(Auszug\)/);
  await flow({ type: 'session_end', session: session(sid, '491715555555') });
  const call = await t.db.one(`select task_id, summary, caller_user_id from calls where external_id = $1`, [sid]);
  assert.equal(call.caller_user_id, t.ids.users.pl);
  assert.equal(call.task_id, null);
  assert.equal(call.summary, 'Auskunft ohne Nachricht');
});

test('Unbekannte Rufnummer: Hinweis und Auflegen; sipgate.io: Anruf-Log mit Abo auf Annahme und Ende', async () => {
  const sid = '44444444-4444-4444-8444-444444444444';
  const s = { id: sid, direction: 'inbound', from_phone_number: '4930111', to_phone_number: '4989000000' };
  const r = (await flow({ type: 'session_start', session: s })).json();
  assert.match(r[1].text, /niemand erreichbar/);
  assert.deepEqual((await flow({ type: 'assistant_speech_ended', session: s })).json(), [{ session_id: sid, type: 'hangup' }]);

  const form = (body: string) => t.app.inject({ method: 'POST', url: ioUrl, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: body });
  assert.equal((await t.app.inject({ method: 'POST', url: ioUrl.replace(/[^/]+$/, 'falsch'), headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'event=newCall&callId=x' })).statusCode, 401);
  const n = await form('event=newCall&direction=in&from=4930222&to=492111111111&callId=io-1&user%5B%5D=Petra');
  assert.equal(n.statusCode, 200, n.body);
  assert.match(n.body, /<Response onAnswer="[^"]+" onHangup="[^"]+"\/>/);
  await form('event=answer&callId=io-1&user%5B%5D=Petra%20Lenz');
  await form('event=hangup&callId=io-1&cause=normalClearing');
  const call = await t.db.one(`select * from calls where external_id = 'io-1'`);
  assert.deepEqual([call.provider, call.status, call.project_id, call.summary, call.error], ['sipgate_io', 'ended', t.ids.projects.web, 'angenommen von Petra Lenz', null]);
  const admin = await t.login('admin@demo.local');
  const list = (await t.api(admin).get('/telephony/calls')).json().calls;
  assert.ok(list.some((c: any) => c.from === '4930222') && list.some((c: any) => c.taskNumber));
  assert.equal((await t.api(await t.login('max@demo.local')).get('/telephony/calls')).statusCode, 403);
});
