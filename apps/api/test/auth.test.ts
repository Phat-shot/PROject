import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';

const t = await testApp();
test.after(() => t.close());

test('Passwort vergessen: Mail über Org-Postfach, Link setzt neues Passwort und meldet an', async () => {
  const forgot = await t.app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'max@demo.local' } });
  assert.equal(forgot.statusCode, 200, forgot.body);
  assert.equal(forgot.json().sent, true);
  const sent = t.mail.dev.sent.filter((m) => m.msg.to.includes('max@demo.local'));
  assert.ok(sent.length >= 1, 'Mail an max verschickt');
  const link = String(sent[sent.length - 1].msg.text).match(/\/passwort\/([a-f0-9]+)/);
  assert.ok(link, 'Link in der Mail');
  const token = link![1];

  const info = await t.app.inject({ method: 'GET', url: `/api/auth/reset/${token}` });
  assert.equal(info.statusCode, 200);
  assert.equal(info.json().email, 'max@demo.local');

  const short = await t.app.inject({ method: 'POST', url: `/api/auth/reset/${token}`, payload: { password: 'kurz' } });
  assert.equal(short.statusCode, 400);

  const reset = await t.app.inject({ method: 'POST', url: `/api/auth/reset/${token}`, payload: { password: 'neuesPasswort123' } });
  assert.equal(reset.statusCode, 200, reset.body);
  assert.ok(reset.cookies.find((c) => c.name === 'pt_session'), 'angemeldet nach Reset');

  const again = await t.app.inject({ method: 'POST', url: `/api/auth/reset/${token}`, payload: { password: 'nochEinPasswort123' } });
  assert.equal(again.statusCode, 404, 'Token nur einmal gültig');

  const oldLogin = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'max@demo.local', password: 'demo1234' } });
  assert.equal(oldLogin.statusCode, 401);
  const newLogin = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'max@demo.local', password: 'neuesPasswort123' } });
  assert.equal(newLogin.statusCode, 200);
});

test('Passwort vergessen verrät nicht, ob die Adresse existiert', async () => {
  const r = await t.app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'niemand@demo.local' } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().sent, true);
});
