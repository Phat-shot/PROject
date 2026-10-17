import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';

const t = await testApp();
test.after(() => t.close());

test('Kontakt als externer Benutzer: mit Name und Mail angelegt, als zuständig gewählt, Name erscheint am Arbeitspaket', async () => {
  const pl = await t.login('pl@demo.local');
  const web = t.ids.projects.web;
  const c = await t.api(pl).post(`/projects/${web}/contacts`, { email: 'Ext@Firma.de', name: 'Erika Extern', organization: 'Firma GmbH' });
  assert.equal(c.statusCode, 200, c.body);
  assert.equal(c.json().contact.email, 'ext@firma.de');
  const created = (await t.api(pl).post(`/projects/${web}/tasks`, { title: 'Von Extern zu erledigen', responsibleEmail: 'ext@firma.de' })).json().task;
  assert.equal(created.responsibleUserId, null);
  assert.equal(created.responsible.email, 'ext@firma.de');
  assert.equal(created.responsible.name, 'Erika Extern', 'Name aus dem Kontakt');
  assert.equal(created.responsible.inherited, false);
  const list = (await t.api(pl).get(`/projects/${web}/tasks`)).json().tasks.find((x: any) => x.id === created.id);
  assert.equal(list.responsible.name, 'Erika Extern');
  // Unbekannte Adresse wird automatisch Kontakt (ohne Name)
  await t.api(pl).patch(`/tasks/${created.id}`, { responsibleEmail: 'neu@kunde.de' });
  const contacts = (await t.api(pl).get(`/projects/${web}/contacts`)).json().contacts;
  assert.ok(contacts.some((x: any) => x.email === 'neu@kunde.de' && x.name === null));
  assert.equal((await t.api(pl).get(`/tasks/${created.id}`)).json().task.responsible.name, null);
});
