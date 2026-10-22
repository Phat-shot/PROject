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

test('Kalender-Abo: Arbeitspakete und Meilensteine eingeschränkter Teilprojekte nur für Berechtigte, gelöschte nie', async () => {
  const pl = await t.login('pl@demo.local');
  const web = t.ids.projects.web;
  const sp = await t.api(pl).post(`/projects/${web}/subprojects`, { name: 'Geheim-ICS', restricted: true });
  assert.equal(sp.statusCode, 200, sp.body);
  const spId = sp.json().subproject.id;
  const task = await t.api(pl).post(`/projects/${web}/tasks`, { title: 'Geheimes Paket ICS', subprojectId: spId, dueDate: '2026-12-01' });
  assert.equal(task.statusCode, 200, task.body);
  const ms = await t.api(pl).post(`/projects/${web}/milestones`, { name: 'Geheimer Meilenstein ICS', date: '2026-12-02', subprojectId: spId });
  assert.equal(ms.statusCode, 200, ms.body);
  const gone = await t.api(pl).post(`/projects/${web}/tasks`, { title: 'Gelöschtes Paket ICS', dueDate: '2026-12-03' });
  await t.db.query(`update tasks set deleted_at = now() where id = $1`, [gone.json().task.id]);
  const feed = async (email: string) => {
    const s = await t.login(email);
    const token = (await t.api(s).post('/me/ics-token')).json().token;
    return (await t.app.inject({ method: 'GET', url: `/api/ics/${token}/alle.ics` })).body;
  };
  const member = await feed('max@demo.local');
  assert.ok(!member.includes('Geheimes Paket ICS') && !member.includes('Geheimer Meilenstein ICS'), 'ohne Teilprojekt-Zugriff nicht im Feed');
  assert.ok(!member.includes('Gelöschtes Paket ICS'));
  const own = await feed('pl@demo.local');
  assert.ok(own.includes('Geheimes Paket ICS') && own.includes('Geheimer Meilenstein ICS'), 'PL sieht das Teilprojekt');
  assert.ok(!own.includes('Gelöschtes Paket ICS'));
});
