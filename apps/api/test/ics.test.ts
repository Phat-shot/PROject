import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';

const t = await testApp();
test.after(() => t.close());

test('Kalender-Abo: Token erzeugen, ICS-Feed mit Arbeitspaketen und Meilensteinen, ungültiges Token 404', async () => {
  const pl = await t.login('pl@demo.local');
  assert.equal((await t.api(pl).get('/me/ics-token')).json().token, null);
  const r = await t.api(pl).post('/me/ics-token');
  assert.equal(r.statusCode, 200);
  const token = r.json().token;
  const all = await t.app.inject({ method: 'GET', url: `/api/ics/${token}/alle.ics` });
  assert.equal(all.statusCode, 200, all.body);
  assert.match(all.headers['content-type'] as string, /text\/calendar/);
  assert.match(all.body, /BEGIN:VCALENDAR/);
  assert.match(all.body, /SUMMARY:WEB-\d+ /);
  assert.match(all.body, /SUMMARY:◆ WEB Design-Freigabe/);
  const one = await t.app.inject({ method: 'GET', url: `/api/ics/${token}/projekt/${t.ids.projects.web}.ics` });
  assert.equal(one.statusCode, 200);
  assert.ok(!one.body.includes('ERP-'), 'nur das eine Projekt');
  assert.equal((await t.app.inject({ method: 'GET', url: '/api/ics/falsch/alle.ics' })).statusCode, 404);
  const rotated = (await t.api(pl).post('/me/ics-token')).json().token;
  assert.equal((await t.app.inject({ method: 'GET', url: `/api/ics/${token}/alle.ics` })).statusCode, 404, 'altes Token ungültig');
  assert.equal((await t.app.inject({ method: 'GET', url: `/api/ics/${rotated}/alle.ics` })).statusCode, 200);
});
