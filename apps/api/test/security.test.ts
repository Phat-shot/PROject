import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { isSealed, seal, unseal } from '../src/secrets.js';

const t = await testApp();
test.after(() => t.close());

test('Geheimnisse: seal/unseal rund, Klartext-Bestand bleibt lesbar, Mail-Passwörter liegen verschlüsselt und bleiben nutzbar', async () => {
  const s = seal('geheim')!;
  assert.ok(isSealed(s));
  assert.notEqual(s, 'geheim');
  assert.equal(unseal(s), 'geheim');
  assert.equal(unseal('klartext'), 'klartext');
  assert.equal(seal(s), s, 'nicht doppelt verpackt');
  assert.equal(seal(''), null);
  const pl = await t.login('pl@demo.local');
  const r = await t.api(pl).post('/mail/accounts', { type: 'personal', name: 'Test', address: 'pl-imap@example.com', imapHost: 'imap.example.com', smtpHost: 'smtp.example.com', imapPassword: 'pw-imap', smtpPassword: 'pw-smtp' });
  assert.equal(r.statusCode, 200, r.body);
  const row = await t.db.one(`select imap_password, smtp_password from mail_accounts where id = $1`, [r.json().account.id]);
  assert.ok(isSealed(row.imap_password) && isSealed(row.smtp_password));
  assert.equal(unseal(row.imap_password), 'pw-imap');
  assert.equal(r.json().account.hasImapPassword, true);
  assert.equal(JSON.stringify(r.json()).includes('pw-imap'), false);
  const u = await t.api(pl).patch(`/mail/accounts/${r.json().account.id}`, { imapPassword: 'neu', smtpPassword: '' });
  assert.equal(u.statusCode, 200, u.body);
  const row2 = await t.db.one(`select imap_password, smtp_password from mail_accounts where id = $1`, [r.json().account.id]);
  assert.equal(unseal(row2.imap_password), 'neu');
  assert.equal(unseal(row2.smtp_password), 'pw-smtp', 'leeres Feld = unverändert');
});

test('CSRF: ändernde Anfragen mit Sitzung und fremder Herkunft werden abgelehnt, eigene Herkunft und Lesen gehen', async () => {
  const pl = await t.login('pl@demo.local');
  const foreign = await t.app.inject({ method: 'POST', url: '/api/notifications/read', cookies: pl, headers: { origin: 'https://evil.example', host: 'project.example' }, payload: { all: true } });
  assert.equal(foreign.statusCode, 403);
  const viaReferer = await t.app.inject({ method: 'POST', url: '/api/notifications/read', cookies: pl, headers: { referer: 'https://evil.example/x', host: 'project.example' }, payload: { all: true } });
  assert.equal(viaReferer.statusCode, 403);
  const own = await t.app.inject({ method: 'POST', url: '/api/notifications/read', cookies: pl, headers: { origin: 'https://project.example', host: 'project.example' }, payload: { all: true } });
  assert.equal(own.statusCode, 200, own.body);
  const proxied = await t.app.inject({ method: 'POST', url: '/api/notifications/read', cookies: pl, headers: { origin: 'https://project.example', host: 'app:3000', 'x-forwarded-host': 'project.example' }, payload: { all: true } });
  assert.equal(proxied.statusCode, 200, 'hinter Traefik zählt X-Forwarded-Host');
  const read = await t.app.inject({ method: 'GET', url: '/api/auth/me', cookies: pl, headers: { origin: 'https://evil.example', host: 'project.example' } });
  assert.equal(read.statusCode, 200);
  const noSession = await t.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://evil.example', host: 'project.example' }, payload: { email: 'x@y.z', password: 'nein' } });
  assert.equal(noSession.statusCode, 401, 'ohne Sitzung keine CSRF-Prüfung, Login prüft selbst');
});

test('Upload: ausführbare Dateien abgelehnt, HTML nur als Download, normale Datei inline', async () => {
  const pl = await t.login('pl@demo.local');
  const taskId = t.ids.tasks.t2;
  const upload = async (filename: string, mime: string, content: string) => {
    const boundary = '----pt' + Math.random().toString(36).slice(2);
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n${content}\r\n--${boundary}--\r\n`;
    return t.app.inject({ method: 'POST', url: `/api/attachments?taskId=${taskId}`, cookies: pl, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
  };
  const exe = await upload('setup.exe', 'application/octet-stream', 'MZ');
  assert.equal(exe.statusCode, 400);
  assert.match(exe.json().error, /nicht erlaubt/);
  const js = await upload('x.js', 'text/javascript', 'alert(1)');
  assert.equal(js.statusCode, 400);
  const empty = await upload('leer.txt', 'text/plain', '');
  assert.equal(empty.statusCode, 400);
  const html = await upload('seite.html', 'text/html', '<script>alert(1)</script>');
  assert.equal(html.statusCode, 200, html.body);
  const htmlId = (html.json().attachment ?? html.json()).id;
  const dl = await t.app.inject({ method: 'GET', url: `/api/attachments/${htmlId}`, cookies: pl });
  assert.equal(dl.statusCode, 200);
  assert.match(String(dl.headers['content-disposition']), /^attachment/);
  assert.equal(dl.headers['x-content-type-options'], 'nosniff');
  const txt = await upload('notiz.txt', 'text/plain', 'Hallo');
  assert.equal(txt.statusCode, 200, txt.body);
  const dl2 = await t.app.inject({ method: 'GET', url: `/api/attachments/${(txt.json().attachment ?? txt.json()).id}`, cookies: pl });
  assert.match(String(dl2.headers['content-disposition']), /^inline/);
});
