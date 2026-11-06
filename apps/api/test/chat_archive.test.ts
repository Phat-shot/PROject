import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';

const t = await testApp();
test.after(() => t.close());

test('Chat archivieren je Person: ausgeblendet bis zur nächsten Nachricht, nur für die Person, wieder holbar', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const cid = (await t.api(pl).post('/chat/dm', { userId: t.ids.users.max })).json().channelId;
  assert.equal((await t.api(pl).post(`/chat/channels/${cid}/messages`, { body: 'Hallo Max' })).statusCode, 200);
  const conv = async (who: any) => (await t.api(who).get('/chat/conversations')).json().conversations.find((c: any) => c.channelId === cid);
  assert.equal((await conv(max)).unread, 1);
  assert.equal((await t.api(max).put(`/chat/channels/${cid}/archive`, { archived: true })).statusCode, 200);
  let c = await conv(max);
  assert.equal(c.archived, true);
  assert.equal(c.unread, 0, 'Archivieren gilt als gelesen');
  assert.equal((await conv(pl)).archived, false, 'nur für Max');
  // Neue Nachricht holt das Gespräch zurück
  await t.api(pl).post(`/chat/channels/${cid}/messages`, { body: 'Noch was' });
  c = await conv(max);
  assert.equal(c.archived, false);
  assert.equal(c.unread, 1);
  // Archivieren und von Hand zurückholen; Projektkanal ebenso
  await t.api(max).put(`/chat/channels/${cid}/archive`, { archived: true });
  await t.api(max).put(`/chat/channels/${cid}/archive`, { archived: false });
  assert.equal((await conv(max)).archived, false);
  const web = (await t.api(pl).get(`/projects/${t.ids.projects.web}/chat`)).json().channel.id;
  assert.equal((await t.api(pl).put(`/chat/channels/${web}/archive`, { archived: true })).statusCode, 200);
  assert.equal((await t.api(pl).get('/chat/conversations')).json().conversations.find((x: any) => x.channelId === web).archived, true);
  // Fremdes Gespräch: Anna ist keine Teilnehmerin der Direktnachricht von PL und Max
  const anna = await t.login('anna@demo.local');
  assert.equal((await t.api(anna).put(`/chat/channels/${cid}/archive`, { archived: true })).statusCode, 403);
});
