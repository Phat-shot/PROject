import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { testApp } from './helpers.js';
import { seedAllowed } from '../src/seed.js';
import { hashPassword, needsRehash, SCRYPT_N, verifyPassword } from '../src/auth.js';
import { resetRateLimit } from '../src/rateLimit.js';
import { sanitizeHtml } from '../src/docs/html.js';
import { pinnedFetch } from '../src/netGuard.js';
import { caldavProviderHint } from '../src/calendar/push.js';

const t = await testApp();
test.after(() => t.close());

test('Seed nur opt-in: SEED=true außerhalb der Produktion, sonst nie (mit Begründung fürs Log)', () => {
  assert.equal(seedAllowed({}).allowed, false, 'ohne SEED keine Demodaten');
  assert.equal(seedAllowed({ SEED: 'false' }).allowed, false);
  assert.equal(seedAllowed({ SEED: '1' }).allowed, false, 'nur das Wort true');
  assert.ok(seedAllowed({ SEED: '1' }).reason);
  assert.deepEqual(seedAllowed({ SEED: 'true', NODE_ENV: 'development' }), { allowed: true, reason: null });
  const prod = seedAllowed({ SEED: 'true', NODE_ENV: 'production' });
  assert.equal(prod.allowed, false, 'in Produktion verweigert');
  assert.match(String(prod.reason), /production/);
});

test('Rate-Limit je Konto: dieselbe E-Mail aus vielen Adressen wird nach 10 Versuchen gedrosselt, andere Konten nicht', async () => {
  resetRateLimit();
  let last = 0;
  for (let i = 0; i < 12; i++) {
    const r = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: i % 2 ? 'Max@demo.local' : 'max@demo.local', password: 'falsch' }, remoteAddress: `198.51.100.${i + 1}` });
    last = r.statusCode;
    if (i < 10) assert.equal(r.statusCode, 401, `Versuch ${i + 1}`);
  }
  assert.equal(last, 429, 'Konto gesperrt, obwohl jede Anfrage von einer anderen Adresse kam');
  const other = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'pl@demo.local', password: 'demo1234' }, remoteAddress: '198.51.100.50' });
  assert.equal(other.statusCode, 200, 'anderes Konto nicht betroffen');
  // Passwort vergessen zählt ebenfalls je Konto
  for (let i = 0; i < 10; i++) await t.app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'anna@demo.local' }, remoteAddress: `198.51.100.${100 + i}` });
  assert.equal((await t.app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'anna@demo.local' }, remoteAddress: '198.51.100.200' })).statusCode, 429);
  resetRateLimit();
});

test('Passwort-Hashes: scrypt2 mit Parametern im Hash, Altformat bleibt prüfbar und wird beim Login neu gehasht', async () => {
  const saved = process.env.PASSWORD_SCRYPT_N;
  delete process.env.PASSWORD_SCRYPT_N;
  try {
    const h = hashPassword('geheim-123');
    assert.match(h, new RegExp(`^scrypt2\\$${SCRYPT_N}\\$[0-9a-f]{32}\\$[0-9a-f]{128}$`));
    assert.equal(verifyPassword('geheim-123', h), true);
    assert.equal(verifyPassword('falsch', h), false);
    assert.equal(needsRehash(h), false);
    assert.equal(verifyPassword('x', 'kaputt'), false);
    assert.equal(verifyPassword('x', 'scrypt2$999$ab$cd'), false, 'unplausibles N');
  } finally { if (saved !== undefined) process.env.PASSWORD_SCRYPT_N = saved; }
  // Altformat (Node-Standard N=2^14) wie vor der Umstellung geschrieben
  const salt = 'abcdef0123456789abcdef0123456789';
  const legacy = `scrypt$${salt}$${scryptSync('altesPasswort1', salt, 64).toString('hex')}`;
  assert.equal(verifyPassword('altesPasswort1', legacy), true);
  assert.equal(needsRehash(legacy), true);
  await t.db.query(`update users set password_hash = $1 where email = 'leser@demo.local'`, [legacy]);
  const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'leser@demo.local', password: 'altesPasswort1' } });
  assert.equal(login.statusCode, 200, login.body);
  const row = await t.db.one(`select password_hash from users where email = 'leser@demo.local'`);
  assert.match(row.password_hash, /^scrypt2\$/, 'nach dem Login im neuen Format');
  assert.equal(needsRehash(row.password_hash), false);
  assert.equal(verifyPassword('altesPasswort1', row.password_hash), true);
});

test('Sanitizer: externe Bilder entfernt (Hinweis), data:image bleibt, target=_blank erzwingt rel, input/label fallen weg, Stile gefiltert', () => {
  const out = sanitizeHtml('<p><img src="https://tracker.example/p.gif" alt="x"><img src="/api/attachments/abc"><img src="data:image/png;base64,AAA"></p><a href="https://example.com" target="_blank" rel="opener">l</a><a href="/intern" target="_top">t</a><ul><li><label><input type="checkbox" checked>Punkt</label></li></ul><p style="color: red; background: url(x); position: fixed">s</p>');
  assert.ok(!out.includes('tracker.example/p.gif"') || !/<img[^>]*tracker/.test(out), 'kein externes img');
  assert.match(out, /\[externes Bild entfernt: tracker\.example\]/);
  assert.match(out, /<img src="\/api\/attachments\/abc"/);
  assert.match(out, /<img src="data:image\/png;base64,AAA"/);
  assert.match(out, /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">l<\/a>/);
  assert.match(out, /<a href="\/intern">t<\/a>/, 'nur _blank als target');
  assert.ok(!/<input|<label/.test(out));
  assert.ok(out.includes('Punkt'));
  assert.match(out, /style="color:\s*red"/);
  assert.ok(!/position|url\(/.test(out));
  assert.equal(sanitizeHtml('<img src="//evil.example/x.png">').includes('src='), false, 'kein protokoll-relatives Bild');
});

test('SearXNG-Adresse wird beim Speichern und vor dem Aufruf geprüft; pinnedFetch folgt keiner Weiterleitung', async () => {
  const admin = await t.login('admin@demo.local');
  const internal = await t.api(admin).put('/ai/settings', { web: { provider: 'searxng', url: 'http://127.0.0.1:8080' } });
  assert.equal(internal.statusCode, 400, internal.body);
  assert.match(internal.json().error, /internen Netz/);
  const ok = await t.api(admin).put('/ai/settings', { web: { provider: 'searxng', url: 'http://searx.example/' } });
  assert.equal(ok.statusCode, 200, ok.body);
  const seen: RequestInit[] = [];
  const redirecting: typeof fetch = async (_u, init) => { seen.push(init ?? {}); return new Response('', { status: 302, headers: { location: 'http://10.0.0.5/admin' } }); };
  await assert.rejects(pinnedFetch(redirecting, 'http://llm.example/v1/chat/completions', { method: 'POST' }, 'Lokales LLM'), /leitet weiter.*10\.0\.0\.5/);
  assert.equal(seen[0]?.redirect, 'manual');
  await assert.rejects(pinnedFetch(redirecting, 'http://169.254.169.254/latest', {}, 'Ziel'), /internen Netz/);
  assert.equal(seen.length, 1, 'gesperrtes Ziel wird gar nicht erst angefragt');
});

test('CalDAV: Google und Microsoft 365 nehmen kein App-Passwort – Hinweis statt Netzaufruf und Speichern', async () => {
  assert.match(String(caldavProviderHint('https://apidata.googleusercontent.com/caldav/v2/x/events')), /Mit Google verbinden/);
  assert.match(String(caldavProviderHint('https://www.google.com/calendar/dav/x/events')), /Google/);
  assert.match(String(caldavProviderHint('https://outlook.office365.com/owa/calendar')), /Microsoft 365 verbinden/);
  assert.equal(caldavProviderHint('https://nextcloud.example/remote.php/dav/calendars/p/personal/'), null);
  const pl = await t.login('pl@demo.local');
  const r = await t.api(pl).put('/me/caldav', { url: 'https://apidata.googleusercontent.com/caldav/v2/me/events', user: 'me', password: 'app-pw' });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /Mit Google verbinden/);
  assert.equal((await t.db.one(`select caldav_url from users where id = $1`, [t.ids.users.pl])).caldav_url, null, 'nicht gespeichert');
});

test('Dev-Routen: nur Konten und Versand der eigenen Org', async () => {
  const org2 = await t.db.one(`insert into orgs (name) values ('Fremde GmbH') returning id`);
  const acc = await t.db.one(`insert into mail_accounts (org_id, type, name, address, provider) values ($1,'org','Fremd','fremd@other.local','dev') returning id`, [org2.id]);
  const pl = await t.login('pl@demo.local');
  const inject = await t.api(pl).post('/dev/mail/inject', { accountId: acc.id, from: 'a@b.c', subject: 'x' });
  assert.equal(inject.statusCode, 404, 'fremdes Dev-Konto unsichtbar');
  const sent = await t.api(pl).get('/dev/mail/sent');
  assert.equal(sent.statusCode, 200);
  assert.ok(sent.json().sent.every((s: any) => s.accountId !== acc.id));
});

test('Passwort vergessen: Versandfehler wird geloggt, die Antwort nennt keine internen Details', async () => {
  const orig = t.mail.sendFromAccount;
  (t.mail as any).sendFromAccount = async () => { throw new Error('connect ECONNREFUSED smtp.intern.lan:587'); };
  try {
    const r = await t.app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'anna@demo.local' } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().sent, false);
    assert.ok(!/ECONNREFUSED|smtp\.intern/.test(r.body), r.body);
    assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'user.password_reset_mail_failed'`), 'im Audit');
  } finally { (t.mail as any).sendFromAccount = orig; }
});

test('CSP: Bilder nur eigene, data: und blob:', async () => {
  const h = await t.app.inject({ method: 'GET', url: '/api/health' });
  const csp = String(h.headers['content-security-policy']);
  assert.match(csp, /img-src 'self' data: blob:;/);
  assert.ok(!/img-src[^;]*https?:/.test(csp));
});
