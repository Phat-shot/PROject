import test from 'node:test';
import assert from 'node:assert/strict';
import { composeEcho, testApp } from './helpers.js';
import { flushAgentRuns } from '../src/ai/agentEvents.js';

/** Lokales LLM: Arbeitspaket-Läufe liefern `next`, freie Texte (finale Antwort) einen festen Text. */
const calls: any[] = [];
/** Prompts der Neuformulierung nach außen */
const composes: string[] = [];
let next: any[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (String(input) !== 'http://llm.local:8000/v1/chat/completions') return new Response('{}', { status: 404 });
  const echo = composeEcho(body);
  if (echo) { composes.push(String(body.messages.at(-1).content)); return echo; }
  calls.push(body);
  const content = body.response_format ? JSON.stringify({ note: 'Abschluss', actions: next }) : 'Guten Tag,\n\ndas Angebot ist geprüft und freigegeben.\n\nViele Grüße\nPetra Lenz';
  return new Response(JSON.stringify({ model: 'qwen', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
};
delete process.env.ANTHROPIC_API_KEY;
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());

const A = (x: Record<string, unknown>) => ({ type: 'none', text: null, column: null, itemId: null, to: null, subject: null, reason: null, kind: null, checkAfterHours: null, until: null, remindAfterHours: null, escalateAfterHours: null, pageId: null, title: null, folder: null, status: null, ref: null, responsible: null, startDate: null, dueDate: null, subproject: null, items: null, startsAt: null, endsAt: null, location: null, ...x });
const mailsOf = async (c: any, viewId: string) => (await t.api(c).get(`/mail/views/${viewId}/mails`)).json().mails as any[];
let taskId = '';
let gfMail: any;

test('Ursprungsmail: beim Anlegen markiert, Sprung Mail ↔ Arbeitspaket, Links nur soweit sichtbar', async () => {
  const pl = await t.login('pl@demo.local');
  const leser = await t.login('leser@demo.local');
  gfMail = (await mailsOf(pl, t.ids.views.project)).find((m) => m.fromAddr === 'gf@demo.local');
  const r = await t.api(pl).post(`/mail/mails/${gfMail.id}/create-task`, { projectId: t.ids.projects.web, title: 'Angebot prüfen' });
  assert.equal(r.statusCode, 200, r.body);
  taskId = r.json().task.id;
  const d = (await t.api(pl).get(`/tasks/${taskId}`)).json();
  assert.equal(d.mails[0].origin, true);
  assert.equal(d.mails[0].answered, false);
  // Auch mit einem ERP-Arbeitspaket verknüpft: Lea (nur WEB) sieht diesen Link nicht
  const erpTask = (await t.api(await t.login('anna@demo.local')).post(`/projects/${t.ids.projects.erp}/tasks`, { title: 'ERP-Bezug' })).json().task;
  assert.equal((await t.api(pl).post(`/mail/mails/${gfMail.id}/link`, { taskId: erpTask.id })).statusCode, 200);
  const forPl = (await t.api(pl).get(`/mail/mails/${gfMail.id}`)).json().links;
  assert.equal(forPl.length, 2);
  assert.equal(forPl[0].origin, true);
  assert.match(forPl[0].code, /^WEB-\d+$/);
  const forLea = (await t.api(leser).get(`/mail/mails/${gfMail.id}`)).json().links;
  assert.deepEqual(forLea.map((l: any) => l.taskId), [taskId]);
  // Markierung umschalten; ausgehende Mails sind nie Ursprung
  assert.equal((await t.api(pl).post(`/tasks/${taskId}/mails/${gfMail.id}/origin`, { origin: false })).statusCode, 200);
  assert.equal((await t.api(pl).get(`/tasks/${taskId}`)).json().mails[0].origin, false);
  await t.api(pl).post(`/tasks/${taskId}/mails/${gfMail.id}/origin`, { origin: true });
  assert.equal((await t.api(leser).post(`/tasks/${taskId}/mails/${gfMail.id}/origin`, { origin: false })).statusCode, 403);
});

test('Finale Antwort: aufbereitetes Ergebnis statt Log, an den Absender, als Antwort im Thread; kein Log-Eintrag', async () => {
  const pl = await t.login('pl@demo.local');
  const leser = await t.login('leser@demo.local');
  await t.api(pl).post(`/tasks/${taskId}/checklist`, { title: 'Preise verglichen' });
  const item = (await t.api(pl).get(`/tasks/${taskId}`)).json().task.checklist[0];
  await t.api(pl).patch(`/tasks/${taskId}/checklist/${item.id}`, { done: true });
  await t.api(pl).post(`/projects/${t.ids.projects.web}/tasks`, { title: 'Rückfrage Lieferzeit', parentId: taskId });
  const done = (await t.api(pl).get(`/projects/${t.ids.projects.web}`)).json().columns.find((c: any) => c.isDone);
  await t.api(pl).patch(`/tasks/${taskId}`, { columnId: done.id });
  assert.equal((await t.api(leser).get(`/tasks/${taskId}/final-reply`)).statusCode, 403);
  const r = (await t.api(pl).get(`/tasks/${taskId}/final-reply`)).json();
  assert.deepEqual(r.to, ['gf@demo.local']);
  assert.match(r.subject, /^Re: /);
  assert.equal(r.viewId, t.ids.views.project);
  assert.match(r.body, /„Angebot prüfen“ ist erledigt\./);
  assert.match(r.body, /Ergebnis:\n- Preise verglichen/);
  assert.match(r.body, /Noch offen:\n- Rückfrage Lieferzeit/);
  assert.doesNotMatch(r.body, /Status →|Log/);
  // Mit KI nur, wenn das Projekt eine KI hat
  assert.equal((await t.api(pl).get(`/tasks/${taskId}/final-reply?ai=1`)).statusCode, 400);
  const before = (await t.db.one(`select count(*)::int as c from task_comments where task_id = $1`, [taskId])).c;
  const sent = await t.api(pl).post('/mail/drafts', { viewId: r.viewId, projectId: t.ids.projects.web, taskId, to: r.to, subject: r.subject, body: r.body, inReplyTo: r.inReplyTo, send: true });
  assert.equal(sent.statusCode, 200, sent.body);
  const d = (await t.api(pl).get(`/tasks/${taskId}`)).json();
  assert.equal(d.mails.find((m: any) => m.id === gfMail.id).answered, true);
  assert.ok(d.mails.some((m: any) => m.outgoing && m.subject === r.subject), 'Antwort hängt als Mail am Arbeitspaket');
  assert.equal((await t.db.one(`select count(*)::int as c from task_comments where task_id = $1`, [taskId])).c, before, 'kein Log-Eintrag');
  assert.equal((await t.api(pl).get(`/tasks/${taskId}/final-reply`)).json().answered, true);
});

test('Agent: Antwort auf die Ursprungsmail aus deren Konto (Projektkonto direkt, persönliches Konto als Entwurf für den Eigentümer), freie Unterschrift', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const anna = await t.login('anna@demo.local');
  const p = (await t.api(admin).post('/ai/profiles', { name: 'Qwen', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'qwen' })).json().profile;
  await t.api(admin).put('/ai/settings', { agentDailyBudget: 50 });
  const agent = (await t.api(admin).post('/agents', { name: 'Morton' })).json().agent;
  assert.equal((await t.api(admin).patch(`/agents/${agent.id}`, { signature: 'x\n'.repeat(9) })).statusCode, 400);
  const sig = (await t.api(admin).patch(`/agents/${agent.id}`, { signature: 'Viele Grüße\nMorton\nAssistenz Website-Projekt' })).json().agent.signature;
  assert.equal(sig, 'Viele Grüße\nMorton\nAssistenz Website-Projekt');
  await t.api(pl).put(`/projects/${t.ids.projects.web}/members/${agent.id}`, { role: 'member', agentCanMail: true });

  // Projektkonto: neue Mail → Arbeitspaket, Agent antwortet direkt im Thread
  t.mail.dev.inject(t.ids.accounts.project, { from: { address: 'kunde@extern.de', name: 'Kunde' }, to: ['projekt-web@demo.local'], subject: 'Frage zum Zeitplan', text: 'Wann geht die neue Website online?', folder: 'INBOX' } as any);
  await t.mail.syncAccount(t.ids.accounts.project);
  const m1 = (await mailsOf(pl, t.ids.views.project)).find((m) => m.subject === 'Frage zum Zeitplan');
  const t1 = (await t.api(pl).post(`/mail/mails/${m1.id}/create-task`, { projectId: t.ids.projects.web })).json().task;
  // (ohne den Teilprojektnamen „Go-Live“: den prüft die Außengrenze auch, wenn der Externe ihn selbst nennt)
  next = [A({ type: 'reply_origin', text: 'Guten Tag,\n\ndie neue Website geht im März online.\n\nViele Grüße\nMorton' })];
  await t.api(pl).patch(`/tasks/${t1.id}`, { responsibleUserId: agent.id });
  await flushAgentRuns();
  assert.match(calls.at(-1).messages[0].content, /enden genau mit dieser Unterschrift:\nViele Grüße\nMorton\nAssistenz Website-Projekt/);
  assert.match(calls.at(-1).messages[1].content, /\[Ursprungsmail, noch nicht beantwortet\]/);
  const reply = await t.db.one(`select r.* from mails r join mails o on o.message_id = r.in_reply_to where o.id = $1 and r.outgoing`, [m1.id]);
  assert.equal(reply.subject, 'Re: Frage zum Zeitplan');
  assert.deepEqual(reply.to_json, ['kunde@extern.de']);
  // Zweite Antwort wird verworfen
  await t.api(pl).post(`/tasks/${t1.id}/agent-run?wait=1`);
  assert.match((await t.db.one(`select error from agent_runs where task_id = $1 order by created_at desc limit 1`, [t1.id])).error, /schon beantwortet/);

  // Persönliches Konto der PL (Hosting-Ansicht): Entwurf über die Ansicht, nur die Eigentümerin gibt frei; Inhalt nicht im Prompt
  const host = (await mailsOf(pl, t.ids.views.hosting))[0];
  const t2 = (await t.api(pl).post(`/mail/mails/${host.id}/create-task`, { projectId: t.ids.projects.web, confirmed: true })).json().task;
  next = [A({ type: 'reply_origin', text: 'Guten Tag,\n\ndie Verlängerung ist notiert.\n\nViele Grüße\nMorton' })];
  calls.length = 0;
  await t.api(pl).patch(`/tasks/${t2.id}`, { responsibleUserId: agent.id });
  await flushAgentRuns();
  assert.match(calls.at(-1).messages[1].content, /Inhalt aus einem persönlichen Konto, nicht freigegeben/);
  // Auch die Neuformulierung nach außen bekommt den Inhalt nicht (gleiche Regel wie im Agenten-Prompt)
  const composePrompt = composes.at(-1)!;
  assert.match(composePrompt, /von it@hosting-partner\.de: Vertragsverlängerung Hosting 2027 – \(Inhalt aus einem persönlichen Konto, nicht freigegeben\)/);
  assert.ok(!composePrompt.includes('Ihr Hostingvertrag'));
  const draft = await t.db.one(`select * from mail_drafts where task_id = $1`, [t2.id]);
  assert.equal(draft.status, 'pending_approval');
  assert.equal(draft.account_id, t.ids.accounts.personal);
  assert.equal(draft.view_id, t.ids.views.hosting);
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'draft.review' and created_at > now() - interval '1 minute'`, [t.ids.users.pl]));
  assert.ok(!(await t.api(anna).get(`/projects/${t.ids.projects.web}/mail/drafts`)).json().drafts.some((d: any) => d.id === draft.id), 'stellv. PL sieht den Entwurf aus dem persönlichen Konto nicht');
  assert.ok((await t.api(pl).get(`/projects/${t.ids.projects.web}/mail/drafts`)).json().drafts.some((d: any) => d.id === draft.id));
  assert.equal((await t.api(anna).post(`/mail/drafts/${draft.id}/send`)).statusCode, 403);
});
