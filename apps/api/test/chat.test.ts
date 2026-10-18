import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';

const t = await testApp();
test.after(() => t.close());

test('Projektchat: Nachrichten, Thread-Antworten, @Erwähnung benachrichtigt, Ungelesen-Zähler, Löschen durch PL', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const leser = await t.login('leser@demo.local');
  const web = t.ids.projects.web;
  const first = await t.api(pl).get(`/projects/${web}/chat`);
  assert.equal(first.statusCode, 200, first.body);
  const cid = first.json().channel.id;
  assert.deepEqual(first.json().messages, []);
  assert.equal((await t.api(max).get(`/projects/${web}/chat`)).json().channel.id, cid, 'ein Kanal je Projekt');
  const m1 = await t.api(pl).post(`/chat/channels/${cid}/messages`, { body: 'Hallo @Max Keller, Stand zum Design?' });
  assert.equal(m1.statusCode, 200, m1.body);
  assert.deepEqual(m1.json().message.mentions, [t.ids.users.max]);
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'chat.mention' and link = $2`, [t.ids.users.max, `/chat/${cid}`]));
  assert.equal((await t.api(max).get('/chat/unread')).json().projects[web], 1);
  assert.equal((await t.api(pl).get('/chat/unread')).json().total, 0, 'eigene Nachricht zählt nicht');
  // Antwort im Thread
  const r1 = await t.api(max).post(`/chat/channels/${cid}/messages`, { body: 'Design kommt Freitag.', threadId: m1.json().message.id });
  assert.equal(r1.json().message.threadId, m1.json().message.id);
  const r2 = await t.api(leser).post(`/chat/channels/${cid}/messages`, { body: 'Danke!', threadId: r1.json().message.id });
  assert.equal(r2.json().message.threadId, m1.json().message.id, 'Antwort auf Antwort landet im selben Thread');
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'chat.reply'`, [t.ids.users.pl]), 'Ersteller des Threads wird über Antworten informiert');
  const list = (await t.api(pl).get(`/projects/${web}/chat`)).json();
  assert.equal(list.messages.length, 1, 'Antworten erscheinen nicht auf oberster Ebene');
  assert.equal(list.messages[0].replyCount, 2);
  assert.equal(list.unread, 2, 'zwei fremde Nachrichten seit dem letzten Lesen');
  assert.equal((await t.api(pl).get('/chat/unread')).json().total, 0, 'Abruf des Kanals markiert als gelesen');
  const thread = (await t.api(pl).get(`/projects/${web}/chat?thread=${m1.json().message.id}`)).json();
  assert.deepEqual(thread.messages.map((x: any) => x.body), ['Design kommt Freitag.', 'Danke!']);
  // Rechte: Nicht-Mitglied kommt nicht rein; Löschen nur eigene oder als PL
  const anna = await t.login('anna@demo.local');
  const erp = t.ids.projects.erp;
  assert.equal((await t.api(leser).get(`/projects/${erp}/chat`)).statusCode, 403);
  assert.equal((await t.api(max).del(`/chat/messages/${m1.json().message.id}`)).statusCode, 403);
  assert.equal((await t.api(max).patch(`/chat/messages/${r1.json().message.id}`, { body: 'Design kommt Montag.' })).json().message.editedAt !== null, true);
  assert.equal((await t.api(pl).del(`/chat/messages/${r2.json().message.id}`)).statusCode, 200);
  assert.equal((await t.api(pl).get(`/projects/${web}/chat`)).json().messages[0].replyCount, 1);
  void anna;
});

test('Direktnachrichten: Gespräch anlegen oder wiederfinden, nur Teilnehmer lesen, Benachrichtigung und Ungelesen', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const leser = await t.login('leser@demo.local');
  const people = (await t.api(pl).get('/chat/people')).json().people;
  assert.ok(people.some((p: any) => p.id === t.ids.users.max));
  assert.ok(!people.some((p: any) => p.id === t.ids.users.pl), 'nicht man selbst');
  const d1 = await t.api(pl).post('/chat/dm', { userId: t.ids.users.max });
  assert.equal(d1.statusCode, 200, d1.body);
  const cid = d1.json().channelId;
  assert.equal((await t.api(max).post('/chat/dm', { userId: t.ids.users.pl })).json().channelId, cid, 'gleiches Gespräch von beiden Seiten');
  assert.equal((await t.api(pl).post('/chat/dm', { userId: t.ids.users.pl })).statusCode, 400);
  await t.api(pl).post(`/chat/channels/${cid}/messages`, { body: 'Kurze Frage zum Budget.' });
  assert.equal((await t.api(leser).get(`/chat/channels/${cid}/messages`)).statusCode, 403, 'kein Teilnehmer');
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'chat.dm' and link = $2`, [t.ids.users.max, `/chat/${cid}`]));
  const convs = (await t.api(max).get('/chat/dm')).json().conversations;
  assert.equal(convs.length, 1);
  assert.equal(convs[0].partner.id, t.ids.users.pl);
  assert.equal(convs[0].unread, 1);
  assert.equal((await t.api(max).get('/chat/unread')).json().dm, 1);
  const msgs = (await t.api(max).get(`/chat/channels/${cid}/messages`)).json();
  assert.equal(msgs.messages[0].body, 'Kurze Frage zum Budget.');
  assert.equal((await t.api(max).get('/chat/unread')).json().dm, 0);
});
