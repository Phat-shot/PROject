import test from 'node:test';
import assert from 'node:assert/strict';
import { composeEcho, testApp } from './helpers.js';
import { flushAgentRuns } from '../src/ai/agentEvents.js';
import { runAgentOnTask } from '../src/ai/agent.js';
import { dayRange, runUnconfirmedBookings } from '../src/resources/service.js';

/** Lokales LLM für Agentenläufe: liefert `nextActions`. */
let nextActions: any[] = [];
const prompts: string[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const echo = composeEcho(body);
  if (echo) return echo;
  if (String(input) !== 'http://llm.local:8000/v1/chat/completions') return new Response('{}', { status: 404 });
  prompts.push(String(body.messages?.at(-1)?.content ?? ''));
  const content = body.response_format ? JSON.stringify({ note: 'Ressourcen-Test', actions: nextActions }) : 'bereit';
  nextActions = [{ type: 'none', reason: 'fertig' }];
  return new Response(JSON.stringify({ model: 'qwen', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
};
delete process.env.ANTHROPIC_API_KEY;
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());

const web = () => t.ids.projects.web;
const erp = () => t.ids.projects.erp;
const day = (offset: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
const at = (offset: number, h: number) => { const d = new Date(`${day(offset)}T${String(h).padStart(2, '0')}:00:00Z`); return d.toISOString(); };
let room: any; let scaffold: any; let beamer: any; let elektriker: any; let group: string;
/** Person ohne WEB-Mitgliedschaft (Sichtbarkeit members): sieht Belegungen nur maskiert. */
let fremd: Awaited<ReturnType<typeof t.login>>;

test('Ressourcen: Pool nur Org-Admin oder Ressourcenverwaltung, Projektressourcen ab Mitglied, Namen eindeutig, Liste je Projekt', async () => {
  const admin = await t.login('admin@demo.local');
  const max = await t.login('max@demo.local');
  const anna = await t.login('anna@demo.local');
  const leser = await t.login('leser@demo.local');
  assert.equal((await t.api(max).post('/resources', { kind: 'room', name: 'Besprechungsraum Nord' })).statusCode, 403, 'Pool nur Verwaltung');
  assert.equal((await t.api(admin).post('/users', { email: 'fremd@demo.local', name: 'Frida Fremd', password: 'demo1234' })).statusCode, 200);
  fremd = await t.login('fremd@demo.local');
  let r = await t.api(admin).post('/resources', { kind: 'room', name: 'Besprechungsraum Nord', location: 'EG 0.12', email: 'raum-nord@demo.local' });
  assert.equal(r.statusCode, 200, r.body); room = r.json().resource; assert.equal(room.projectId, null);
  assert.equal((await t.api(admin).post('/resources', { kind: 'room', name: 'besprechungsraum nord' })).statusCode, 400, 'Name eindeutig im Pool');
  assert.equal((await t.api(admin).post('/resources', { kind: 'laser', name: 'X' })).statusCode, 400);
  // Ressourcenverwaltung als Org-Recht
  assert.equal((await t.api(admin).patch(`/users/${t.ids.users.anna}`, { orgRights: ['resources_admin'] })).statusCode, 200);
  const anna2 = await t.login('anna@demo.local');
  group = (await t.api(admin).post('/groups', { name: 'Raumverwaltung', memberIds: [t.ids.users.anna] })).json().group.id;
  r = await t.api(anna2).post('/resources', { kind: 'equipment', name: 'Beamer', approvalGroupId: group });
  assert.equal(r.statusCode, 200, r.body); beamer = r.json().resource; assert.equal(beamer.approvalGroupId, group); assert.equal(beamer.approvalGroupName, 'Raumverwaltung');
  // Projektressource: Mitglied ja, Leser nein; Freigabegruppe gibt es nur im Pool
  assert.equal((await t.api(leser).post('/resources', { kind: 'scaffold', name: 'Gerüst Nord', projectId: web() })).statusCode, 403);
  r = await t.api(max).post('/resources', { kind: 'scaffold', name: 'Gerüst Nord', projectId: web(), approvalGroupId: group });
  assert.equal(r.statusCode, 200, r.body); scaffold = r.json().resource; assert.equal(scaffold.projectId, web()); assert.equal(scaffold.approvalGroupId, null);
  r = await t.api(max).post('/resources', { kind: 'person', name: 'Elektro Huber', projectId: web(), email: 'huber@elektro.example', trade: 'Elektro', organization: 'Huber GmbH' });
  assert.equal(r.statusCode, 200, r.body); elektriker = r.json().resource;
  const list = (await t.api(leser).get(`/resources?projectId=${web()}`)).json().resources;
  assert.deepEqual(list.map((x: any) => x.name).sort(), ['Beamer', 'Besprechungsraum Nord', 'Elektro Huber', 'Gerüst Nord']);
  assert.ok(!(await t.api(anna2).get(`/resources?projectId=${erp()}`)).json().resources.some((x: any) => x.name === 'Gerüst Nord'), 'Projektressource nur im eigenen Projekt');
  assert.equal((await t.api(max).patch(`/resources/${scaffold.id}`, { description: 'Fassadengerüst 12 m' })).statusCode, 200);
  assert.equal((await t.api(max).patch(`/resources/${room.id}`, { description: 'x' })).statusCode, 403, 'Pool nur Verwaltung');
  assert.equal((await t.api(max).del(`/resources/${scaffold.id}`)).statusCode, 403, 'Projektressource löscht die PL');
  assert.equal((await t.api(leser).get(`/resources?projectId=${erp()}`)).statusCode, 403, 'kein ERP-Mitglied');
});

test('Buchen: Konflikt 409 mit conflicts, vorläufig erlaubt, force nur PL oder Projektplan ändern (Audit, Meldung), Leser nie; Maskierung für Fremde', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const leser = await t.login('leser@demo.local');
  assert.equal((await t.api(leser).post(`/projects/${web()}/bookings`, { resourceId: room.id, startsAt: at(3, 9), endsAt: at(3, 11) })).statusCode, 403);
  let r = await t.api(pl).post(`/projects/${web()}/bookings`, { resourceId: room.id, startsAt: at(3, 9), endsAt: at(3, 11), title: 'Kickoff' });
  assert.equal(r.statusCode, 200, r.body); const b1 = r.json().booking; assert.equal(b1.tentative, false); assert.equal(b1.kind, 'booking'); assert.equal(b1.masked, false);
  // Überschneidung direkt → 409 mit den Konflikten; vorläufig → 200 mit warnings leer (hard zählt nicht als warning), Konflikt beim Lesen
  r = await t.api(max).post(`/projects/${web()}/bookings`, { resourceId: room.id, startsAt: at(3, 10), endsAt: at(3, 12), title: 'Abnahme' });
  assert.equal(r.statusCode, 409, r.body); assert.equal(r.json().conflicts.length, 1); assert.equal(r.json().conflicts[0].title, 'Kickoff');
  r = await t.api(max).post(`/projects/${web()}/bookings`, { resourceId: room.id, startsAt: at(3, 10), endsAt: at(3, 12), title: 'Abnahme', tentative: true });
  assert.equal(r.statusCode, 200, r.body); const b2 = r.json().booking; assert.equal(b2.tentative, true); assert.equal(b2.conflict, true);
  // Verfügbarkeit: belegt wegen Kickoff, vorläufig in einem Fenster, das nur die Abnahme trifft
  assert.equal((await t.api(max).get(`/availability?resourceId=${room.id}&startsAt=${at(3, 9)}&endsAt=${at(3, 10)}`)).json().status, 'busy');
  assert.equal((await t.api(max).get(`/availability?resourceId=${room.id}&startsAt=${at(3, 11)}&endsAt=${at(3, 12)}`)).json().status, 'tentative');
  assert.equal((await t.api(max).get(`/availability?resourceId=${room.id}&startsAt=${at(3, 13)}&endsAt=${at(3, 14)}`)).json().status, 'free');
  // force: Max darf (Projektplan ändern), Anna im ERP nicht ohne Planrecht → 409; Meldung booking.conflict an die PL (Ersteller von Kickoff)
  r = await t.api(max).post(`/projects/${web()}/bookings`, { resourceId: room.id, startsAt: at(3, 9), endsAt: at(3, 10), title: 'Dringend', force: true });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'booking.force' and object_id = $1`, [r.json().booking.id]));
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'booking.conflict'`, [t.ids.users.pl]), 'Ersteller der anderen Belegung informiert');
  assert.deepEqual((await t.api(max).get(`/projects/${web()}/my-booking-rights`)).json(), { canForce: true, canBook: true });
  // Maskierung: Frida ist kein WEB-Mitglied (Sichtbarkeit members) → nur „belegt“, kein Titel; die PL sieht alles
  const forAnna = (await t.api(fremd).get(`/bookings?resourceId=${room.id}`)).json().bookings;
  assert.ok(forAnna.length >= 3); assert.ok(forAnna.every((x: any) => x.masked && x.projectId === null && ['belegt', 'vorläufig belegt'].includes(x.title)));
  const forPl = (await t.api(pl).get(`/bookings?projectId=${web()}&resourceId=${room.id}`)).json().bookings;
  assert.ok(forPl.some((x: any) => x.title === 'Kickoff' && !x.masked && x.projectKey === 'WEB'));
  // Ändern/Löschen: Ersteller oder PL; Leser nie
  assert.equal((await t.api(leser).del(`/bookings/${b2.id}`)).statusCode, 403);
  assert.equal((await t.api(pl).patch(`/bookings/${b2.id}`, { title: 'Abnahme Bau' })).statusCode, 200);
  assert.equal((await t.api(max).del(`/bookings/${b2.id}`)).statusCode, 200);
});

test('Freigabegruppe: Pool-Buchung ohne Mitgliedschaft bleibt vorläufig (booking.request), nur die Gruppe bestätigt; Agent darf nicht bestätigen', async () => {
  const max = await t.login('max@demo.local');
  const anna = await t.login('anna@demo.local');
  const r = await t.api(max).post(`/projects/${web()}/bookings`, { resourceId: beamer.id, startsAt: at(5, 9), endsAt: at(5, 10), title: 'Präsentation' });
  assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().requested, true); assert.equal(r.json().booking.tentative, true);
  const id = r.json().booking.id;
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'booking.request'`, [t.ids.users.anna]), 'Gruppe informiert');
  assert.equal((await t.api(max).post(`/bookings/${id}/decide`, { decision: 'confirm' })).statusCode, 403, 'nur die Freigabegruppe');
  const d = await t.api(anna).post(`/bookings/${id}/decide`, { decision: 'confirm' });
  assert.equal(d.statusCode, 200, d.body); assert.equal(d.json().booking.tentative, false);
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'booking.confirmed'`, [t.ids.users.max]));
  // Ablehnen löscht
  const r2 = await t.api(max).post(`/projects/${web()}/bookings`, { resourceId: beamer.id, startsAt: at(6, 9), endsAt: at(6, 10), title: 'Schulung' });
  assert.equal((await t.api(anna).post(`/bookings/${r2.json().booking.id}/decide`, { decision: 'decline', text: 'Wartung' })).statusCode, 200);
  assert.equal(await t.db.maybeOne(`select 1 from resource_bookings where id = $1`, [r2.json().booking.id]), null);
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'booking.declined'`, [t.ids.users.max]));
});

test('Besprechung mit Ressourcen: Belegung entsteht, Raum wird Ort, Person-Ressource Teilnehmer, Zeitänderung zieht nach, Bestätigen bestätigt, Löschen entfernt; ICS mit CUTYPE', async () => {
  const pl = await t.login('pl@demo.local');
  let r = await t.api(pl).post(`/projects/${web()}/meetings`, { title: 'Baubesprechung', startsAt: at(7, 8), durationMinutes: 60, resourceIds: [room.id, elektriker.id] });
  assert.equal(r.statusCode, 200, r.body);
  const m = r.json().meeting;
  assert.equal(m.location, 'Besprechungsraum Nord'); assert.deepEqual(m.resourceIds.sort(), [room.id, elektriker.id].sort());
  assert.ok(m.attendees.some((a: any) => a.email === 'huber@elektro.example'), 'Person-Ressource ist Teilnehmer');
  let bs = (await t.api(pl).get(`/bookings?projectId=${web()}`)).json().bookings.filter((x: any) => x.meetingId === m.id);
  assert.equal(bs.length, 2); assert.ok(bs.every((x: any) => !x.tentative && x.title === 'Baubesprechung'));
  r = await t.api(pl).patch(`/meetings/${m.id}`, { startsAt: at(7, 9), durationMinutes: 90, resourceIds: [room.id] });
  assert.equal(r.statusCode, 200, r.body);
  bs = (await t.api(pl).get(`/bookings?projectId=${web()}`)).json().bookings.filter((x: any) => x.meetingId === m.id);
  assert.equal(bs.length, 1); assert.equal(bs[0].startsAt, at(7, 9)); assert.equal(bs[0].resourceId, room.id);
  // Elektriker mit Buchung am AP zählt als Aufgabenbezug (Regel E)
  const task = await t.db.one(`select id from tasks where project_id = $1 and parent_id is null order by number limit 1`, [web()]);
  await t.api(pl).post(`/projects/${web()}/bookings`, { resourceId: elektriker.id, taskId: task.id, startsAt: at(8, 8), endsAt: at(8, 16), title: 'Elektroarbeiten' });
  const { audienceOf } = await import('../src/outbound.js');
  assert.equal((await audienceOf(t.db, { projectId: web(), taskId: task.id, recipients: ['huber@elektro.example'] })).audience, 'task_external');
  // ICS der Einladung führt den Raum als CUTYPE=ROOM
  const { meetingIcs } = await import('../src/routes/meetings.js');
  const ics = meetingIcs({ id: m.id, title: 'Baubesprechung', starts_at: at(7, 9), ends_at: at(7, 10), location: 'Besprechungsraum Nord', description: null, attendees: [], project_id: web() }, { email: 'web@demo.local', name: 'WEB' }, 0, [{ name: 'Besprechungsraum Nord', email: 'raum-nord@demo.local', kind: 'room' }]);
  assert.match(ics, /ATTENDEE;CUTYPE=ROOM;ROLE=NON-PARTICIPANT;CN=Besprechungsraum Nord:mailto:raum-nord@demo.local/);
  assert.equal((await t.api(pl).del(`/meetings/${m.id}`)).statusCode, 200);
  assert.equal(await t.db.maybeOne(`select 1 from resource_bookings where meeting_id = $1`, [m.id]), null, 'Cascade');
});

test('Belegung am Arbeitspaket folgt dem Zeitraum (ganztägig, follow_task); Abwesenheit nur für sich selbst, Fremde sehen „abwesend“, Verfügbarkeit belegt', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const r0 = await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Fassade einrüsten', columnId: (await t.db.one(`select id from board_columns where project_id = $1 and name = 'Offen'`, [web()])).id, startDate: day(10), dueDate: day(12) });
  assert.equal(r0.statusCode, 200, r0.body); const task = r0.json().task;
  const r = await t.api(max).post(`/projects/${web()}/bookings`, { resourceId: scaffold.id, taskId: task.id, followTask: true });
  assert.equal(r.statusCode, 200, r.body); const b = r.json().booking;
  assert.equal(b.allDay, true); assert.equal(b.followTask, true); assert.equal(b.taskId, task.id); assert.equal(b.taskRef, `WEB-${task.number}`);
  const rng = dayRange(day(10), day(12)); assert.equal(b.startsAt, rng.starts.toISOString()); assert.equal(b.endsAt, rng.ends.toISOString());
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and body like 'Gerüst Nord gebucht %'`, [task.id]));
  assert.equal((await t.api(pl).patch(`/tasks/${task.id}`, { startDate: day(11), dueDate: day(14) })).statusCode, 200);
  const moved = (await t.api(pl).get(`/bookings?taskId=${task.id}`)).json().bookings[0];
  const rng2 = dayRange(day(11), day(14)); assert.equal(moved.startsAt, rng2.starts.toISOString()); assert.equal(moved.endsAt, rng2.ends.toISOString());
  assert.ok(await t.db.maybeOne(`select 1 from task_comments where task_id = $1 and body like '1 Belegung folgt dem neuen Zeitraum%'`, [task.id]));
  // Abwesenheit
  assert.equal((await t.api(max).post('/absences', { userId: t.ids.users.pl, startDate: day(20), dueDate: day(21) })).statusCode, 403, 'nur für sich selbst');
  const a = await t.api(max).post('/absences', { startDate: day(20), dueDate: day(21), title: 'Urlaub' });
  assert.equal(a.statusCode, 200, a.body); assert.equal(a.json().booking.kind, 'absence'); assert.equal(a.json().booking.title, 'Urlaub');
  assert.equal((await t.api(max).get('/me/absences')).json().absences.length, 1);
  const seen = (await t.api(pl).get(`/bookings?userId=${t.ids.users.max}`)).json().bookings.find((x: any) => x.kind === 'absence');
  assert.equal(seen.masked, true); assert.equal(seen.title, 'abwesend');
  const av = (await t.api(pl).get(`/availability?userId=${t.ids.users.max}&startsAt=${at(20, 9)}&endsAt=${at(20, 10)}`)).json();
  assert.equal(av.status, 'busy'); assert.equal(av.conflicts[0].title, 'abwesend');
  // Person im Projekt einplanen → Meldung booking.assigned
  const p = await t.api(pl).post(`/projects/${web()}/bookings`, { userId: t.ids.users.max, taskId: task.id, startDate: day(11), dueDate: day(11), title: 'Aufbau begleiten' });
  assert.equal(p.statusCode, 200, p.body);
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'booking.assigned'`, [t.ids.users.max]));
  // Worker: vorläufige Belegung, die bald beginnt
  await t.api(max).post(`/projects/${web()}/bookings`, { resourceId: beamer.id, startsAt: at(1, 9), endsAt: at(1, 10), title: 'Morgen' });
  assert.equal(await runUnconfirmedBookings(t.db), 1);
  assert.equal(await runUnconfirmedBookings(t.db), 0, 'einmal je Belegung');
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'booking.unconfirmed'`, [t.ids.users.max]));
});

test('Agent: book_resource immer vorläufig mit Frage confirm an den Ansprechpartner, Konflikt als Fehler ans Modell; create_event mit Ressource und Teilnehmern; Bestätigung über die Frage', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const p = (await t.api(admin).post('/ai/profiles', { name: 'Qwen', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'qwen' })).json().profile;
  await t.api(admin).put('/ai/settings', { agentDailyBudget: 50 });
  const agent = (await t.api(admin).post('/agents', { name: 'Planer' })).json().agent;
  await t.api(pl).put(`/projects/${web()}/members/${agent.id}`, { role: 'member' });
  await t.api(pl).put(`/projects/${web()}/agent-policy`, { mode: 'auto' });
  const task = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Elektroinstallation planen', columnId: (await t.db.one(`select id from board_columns where project_id = $1 and name = 'Offen'`, [web()])).id, responsibleUserId: agent.id })).json().task;
  await flushAgentRuns();
  const agentRow = { id: agent.id, name: agent.name, org_id: t.ids.org, persona: null };
  nextActions = [{ type: 'book_resource', resource: 'Gerüst Nord', startDate: day(30), dueDate: day(32), text: 'für die Fassade' }, { type: 'book_resource', resource: 'Besprechungsraum Nord', startsAt: `${day(3)}T11:30`, endsAt: `${day(3)}T12:30` }, { type: 'book_resource', resource: 'Kran', startDate: day(30), dueDate: day(30) }];
  const run = await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow, task.id, 'manual');
  assert.equal(run.actions.filter((a: any) => a.type === 'book_resource').length, 1, run.error ?? '');
  assert.match(run.error ?? '', /Besprechungsraum Nord“: belegt am/); assert.match(run.error ?? '', /Kran“ nicht in der Liste/);
  assert.ok(prompts.at(-1)!.includes('Ressourcen (Projekt und Pool') && prompts.at(-1)!.includes('Gerüst Nord (Gerüst)'), 'Ressourcen im Prompt');
  const b = await t.db.one(`select * from resource_bookings where task_id = $1`, [task.id]);
  assert.equal(b.tentative, true); assert.equal(b.all_day, true); assert.equal(b.created_by, agent.id);
  const q = await t.db.one(`select * from questions where booking_id = $1 and status = 'open'`, [b.id]);
  assert.equal(q.kind, 'confirm'); assert.equal(q.addressee_id, t.ids.users.pl, 'Stufe 0 = PL');
  // Antwort auf die Frage bestätigt die Belegung
  const r = await t.api(pl).post(`/questions/${q.id}/answer`, { option: 'confirm' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await t.db.one(`select tentative from resource_bookings where id = $1`, [b.id])).tentative, false);
  // Belegungen dieses AP im nächsten Prompt; create_event mit Ressource und Teilnehmer
  nextActions = [{ type: 'create_event', title: 'Abstimmung Elektro', startsAt: `${day(9)}T14:00`, endsAt: `${day(9)}T15:00`, resources: ['Besprechungsraum Nord'], attendees: ['max@demo.local'] }];
  const run2 = await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow, task.id, 'manual');
  assert.equal(run2.status, 'ok', run2.error ?? '');
  assert.ok(prompts.at(-1)!.includes('Belegungen dieses Arbeitspakets: Gerüst Nord'));
  const ev = await t.db.one(`select * from meetings where project_id = $1 and title = 'Abstimmung Elektro'`, [web()]);
  assert.equal(ev.tentative, true); assert.equal(ev.location, 'Besprechungsraum Nord');
  const emails = (ev.attendees as any[]).map((a) => a.email).sort();
  assert.deepEqual(emails, ['max@demo.local', 'pl@demo.local'], 'Ansprechpartner und genannter Teilnehmer');
  const eb = await t.db.one(`select * from resource_bookings where meeting_id = $1`, [ev.id]);
  assert.equal(eb.tentative, true);
  assert.equal((await t.api(pl).post(`/meetings/${ev.id}/confirm`)).statusCode, 200);
  assert.equal((await t.db.one(`select tentative from resource_bookings where id = $1`, [eb.id])).tentative, false, 'Bestätigen bestätigt die Belegung mit');
  // Belegt-Zeit der PL enthält den KI-Termin (Teilnehmer) → Verfügbarkeit belegt
  assert.equal((await t.api(pl).get(`/availability?userId=${t.ids.users.pl}&startsAt=${new Date(ev.starts_at).toISOString()}&endsAt=${new Date(ev.ends_at).toISOString()}`)).json().status, 'busy');
});

test('ICS: Ressourcen-Feed maskiert, Gesamt-Feed mit eigenen Abwesenheiten', async () => {
  const max = await t.login('max@demo.local');
  const tok = (await t.api(max).post('/me/ics-token')).json().token;
  const own = await t.api(max).get(`/ics/${tok}/ressource/${room.id}.ics`);
  assert.equal(own.statusCode, 200); assert.match(own.body, /SUMMARY:WEB Kickoff/);
  const tokA = (await t.api(fremd).post('/me/ics-token')).json().token;
  const foreign = await t.api(fremd).get(`/ics/${tokA}/ressource/${room.id}.ics`);
  assert.equal(foreign.statusCode, 200); assert.doesNotMatch(foreign.body, /Kickoff/); assert.match(foreign.body, /SUMMARY:belegt/);
  assert.equal((await t.api(fremd).get(`/ics/${tokA}/ressource/${scaffold.id}.ics`)).statusCode, 404, 'Projektressource nur für Mitglieder');
  const all = await t.api(max).get(`/ics/${tok}/alle.ics`);
  assert.match(all.body, /SUMMARY:Abwesend: Urlaub/);
  assert.match(all.body, /DTSTART;VALUE=DATE:\d{8}/);
});
