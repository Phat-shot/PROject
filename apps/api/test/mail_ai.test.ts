import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { flushAgentRuns } from '../src/ai/agentEvents.js';

/** Lokales LLM: Mail-Läufe liefern `mailNext`, Arbeitspaket-Läufe keine Aktion. */
const calls: any[] = [];
let mailNext: any[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (String(input) !== 'http://llm.local:8000/v1/chat/completions') return new Response('{}', { status: 404 });
  calls.push(body);
  const system = body.messages?.[0]?.content ?? '';
  const content = !body.response_format ? 'bereit' : system.includes('# Mail bearbeiten') ? JSON.stringify({ summary: 'Angebot einholen, Besichtigung eingetragen.', actions: mailNext }) : JSON.stringify({ note: 'nichts', actions: [{ type: 'none', reason: 'Test' }] });
  return new Response(JSON.stringify({ model: 'qwen', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
};
delete process.env.ANTHROPIC_API_KEY;
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());

const M = (x: Record<string, unknown>) => ({ type: 'none', title: null, text: null, ref: null, subproject: null, responsible: null, startDate: null, dueDate: null, items: null, startsAt: null, endsAt: null, location: null, folder: null, reason: null, ...x });
const web = () => t.ids.projects.web;
let agent: any;
let kiView = '';
const inject = async (x: Record<string, unknown>) => { t.mail.dev.inject(t.ids.accounts.project, { from: { address: 'handwerker@extern.de', name: 'Elektro Kurz' }, to: ['projekt-web@demo.local'], ...x } as any); await t.mail.syncAccount(t.ids.accounts.project); await flushAgentRuns(); };

test('Ordner „KI Bearbeiten“ einrichten: nur mit Projekt-KI, Projektkonto nur durch die PL', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  assert.equal((await t.api(pl).post(`/projects/${web()}/mail/ai-folder`, { accountId: t.ids.accounts.project })).statusCode, 400, 'ohne Projekt-KI');
  const p = (await t.api(admin).post('/ai/profiles', { name: 'Qwen', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'qwen' })).json().profile;
  await t.api(admin).put('/ai/settings', { defaultProfileId: p.id, agentDailyBudget: 50 });
  await t.api(pl).patch(`/projects/${web()}`, { aiProfileId: p.id });
  agent = (await t.api(admin).post('/agents', { name: 'Morton' })).json().agent;
  await t.api(pl).put(`/projects/${web()}/members/${agent.id}`, { role: 'member' });
  assert.equal((await t.api(max).post(`/projects/${web()}/mail/ai-folder`, { accountId: t.ids.accounts.project })).statusCode, 403);
  const r = await t.api(pl).post(`/projects/${web()}/mail/ai-folder`, { accountId: t.ids.accounts.project });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().view.aiProcess, true);
  assert.deepEqual(r.json().view.filter.folders, ['KI Bearbeiten']);
  kiView = r.json().view.id;
  assert.equal((await t.api(admin).patch(`/mail/views/${kiView}`, { aiProcess: false })).statusCode, 403, 'Org-Admin schaltet die Mail-KI eines Projekts nicht');
});

test('Projekt-KI bearbeitet Mails im Ordner direkt: AP mit Ursprungsmail und Agent, Termin, Antwortentwurf, Ablage; einmal je Mail', async () => {
  const pl = await t.login('pl@demo.local');
  mailNext = [
    M({ type: 'create_ap', title: 'Angebot Elektrik einholen', text: 'Angebot für die Elektrik im Gästezimmer bis 20.11.', dueDate: '2026-11-20', responsible: agent.email, items: ['Drei Angebote anfragen', 'Vergleich'] }),
    M({ type: 'create_event', title: 'Besichtigung Elektro Kurz', startsAt: '2026-11-05T14:00', location: 'Gästezimmer' }),
    M({ type: 'reply_draft', text: 'Guten Tag,\n\ndanke, der Termin am 5.11. um 14 Uhr passt.\n\nViele Grüße' }),
    M({ type: 'move', folder: 'In Arbeit' })
  ];
  await inject({ subject: 'Besichtigung und Angebot', text: 'Wir können am 5.11. um 14 Uhr vorbeikommen.', folder: 'KI Bearbeiten' });
  const mail = await t.db.one(`select * from mails where subject = 'Besichtigung und Angebot'`);
  const unions = (o: any): number => !o || typeof o !== 'object' ? 0 : (Array.isArray(o.type) || o.anyOf ? 1 : 0) + Object.values(o).reduce((n: number, v) => n + unions(v), 0);
  assert.equal(unions(calls.find((c) => c.messages[0].content.includes('# Mail bearbeiten')).response_format.json_schema.schema), 0, 'keine Union-Typen im Schema');
  const run = await t.db.one(`select * from mail_ai_runs where mail_id = $1`, [mail.id]);
  assert.equal(run.status, 'ok', run.error ?? '');
  assert.equal(run.mode, 'process');
  assert.equal(run.actor_user_id, t.ids.users.pl);
  const task = await t.db.one(`select t.*, l.origin, l.copied from tasks t join mail_task_links l on l.task_id = t.id where l.mail_id = $1`, [mail.id]);
  assert.equal(task.title, 'Angebot Elektrik einholen');
  assert.equal(task.responsible_user_id, agent.id, 'direkt dem Agenten zugewiesen');
  assert.equal(task.origin, true);
  assert.equal(task.copied, true);
  assert.equal((await t.db.one(`select count(*)::int as c from checklist_items where task_id = $1`, [task.id])).c, 2);
  assert.ok(await t.db.maybeOne(`select 1 from meetings m join meeting_tasks mt on mt.meeting_id = m.id where m.title = 'Besichtigung Elektro Kurz' and mt.task_id = $1`, [task.id]));
  const draft = await t.db.one(`select * from mail_drafts where in_reply_to = $1`, [mail.message_id]);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.user_id, t.ids.users.pl);
  assert.equal(draft.task_id, task.id);
  assert.equal((await t.db.one(`select folder from mails where id = $1`, [mail.id])).folder, 'In Arbeit');
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'mail.ai'`, [t.ids.users.pl]));
  assert.ok(await t.db.maybeOne(`select 1 from agent_runs where task_id = $1 and agent_user_id = $2`, [task.id, agent.id]), 'Agent legt sofort los');
  // Kein zweiter Lauf
  await t.mail.syncAccount(t.ids.accounts.project);
  assert.equal((await t.db.one(`select count(*)::int as c from mail_ai_runs where mail_id = $1`, [mail.id])).c, 1);
  assert.equal((await t.api(pl).post(`/mail/mails/${mail.id}/ai-process`, { projectId: web() })).statusCode, 400);
  const view = (await t.api(pl).get(`/mail/mails/${mail.id}/ai`)).json().runs;
  assert.equal(view[0].actions.length, 4);
  assert.ok(view[0].actions.every((a: any) => a.status === 'done'));
});

test('„KI bearbeiten“ an einer Mail, Tagesbudget hält Läufe zurück', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  mailNext = [M({ type: 'none', reason: 'nur Info' }), M({ type: 'move', folder: 'Archiv' })];
  await inject({ subject: 'Zur Info', text: 'Nur zur Kenntnis.' });
  const info = (await t.api(pl).get(`/mail/views/${t.ids.views.project}/mails`)).json().mails.find((m: any) => m.subject === 'Zur Info');
  assert.equal((await t.api(pl).post(`/mail/mails/${info.id}/ai-process`, { projectId: web() })).statusCode, 200);
  await flushAgentRuns();
  const row = await t.db.one(`select m.folder, r.status from mails m join mail_ai_runs r on r.mail_id = m.id where m.id = $1`, [info.id]);
  assert.equal(row.status, 'ok');
  assert.match(row.folder, /^Archiv/);
  await t.api(admin).put('/ai/settings', { agentDailyBudget: 1 });
  await inject({ subject: 'Noch eine', text: 'x', folder: 'KI Bearbeiten' });
  const waiting = await t.db.one(`select r.status, r.error from mail_ai_runs r join mails m on m.id = r.mail_id where m.subject = 'Noch eine'`);
  assert.equal(waiting.status, 'queued');
  assert.match(waiting.error, /Tagesbudget/);
  await t.api(admin).put('/ai/settings', { agentDailyBudget: 50 });
});

test('Agent betreut eine Ansicht: Vorschläge, Freigabe mit einem Klick und den Rechten der freigebenden Person', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const leser = await t.login('leser@demo.local');
  assert.equal((await t.api(max).patch(`/mail/views/${t.ids.views.project}`, { agentUserId: agent.id })).statusCode, 403);
  assert.equal((await t.api(pl).patch(`/mail/views/${t.ids.views.project}`, { agentUserId: t.ids.users.max })).statusCode, 400, 'nur Agenten');
  assert.equal((await t.api(pl).patch(`/mail/views/${t.ids.views.project}`, { agentUserId: agent.id })).statusCode, 200);
  mailNext = [
    M({ type: 'create_ap', title: 'Rückruf Kunde', responsible: agent.email }),
    M({ type: 'create_ap', title: 'Rechnung prüfen' }),
    M({ type: 'reply_draft', text: 'Danke, wir melden uns.' })
  ];
  await inject({ subject: 'Bitte um Rückruf', text: 'Rufen Sie mich an.' });
  const mail = await t.db.one(`select * from mails where subject = 'Bitte um Rückruf'`);
  const run = await t.db.one(`select * from mail_ai_runs where mail_id = $1`, [mail.id]);
  assert.equal(run.mode, 'triage');
  assert.equal(await t.db.maybeOne(`select 1 from tasks where title = 'Rückruf Kunde'`), null, 'nichts direkt angelegt');
  const ar = await t.db.one(`select reasoning, actions from agent_runs where agent_user_id = $1 and trigger = 'mail_triage'`, [agent.id]);
  assert.ok(ar, 'zählt gegen das Budget des Agenten');
  assert.ok(!JSON.stringify(ar).includes('Rückruf'), 'kein Mailinhalt in den Agentenläufen (die alle Mitglieder sehen)');
  assert.equal((await t.api(leser).post(`/mail/ai-runs/${run.id}/decide`, { index: 0, approve: true })).statusCode, 403);
  const byMax = (await t.api(max).post(`/mail/ai-runs/${run.id}/decide`, { index: 0, approve: true })).json().runs[0];
  assert.equal(byMax.actions[0].status, 'error');
  assert.match(byMax.actions[0].result.error, /Agenten weist nur die Projektleitung zu/);
  await t.api(pl).post(`/mail/ai-runs/${run.id}/decide`, { index: 2, approve: false });
  const all = (await t.api(pl).post(`/mail/ai-runs/${run.id}/decide`, { index: 'all', approve: true })).json().runs[0];
  assert.deepEqual(all.actions.map((a: any) => a.status), ['approved', 'approved', 'rejected'], 'PL darf den Agenten zuweisen');
  assert.ok(await t.db.maybeOne(`select 1 from tasks where title = 'Rückruf Kunde' and responsible_user_id = $1`, [agent.id]));
  const created = await t.db.one(`select t.created_by, l.origin, l.copied from tasks t join mail_task_links l on l.task_id = t.id where t.title = 'Rechnung prüfen'`);
  assert.equal(created.created_by, t.ids.users.pl);
  assert.equal(created.origin, true);
  assert.equal(created.copied, false, 'Vorschläge verknüpfen nur');
  // Antworten auf Nachfragen (Plus-Adresse) gehen am Agenten vorbei
  const t4 = await t.db.one(`select mail_code from tasks where id = $1`, [t.ids.tasks.t4]);
  await inject({ subject: 'Re: Stand', text: 'Erledigt.', to: [`projekt-web+t${t4.mail_code}@demo.local`] });
  const auto = await t.db.one(`select id from mails where subject = 'Re: Stand'`);
  assert.equal(await t.db.maybeOne(`select 1 from mail_ai_runs where mail_id = $1`, [auto.id]), null);
  // Persönliches Konto (Hosting-Ansicht der PL, Max liest mit): Vorschläge nimmt nur die Eigentümerin an
  assert.equal((await t.api(max).patch(`/mail/views/${t.ids.views.hosting}`, { agentUserId: agent.id })).statusCode, 403);
  assert.equal((await t.api(pl).patch(`/mail/views/${t.ids.views.hosting}`, { agentUserId: agent.id })).statusCode, 200);
  mailNext = [M({ type: 'create_ap', title: 'Hosting kündigen prüfen' })];
  t.mail.dev.inject(t.ids.accounts.personal, { from: { address: 'support@hosting-partner.de', name: 'Hosting' }, to: ['pl@demo.local'], subject: 'Kündigungsfrist', text: 'Vertrag endet am 31.12.' } as any);
  await t.mail.syncAccount(t.ids.accounts.personal);
  await flushAgentRuns();
  const hr = await t.db.one(`select r.id from mail_ai_runs r join mails m on m.id = r.mail_id where m.subject = 'Kündigungsfrist'`);
  const byMax2 = (await t.api(max).post(`/mail/ai-runs/${hr.id}/decide`, { index: 0, approve: true })).json().runs[0];
  assert.match(byMax2.actions[0].result.error, /nur der Eigentümer/);
  assert.equal((await t.api(pl).post(`/mail/ai-runs/${hr.id}/decide`, { index: 0, approve: true })).json().runs[0].actions[0].status, 'approved');
  // Liste im Projekt: Leser sieht nur Läufe zu Mails, die er lesen darf
  assert.ok((await t.api(pl).get(`/projects/${web()}/mail-ai`)).json().runs.length >= 3);
});
