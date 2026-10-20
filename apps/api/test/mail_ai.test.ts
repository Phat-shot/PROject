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

const M = (x: Record<string, unknown>) => ({ type: 'none', title: null, text: null, ref: null, subproject: null, responsible: null, startDate: null, dueDate: null, items: null, startsAt: null, endsAt: null, location: null, attendees: null, folder: null, reason: null, ...x });
const web = () => t.ids.projects.web;
let agent: any;
let kiView = '';
const inject = async (x: Record<string, unknown>) => { t.mail.dev.inject(t.ids.accounts.project, { from: { address: 'handwerker@extern.de', name: 'Elektro Kurz' }, to: ['projekt-web@demo.local'], ...x } as any); await t.mail.syncAccount(t.ids.accounts.project); await flushAgentRuns(); };

test('Ordner „KI Bearbeiten“ einrichten: nur mit Agent, Projektkonto nur durch die PL', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  assert.equal((await t.api(pl).post(`/projects/${web()}/mail/ai-folder`, { accountId: t.ids.accounts.project })).statusCode, 400, 'ohne Agent');
  const p = (await t.api(admin).post('/ai/profiles', { name: 'Qwen', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'qwen' })).json().profile;
  await t.api(admin).put('/ai/settings', { defaultProfileId: p.id, agentDailyBudget: 50 });
  await t.api(pl).patch(`/projects/${web()}`, { aiProfileId: p.id });
  agent = (await t.api(admin).post('/agents', { name: 'Morton' })).json().agent;
  await t.api(pl).put(`/projects/${web()}/members/${agent.id}`, { role: 'member' });
  assert.equal((await t.api(max).post(`/projects/${web()}/mail/ai-folder`, { accountId: t.ids.accounts.project })).statusCode, 403);
  assert.equal((await t.api(pl).post(`/projects/${web()}/mail/ai-folder`, { accountId: t.ids.accounts.project })).statusCode, 400, 'kein Agent gewählt, kein Projektagent');
  const r = await t.api(pl).post(`/projects/${web()}/mail/ai-folder`, { accountId: t.ids.accounts.project, agentUserId: agent.id });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().view.aiProcess, true);
  assert.deepEqual([r.json().view.agentUserId, r.json().agent.mode], [agent.id, 'triage'], 'Morton ist Mitglied: schlägt vor');
  assert.deepEqual(r.json().view.filter.folders, ['KI Bearbeiten']);
  kiView = r.json().view.id;
  assert.equal((await t.api(admin).patch(`/mail/views/${kiView}`, { aiProcess: false })).statusCode, 403, 'Org-Admin schaltet die Mail-KI eines Projekts nicht');
});

test('Agent als Projektagent (stellvertretende PL) bearbeitet Mails im Ordner direkt: AP mit Ursprungsmail, Termin, Antwortentwurf, Ablage; einmal je Mail', async () => {
  const pl = await t.login('pl@demo.local');
  assert.equal((await t.api(pl).put(`/projects/${web()}/agent`, { agentUserId: agent.id, agentMail: 'process' })).statusCode, 200);
  // Policy „Rückfrage bei wichtigen Schritten“: Antworten bleiben Entwurf (autonomer Versand nur mit „Selbstständig“, eigener Test)
  assert.equal((await t.api(pl).put(`/projects/${web()}/agent-policy`, { mode: 'confirm_critical' })).statusCode, 200);
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
  assert.deepEqual([run.actor_user_id, run.agent_user_id], [agent.id, agent.id], 'der Agent handelt selbst');
  const task = await t.db.one(`select t.*, l.origin, l.copied from tasks t join mail_task_links l on l.task_id = t.id where l.mail_id = $1`, [mail.id]);
  assert.equal(task.title, 'Angebot Elektrik einholen');
  assert.equal(task.responsible_user_id, agent.id, 'direkt dem Agenten zugewiesen');
  assert.equal(task.origin, true);
  assert.equal(task.copied, true);
  assert.equal((await t.db.one(`select count(*)::int as c from checklist_items where task_id = $1`, [task.id])).c, 2);
  assert.ok(await t.db.maybeOne(`select 1 from meetings m join meeting_tasks mt on mt.meeting_id = m.id where m.title = 'Besichtigung Elektro Kurz' and mt.task_id = $1 and m.tentative`, [task.id]), 'Projekt-KI trägt nur vorläufig ein');
  const draft = await t.db.one(`select * from mail_drafts where in_reply_to = $1`, [mail.message_id]);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.user_id, agent.id);
  assert.equal(draft.task_id, task.id);
  // Antwortentwurf an Externe: Außenprüfung als Hinweis protokolliert (Absender hat Bezug zum neuen AP: Ursprungsmail)
  const check = await t.db.one(`select * from outbound_checks where mail_draft_id = $1`, [draft.id]);
  assert.deepEqual([check.channel, check.audience, check.result], ['draft', 'task_external', 'pass']);
  assert.equal((await t.db.one(`select folder from mails where id = $1`, [mail.id])).folder, 'In Arbeit');
  // Abschluss: gesendete Antwort ohne offene Rückfrage legt die geparkte Mail ins Archiv
  const sent = await t.api(pl).post(`/mail/drafts/${draft.id}/send`);
  assert.equal(sent.statusCode, 200, sent.body);
  assert.match((await t.db.one(`select folder from mails where id = $1`, [mail.id])).folder, /^Archive$/);
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'mail.archive' and object_id = $1 and details->>'reason' = 'Antwort gesendet'`, [mail.id]));
  const dmPl = await t.db.one(`select m.body from chat_messages m join chat_channels c on c.id = m.channel_id and c.kind = 'dm' join chat_channel_members x on x.channel_id = c.id and x.user_id = $1 where m.user_id = $2 order by m.created_at desc limit 1`, [t.ids.users.pl, agent.id]);
  assert.match(dmPl.body, /^Mail „Besichtigung und Angebot“ \(von Elektro Kurz\) bearbeitet: /); assert.match(dmPl.body, /Antwortentwurf: .* – Entwurf wartet auf Freigabe/); assert.match(dmPl.body, new RegExp(`Mail: /projekte/${web()}/mail/m/${mail.id}`));
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'chat.dm' and title = 'Nachricht von Morton'`, [t.ids.users.pl]), 'Info im Chat');
  assert.ok(await t.db.maybeOne(`select 1 from agent_runs where task_id = $1 and agent_user_id = $2`, [task.id, agent.id]), 'Agent legt sofort los');
  // Kein zweiter Lauf
  await t.mail.syncAccount(t.ids.accounts.project);
  assert.equal((await t.db.one(`select count(*)::int as c from mail_ai_runs where mail_id = $1`, [mail.id])).c, 1);
  assert.equal((await t.api(pl).post(`/mail/mails/${mail.id}/ai-process`, { projectId: web() })).statusCode, 400);
  const view = (await t.api(pl).get(`/mail/mails/${mail.id}/ai`)).json().runs;
  assert.equal(view[0].actions.length, 4);
  assert.ok(view[0].actions.every((a: any) => a.status === 'done'));
});

test('„Du“ in der Mail ist die Person hinter dem Postfach: Termin mit ihr als Teilnehmerin, Bestätigung per Frage, Ablehnen entfernt ihn', async () => {
  const pl = await t.login('pl@demo.local');
  const plUser = await t.db.one(`select name, email from users where id = $1`, [t.ids.users.pl]);
  mailNext = [M({ type: 'create_event', title: 'Begehung', startsAt: '2026-11-11T09:00', attendees: [plUser.email, agent.email] })];
  calls.length = 0;
  await inject({ subject: 'Termin Begehung', text: 'Es findet eine Begehung statt am 11.11.2026. Du musst auch teilnehmen.', folder: 'KI Bearbeiten' });
  const prompt = calls.find((c) => c.messages[0].content.includes('# Mail bearbeiten')).messages[1].content as string;
  assert.match(prompt, new RegExp(`angesprochen .*${plUser.name} <${plUser.email}>.*, nicht du`), 'Prompt nennt die angesprochene Person');
  const ev = await t.db.one(`select * from meetings where title = 'Begehung' and project_id = $1`, [web()]);
  assert.equal(ev.tentative, true);
  assert.deepEqual(ev.attendees.map((x: any) => x.email), [plUser.email], 'Agent nimmt nicht teil');
  const q = await t.db.one(`select * from questions where meeting_id = $1 and status = 'open'`, [ev.id]);
  assert.deepEqual([q.kind, q.addressee_id, q.asked_by], ['confirm', t.ids.users.pl, agent.id]);
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and ref_type = 'question' and ref_id = $2`, [t.ids.users.pl, q.id]));
  const ok = await t.api(pl).post(`/questions/${q.id}/answer`, { option: 'confirm' });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal((await t.db.one(`select tentative from meetings where id = $1`, [ev.id])).tentative, false, 'Bestätigen macht den Termin verbindlich');

  // Ohne genannte Teilnehmer fragt der Agent die Person hinter dem Postfach; Ablehnen entfernt den vorläufigen Termin
  mailNext = [M({ type: 'create_event', title: 'Abnahme', startsAt: '2026-11-12T10:00' })];
  await inject({ subject: 'Termin Abnahme', text: 'Abnahme am 12.11. um 10 Uhr, kannst du?', folder: 'KI Bearbeiten' });
  const ev2 = await t.db.one(`select * from meetings where title = 'Abnahme' and project_id = $1`, [web()]);
  const q2 = await t.db.one(`select * from questions where meeting_id = $1 and status = 'open'`, [ev2.id]);
  assert.equal(q2.addressee_id, t.ids.users.pl);
  assert.equal((await t.api(pl).post(`/questions/${q2.id}/answer`, { option: 'reject' })).statusCode, 200);
  assert.equal(await t.db.maybeOne(`select 1 from meetings where id = $1`, [ev2.id]), null);
});

test('Autonomer Modus: Agent als stellv. PL mit Senderecht und Policy „Selbstständig“ sendet die Antwort selbst (Außenprüfung bestanden); Info im Chat', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  assert.equal((await t.api(admin).put('/ai/settings', { externalGuard: 'check' })).statusCode, 200);
  assert.equal((await t.api(pl).put(`/projects/${web()}/agent-policy`, { mode: 'auto' })).statusCode, 200);
  const sentBefore = t.mail.dev.sent.length;
  mailNext = [M({ type: 'create_ap', title: 'Rückruf Elektro Kurz' }), M({ type: 'reply_draft', text: 'Guten Tag,\n\ndanke, wir rufen morgen zurück.\n\nViele Grüße' }), M({ type: 'move', folder: 'Archiv' })];
  await inject({ subject: 'Rückruf bitte', text: 'Bitte um Rückruf.', folder: 'KI Bearbeiten' });
  const mail = await t.db.one(`select * from mails where subject = 'Rückruf bitte'`);
  const run = (await t.api(pl).get(`/mail/mails/${mail.id}/ai`)).json().runs[0];
  const reply = run.actions.find((a: any) => a.type === 'reply_draft');
  assert.equal(reply.status, 'done', JSON.stringify(reply));
  assert.equal(reply.result.sent, true, 'selbst gesendet');
  assert.equal(t.mail.dev.sent.length, sentBefore + 1);
  assert.equal(t.mail.dev.sent.at(-1)!.msg.subject, 'Re: Rückruf bitte');
  assert.ok(await t.db.maybeOne(`select 1 from outbound_checks where channel = 'mail' and audience = 'task_external' and result = 'pass' and mail_draft_id is null`), 'Außenprüfung protokolliert');
  const dm = await t.db.one(`select m.body from chat_messages m join chat_channels c on c.id = m.channel_id and c.kind = 'dm' join chat_channel_members x on x.channel_id = c.id and x.user_id = $1 where m.user_id = $2 order by m.created_at desc limit 1`, [t.ids.users.pl, agent.id]);
  assert.match(dm.body, /Antwort: .* – gesendet/);
  // Ohne Senderecht bzw. ohne Policy „Selbstständig“: wieder Entwurf
  assert.equal((await t.api(pl).put(`/projects/${web()}/agent-policy`, { mode: 'confirm_critical' })).statusCode, 200);
  await t.api(admin).put('/ai/settings', { externalGuard: 'strict' });
});

test('Antwortentwurf der Mail-KI an Externe mit Projektinternem: Hinweis am Entwurf und im Ergebnis, kein Block', async () => {
  const pl = await t.login('pl@demo.local');
  mailNext = [
    M({ type: 'create_ap', title: 'Angebot Trockenbau einholen', responsible: agent.email }),
    M({ type: 'reply_draft', text: 'Guten Tag,\n\ndanke, wir melden uns, sobald die Wireframes Startseite und Produktseiten fertig sind.\n\nViele Grüße' })
  ];
  await inject({ subject: 'Angebot Trockenbau', text: 'Wir können ein Angebot schicken.', folder: 'KI Bearbeiten' });
  const mail = await t.db.one(`select * from mails where subject = 'Angebot Trockenbau'`);
  const run = (await t.api(pl).get(`/mail/mails/${mail.id}/ai`)).json().runs[0];
  const reply = run.actions.find((a: any) => a.type === 'reply_draft');
  assert.equal(reply.status, 'done');
  assert.equal(reply.result.hints, 1);
  const check = await t.db.one(`select * from outbound_checks where mail_draft_id = $1`, [reply.result.draftId]);
  assert.deepEqual([check.channel, check.result, check.findings[0].kind], ['draft', 'held', 'task']);
  assert.equal((await t.db.one(`select status from mail_drafts where id = $1`, [reply.result.draftId])).status, 'draft', 'Entwurf bleibt bei der Person');
});

test('„Bearbeiten lassen“ an einer Mail (Agent als stellv. PL, Projektagent nur mit Rolle), Tagesbudget hält Läufe zurück', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  // Projektagent nur mit Rolle (agentMail aus): neue Mails im Posteingang bleiben liegen, bis jemand „Bearbeiten lassen“ klickt oder sie in den Ordner legt
  assert.equal((await t.api(pl).put(`/projects/${web()}/agent`, { agentUserId: agent.id, agentMail: 'off' })).statusCode, 200);
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

test('Verschieben in „KI Bearbeiten“ (hier im Postfach) startet die Bearbeitung sofort', async () => {
  const pl = await t.login('pl@demo.local');
  // Projektagent nur mit Rolle (agentMail aus): neue Mails im Posteingang bleiben liegen, der Ordner „KI Bearbeiten“ (Agent Morton als stellv. PL) bearbeitet direkt
  assert.equal((await t.api(pl).put(`/projects/${web()}/agent`, { agentUserId: agent.id, agentMail: 'off' })).statusCode, 200);
  mailNext = [M({ type: 'none', reason: 'nur Info' })];
  await inject({ subject: 'Später bearbeiten', text: 'Bitte prüfen.' });
  const mail = await t.db.one(`select id from mails where subject = 'Später bearbeiten'`);
  assert.equal(await t.db.maybeOne(`select 1 from mail_ai_runs where mail_id = $1`, [mail.id]), null, 'im Posteingang nichts');
  assert.equal((await t.api(pl).post(`/mail/mails/${mail.id}/move`, { folder: 'KI Bearbeiten' })).statusCode, 200);
  await flushAgentRuns();
  const run = await t.db.one(`select mode, status, actor_user_id, view_id from mail_ai_runs where mail_id = $1`, [mail.id]);
  assert.deepEqual([run.mode, run.status, run.actor_user_id, run.view_id], ['process', 'ok', agent.id, kiView]);
});

test('Agent als Mitglied betreut eine Ansicht: Vorschläge, Freigabe mit einem Klick und den Rechten der freigebenden Person', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const leser = await t.login('leser@demo.local');
  // Morton wieder Mitglied (kein Projektagent): er schlägt nur noch vor
  assert.equal((await t.api(pl).put(`/projects/${web()}/agent`, { agentUserId: null })).statusCode, 200);
  assert.equal((await t.api(max).patch(`/mail/views/${t.ids.views.project}`, { agentUserId: agent.id })).statusCode, 403);
  assert.equal((await t.api(pl).patch(`/mail/views/${t.ids.views.project}`, { agentUserId: t.ids.users.max })).statusCode, 400, 'nur Agenten');
  assert.equal((await t.api(pl).patch(`/mail/views/${t.ids.views.project}`, { agentUserId: agent.id })).statusCode, 200);
  mailNext = [
    M({ type: 'create_ap', title: 'Rückruf Kunde', responsible: agent.email }),
    M({ type: 'create_ap', title: 'Rechnung prüfen' }),
    M({ type: 'reply_draft', text: 'Danke, wir melden uns.' }),
    M({ type: 'create_event', title: 'Rückruftermin', startsAt: '2026-11-06T09:00' })
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
  assert.deepEqual(all.actions.map((a: any) => a.status), ['approved', 'approved', 'rejected', 'approved'], 'PL darf den Agenten zuweisen');
  const ev = await t.db.one(`select tentative, confirmed_by from meetings where title = 'Rückruftermin'`);
  assert.deepEqual([ev.tentative, ev.confirmed_by], [false, t.ids.users.pl], 'von einer Person angenommen: bestätigt');
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

test('„Vorschläge zur Mail“: der Agent der Ansicht schlägt auf Anfrage vor und antwortet der fragenden Person per Chat; „Bearbeiten lassen“ nur für Agenten als (stellv.) PL', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const auto = await t.db.one(`select id from mails where subject = 'Re: Stand'`);
  const info = (await t.api(pl).get(`/mail/mails/${auto.id}/ai?projectId=${web()}`)).json();
  assert.deepEqual([info.suggestAgent?.name, info.suggestAgent?.canProcess], ['Morton', false], 'Agent der Ansicht, als Mitglied nur Vorschläge');
  const proc = await t.api(pl).post(`/mail/mails/${auto.id}/ai-process`, { projectId: web() });
  assert.equal(proc.statusCode, 400); assert.match(proc.json().error, /Mitglied, nicht \(stellvertretende\) Projektleitung/);
  const t4 = await t.db.one(`select number from tasks where id = $1`, [t.ids.tasks.t4]);
  mailNext = [M({ type: 'link', ref: `WEB-${t4.number}`, text: 'Erledigt laut Mail' })];
  const r = await t.api(max).post(`/mail/mails/${auto.id}/ai-suggest`, { projectId: web() });
  assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().existing, false);
  await flushAgentRuns();
  const run = await t.db.one(`select * from mail_ai_runs where mail_id = $1`, [auto.id]);
  assert.deepEqual([run.mode, run.status, run.actor_user_id, run.agent_user_id], ['triage', 'ok', t.ids.users.max, agent.id]);
  const dm = await t.db.one(`select m.body from chat_messages m join chat_channels c on c.id = m.channel_id and c.kind = 'dm' join chat_channel_members x on x.channel_id = c.id and x.user_id = $1 where m.user_id = $2 order by m.created_at desc limit 1`, [t.ids.users.max, agent.id]);
  assert.match(dm.body, new RegExp(`^Zu „Re: Stand“ \\(von .*\\) schlage ich vor:\\n1\\) Zu WEB-${t4.number}: Erledigt laut Mail\\nAnnehmen oder verwerfen an der Mail: /projekte/${web()}/mail/m/${auto.id}$`));
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'chat.dm' and title = 'Nachricht von Morton'`, [t.ids.users.max]), 'Max bekommt die Direktnachricht gemeldet');
  assert.equal((await t.api(max).post(`/mail/mails/${auto.id}/ai-suggest`, { projectId: web() })).json().existing, true, 'einmal je Mail');
  assert.equal((await t.api(pl).get(`/mail/mails/${auto.id}/ai`)).json().runs[0].requestedBy, 'Max Keller');
});
