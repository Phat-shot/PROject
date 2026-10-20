import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { seal } from '../src/secrets.js';

const calls: { url: string; method: string; body: string; auth: string }[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const h: any = init?.headers ?? {};
  calls.push({ url, method: init?.method ?? 'GET', body: String(init?.body ?? ''), auth: h.authorization ?? '' });
  if (url.startsWith('https://graph.microsoft.com/v1.0/me/events')) return new Response(JSON.stringify({ id: url.endsWith('/events') ? 'AAMk-neu' : url.split('/').pop() }), { status: url.endsWith('/events') ? 201 : 200, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://www.googleapis.com/calendar/v3/')) return new Response(JSON.stringify({ id: 'goog-1' }), { status: 200 });
  if (url.startsWith('https://login.microsoftonline.com/') && url.endsWith('/token')) return new Response(JSON.stringify({ access_token: 'at-fresh', refresh_token: 'rt', expires_in: 3600 }), { status: 200 });
  if (url.startsWith('https://dav.example/')) {
    if (h.authorization !== 'Basic ' + Buffer.from('petra:app-pw').toString('base64')) return new Response('', { status: 401 });
    if (init?.method === 'PROPFIND') return new Response('<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:propstat><d:prop><d:displayname>Privat</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>', { status: 207 });
    if (init?.method === 'PUT') return new Response('', { status: 201 });
  }
  return new Response('{}', { status: 404 });
};
process.env.OAUTH_MS_CLIENT_ID = 'cid'; process.env.OAUTH_MS_CLIENT_SECRET = 's'; process.env.PUBLIC_URL = 'https://project.example';
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());

test('Kalenderziele: ohne Einrichtung keine; CalDAV speichern prüft per PROPFIND, falsches Passwort wird gemeldet; Termin per CalDAV eintragen', async () => {
  const pl = await t.login('pl@demo.local');
  const pid = t.ids.projects.web;
  assert.deepEqual((await t.api(pl).get('/me/calendar-targets')).json().targets, []);
  const m = (await t.api(pl).post(`/projects/${pid}/meetings`, { title: 'Steuerkreis', startsAt: '2026-11-03T09:00:00.000Z', durationMinutes: 60, attendees: [{ email: 'gf@kunde.example' }] })).json().meeting;
  assert.equal((await t.api(pl).post(`/meetings/${m.id}/push`, { target: 'caldav' })).statusCode, 400);
  const bad = await t.api(pl).put('/me/caldav', { url: 'https://dav.example/cal/privat/', user: 'petra', password: 'falsch' });
  assert.equal(bad.json().ok, false);
  assert.match(bad.json().test.error, /Anmeldung abgelehnt/);
  const ok = await t.api(pl).put('/me/caldav', { url: 'https://dav.example/cal/privat/', user: 'petra', password: 'app-pw' });
  assert.equal(ok.json().ok, true, ok.body);
  assert.equal(ok.json().test.displayName, 'Privat');
  const row = await t.db.one(`select caldav_password from users where id = $1`, [t.ids.users.pl]);
  assert.match(row.caldav_password, /^enc1:/);
  const targets = (await t.api(pl).get('/me/calendar-targets')).json();
  assert.deepEqual(targets.targets.map((x: any) => x.key), ['caldav']);
  assert.equal(targets.caldav.user, 'petra');
  const push = await t.api(pl).post(`/meetings/${m.id}/push`, { target: 'caldav' });
  assert.equal(push.statusCode, 200, push.body);
  const put = calls.find((c) => c.method === 'PUT');
  assert.ok(put);
  assert.equal(put!.url, `https://dav.example/cal/privat/meeting-${m.id}%40project.ics`);
  assert.match(put!.body, /SUMMARY:WEB Steuerkreis/);
  assert.match(put!.body, /DTSTART:20261103T090000Z/);
  assert.match(put!.body, /ATTENDEE:mailto:gf@kunde\.example/);
  const ext = await t.db.one(`select external from meetings where id = $1`, [m.id]);
  assert.equal(ext.external[t.ids.users.pl].caldav, put!.url);
  const again = await t.api(pl).post(`/meetings/${m.id}/push`, { target: 'caldav' });
  assert.equal(again.json().updated, true);
  await t.api(pl).del('/me/caldav');
  assert.deepEqual((await t.api(pl).get('/me/calendar-targets')).json().targets, []);
});

test('Microsoft 365: persönliches Graph-Konto wird Kalenderziel, Termin anlegen dann aktualisieren (PATCH mit gemerkter Kennung), Token wird aufgefrischt', async () => {
  const pl = await t.login('pl@demo.local');
  const pid = t.ids.projects.web;
  await t.db.query(`insert into mail_accounts (org_id, type, owner_user_id, managed_user_id, name, address, provider, oauth_provider, oauth_access_token, oauth_refresh_token, oauth_expires_at) values ($1,'personal',$2,$2,'M365','petra@contoso.com','graph','microsoft',$3,$4, now() - interval '1 minute')`, [t.ids.org, t.ids.users.pl, seal('alt'), seal('rt')]);
  const targets = (await t.api(pl).get('/me/calendar-targets')).json().targets;
  assert.deepEqual(targets.map((x: any) => x.key), ['microsoft']);
  const m = (await t.api(pl).post(`/projects/${pid}/meetings`, { title: 'Review', startsAt: '2026-11-05T13:00:00.000Z', durationMinutes: 30, location: 'Raum 2' })).json().meeting;
  const n = calls.length;
  const r1 = await t.api(pl).post(`/meetings/${m.id}/push`, { target: 'microsoft' });
  assert.equal(r1.statusCode, 200, r1.body);
  assert.equal(r1.json().updated, false);
  const post = calls.slice(n).find((c) => c.url === 'https://graph.microsoft.com/v1.0/me/events');
  assert.ok(post && post.method === 'POST');
  assert.equal(post!.auth, 'Bearer at-fresh', 'abgelaufenes Token wurde erneuert');
  const body = JSON.parse(post!.body);
  assert.equal(body.subject, 'WEB Review');
  assert.equal(body.location.displayName, 'Raum 2');
  assert.equal(body.start.timeZone, 'UTC');
  const r2 = await t.api(pl).post(`/meetings/${m.id}/push`, { target: 'microsoft' });
  assert.equal(r2.json().updated, true);
  const patch = calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/me/events/AAMk-neu'));
  assert.ok(patch, 'Aktualisierung über die gemerkte Kennung');
  assert.equal((await t.api(pl).post(`/meetings/${m.id}/push`, { target: 'google' })).statusCode, 400, 'Google nicht verbunden');
});
