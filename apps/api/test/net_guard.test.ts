import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { isPublicAddress, outboundUrlError, resolver } from '../src/netGuard.js';

const t = await testApp();
test.after(() => t.close());

test('Ausgehende Ziele: interne Adressen gesperrt, auch als IPv4-mapped IPv6, Zahl, über DNS; Freigabe per OUTBOUND_ALLOW_HOSTS', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', 'fd00::1', 'fe80::1']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '2606:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
  for (const u of ['http://[::ffff:127.0.0.1]/', 'http://localhost:3000', 'http://2130706433/', 'http://0x7f.1/', 'ftp://example.com', 'http://u:p@example.com']) assert.ok(await outboundUrlError(u), u);
  const orig = resolver.lookup;
  resolver.lookup = async (h) => (h === 'rebind.example' ? ['93.184.216.34', '127.0.0.1'] : h === 'db' ? ['172.18.0.2'] : ['93.184.216.34']);
  try {
    assert.match(String(await outboundUrlError('https://rebind.example/')), /internen Netz/, 'eine interne Adresse genügt');
    assert.match(String(await outboundUrlError('http://db:5432/')), /internen Netz/);
    assert.equal(await outboundUrlError('https://public.example/cal'), null);
    process.env.OUTBOUND_ALLOW_HOSTS = 'db, 10.0.0.0/8, *.lan';
    assert.equal(await outboundUrlError('http://db:5432/'), null);
    assert.equal(await outboundUrlError('http://10.2.3.4/'), null);
    assert.equal(await outboundUrlError('http://nas.lan/'), null);
    assert.ok(await outboundUrlError('http://192.168.1.1/'));
  } finally { resolver.lookup = orig; delete process.env.OUTBOUND_ALLOW_HOSTS; }
});

test('Ausgehende Ziele: CalDAV, Mail-Server und eigenes LLM der PL nicht im internen Netz', async () => {
  const pl = await t.login('pl@demo.local');
  const caldav = await t.api(pl).put('/me/caldav', { url: 'http://169.254.169.254/latest/meta-data/', user: 'x', password: 'y' });
  assert.equal(caldav.statusCode, 400);
  assert.match(caldav.json().error, /internen Netz/);
  assert.equal((await t.db.one(`select caldav_url from users where email = 'pl@demo.local'`)).caldav_url, null, 'nicht gespeichert');
  const mail = await t.api(pl).post('/mail/accounts', { type: 'personal', name: 'Intern', address: 'intern@example.com', imapHost: '10.0.0.5', smtpHost: 'smtp.example.com', imapPassword: 'a', smtpPassword: 'b' });
  assert.equal(mail.statusCode, 400);
  const probe = await t.api(pl).post('/mail/accounts/test', { imapHost: 'smtp.example.com', smtpHost: '[::ffff:127.0.0.1]', imapPassword: 'a' });
  assert.equal(probe.statusCode, 400);
  const admin = await t.login('admin@demo.local');
  await t.api(admin).put('/ai/settings', { ownLlm: 'all' });
  const llm = await t.api(pl).post(`/projects/${t.ids.projects.web}/llms`, { name: 'Metadaten', provider: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'x' });
  assert.equal(llm.statusCode, 400, llm.body);
  await t.api(admin).put('/ai/settings', { ownLlm: 'personal' });
});
