import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';

/** Gefälschte Anthropic-API: antwortet je nach Auftrag im Prompt. */
const calls: { body: any }[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith('https://api.anthropic.com/v1/messages')) return new Response('{}', { status: 404 });
  const body = JSON.parse(String(init?.body));
  calls.push({ body });
  const key = new Headers(init?.headers as any).get('x-api-key');
  if (key === 'bad') return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401, headers: { 'content-type': 'application/json' } });
  const prompt: string = body.messages[0].content;
  let text = 'bereit';
  if (prompt.startsWith('Fasse diese Mail')) text = 'Zusammenfassung: Angebot liegt vor, Entscheidung bis Freitag.';
  else if (prompt.includes('Liefere JSON')) text = '```json\n{"summary":"Lieferant bestätigt Termin","logEntry":"Katrin Müller bestätigt die Lieferung des Designs bis 24.10.","columnName":"In Arbeit","dueDate":"2026-10-24","questions":["Wer prüft das Design?"]}\n```';
  else if (prompt.includes('Schreibe einen Abschnitt in Markdown')) text = '## Angebot Design – 13.10.\n\n- Angebot liegt vor\n- Entscheidung bis Freitag';
  else if (prompt.includes('Statusberichts')) text = '## Management-Summary\n\nProjekt im Plan.\n\n## Fortschritt\n\n…';
  else if (prompt.startsWith('Frage:')) text = 'Das Angebot kam von Katrin Müller [Q1].';
  return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } });
};

delete process.env.ANTHROPIC_API_KEY;
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());
const mailBySubject = async (s: string) => (await t.db.one(`select id from mails where subject = $1`, [s])).id as string;

test('KI aus ohne Schlüssel; Org-Admin aktiviert mit Schlüssel und Modell, Test prüft den Schlüssel', async () => {
  const pl = await t.login('pl@demo.local');
  const admin = await t.login('admin@demo.local');
  const st = await t.api(pl).get('/ai/status');
  assert.equal(st.json().enabled, false);
  const mid = await mailBySubject('Angebot Website-Relaunch – Design und Umsetzung');
  const off = await t.api(pl).post(`/mail/mails/${mid}/ai/summarize`);
  assert.equal(off.statusCode, 400);
  assert.equal((await t.api(pl).put('/ai/settings', { enabled: true, apiKey: 'k' })).statusCode, 403, 'nur Org-Admin');
  const bad = await t.api(admin).put('/ai/settings', { enabled: true, apiKey: 'bad', model: 'claude-opus-5-5' });
  assert.equal(bad.json().enabled, true);
  assert.equal(bad.json().source, 'org');
  const test1 = await t.api(admin).post('/ai/test');
  assert.equal(test1.statusCode, 400);
  assert.match(test1.json().error, /ungültig/);
  const ok = await t.api(admin).put('/ai/settings', { enabled: true, apiKey: 'good' });
  assert.equal(ok.json().hasKey, true);
  const test2 = await t.api(admin).post('/ai/test');
  assert.equal(test2.json().reply, 'bereit');
  assert.equal(calls[calls.length - 1].body.model, 'claude-opus-5-5');
  assert.equal(calls[calls.length - 1].body.fallbacks, 'default', 'Refusal-Fallback aktiv');
  const settings = await t.api(admin).get('/org/settings');
  assert.equal(JSON.stringify(settings.json()).includes('good'), false, 'Schlüssel bleibt auf dem Server');
});

test('Zusammenfassen: nur mit KI-Recht der Ansicht, Ergebnis wird an der Mail gespeichert', async () => {
  const pl = await t.login('pl@demo.local');
  const leser = await t.login('leser@demo.local');
  const mid = await mailBySubject('Angebot Website-Relaunch – Design und Umsetzung');
  assert.equal((await t.api(leser).post(`/mail/mails/${mid}/ai/summarize`)).statusCode, 403);
  const n = calls.length;
  const r = await t.api(pl).post(`/mail/mails/${mid}/ai/summarize`);
  assert.equal(r.statusCode, 200);
  assert.match(r.json().summary, /Angebot liegt vor/);
  await t.api(pl).post(`/mail/mails/${mid}/ai/summarize`);
  assert.equal(calls.length, n + 1, 'zweiter Aufruf aus dem Speicher');
  const a = await t.db.one(`select 1 from audit_log where action = 'ai.call' and object_id = $1`, [mid]);
  assert.ok(a);
});

test('Essenz → Arbeitspaket: Vorschlag, Freigabe nur mit Recht, Anwendung setzt Log (Quelle KI), Status, Termin und Verknüpfung', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const mid = await mailBySubject('Angebot Website-Relaunch – Design und Umsetzung');
  const taskId = t.ids.tasks.t2;
  await t.db.query(`update tasks set column_id = (select id from board_columns where project_id = $2 order by position limit 1) where id = $1`, [taskId, t.ids.projects.web]);
  await t.db.query(`update project_members set can_use_ai = false where user_id = $1 and project_id = $2`, [t.ids.users.max, t.ids.projects.web]);
  const noAi = await t.api(max).post(`/mail/mails/${mid}/ai/essence`, { taskId });
  assert.equal(noAi.statusCode, 403, 'KI-Recht der Ansicht reicht nicht ohne „KI nutzen“ in der Mitgliedschaft');
  await t.db.query(`update project_members set can_use_ai = true where user_id = $1 and project_id = $2`, [t.ids.users.max, t.ids.projects.web]);
  const r = await t.api(max).post(`/mail/mails/${mid}/ai/essence`, { taskId });
  assert.equal(r.statusCode, 200, r.body);
  const prop = r.json().proposal;
  assert.equal(prop.kind, 'task_update');
  assert.equal(prop.payload.columnName, 'In Arbeit');
  assert.equal(prop.payload.dueDate, '2026-10-24');
  assert.deepEqual(prop.payload.questions, ['Wer prüft das Design?']);
  const list = await t.api(max).get(`/projects/${t.ids.projects.web}/ai/proposals`);
  assert.equal(list.json().canApprove, false);
  assert.equal(list.json().proposals[0].id, prop.id);
  assert.equal(list.json().proposals[0].taskTitle.length > 0, true);
  const plNotif = await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'ai.proposal'`, [t.ids.users.pl]);
  assert.ok(plNotif, 'PL wird über den Vorschlag informiert');
  assert.equal((await t.api(max).post(`/ai/proposals/${prop.id}/approve`)).statusCode, 403);
  const ap = await t.api(pl).post(`/ai/proposals/${prop.id}/approve`, { logEntry: 'Design kommt bis 24.10. (bestätigt).' });
  assert.equal(ap.statusCode, 200, ap.body);
  const task = ap.json().task;
  assert.equal(task.dueDate, '2026-10-24');
  const col = await t.db.one(`select c.name from tasks t join board_columns c on c.id = t.column_id where t.id = $1`, [taskId]);
  assert.equal(col.name, 'In Arbeit');
  const c = await t.db.one(`select body, source, mail_id from task_comments where task_id = $1 order by created_at desc limit 1`, [taskId]);
  assert.equal(c.source, 'ai');
  assert.match(c.body, /Design kommt bis 24\.10\./);
  assert.match(c.body, /Status → In Arbeit, Termin → 2026-10-24/);
  assert.equal(c.mail_id, mid);
  assert.ok(await t.db.maybeOne(`select 1 from mail_task_links where mail_id = $1 and task_id = $2`, [mid, taskId]));
  assert.equal((await t.api(pl).post(`/ai/proposals/${prop.id}/approve`)).statusCode, 400, 'nur einmal');
  // Ablehnen
  const r2 = await t.api(pl).post(`/mail/mails/${mid}/ai/essence`, { taskId });
  const rj = await t.api(pl).post(`/ai/proposals/${r2.json().proposal.id}/reject`, { note: 'Nicht relevant' });
  assert.equal(rj.statusCode, 200);
  const done = await t.api(pl).get(`/projects/${t.ids.projects.web}/ai/proposals?status=all`);
  assert.deepEqual(done.json().proposals.map((p: any) => p.status).sort(), ['approved', 'rejected']);
});

test('Essenz → Seite: Vorschlag und Anwendung hängen den Abschnitt als neue Version an; finale Seite gesperrt', async () => {
  const pl = await t.login('pl@demo.local');
  const mid = await mailBySubject('Angebot Website-Relaunch – Design und Umsetzung');
  const page = await t.db.one(`select id, version, status from doc_pages where project_id = $1 and status <> 'final' order by created_at limit 1`, [t.ids.projects.web]);
  const r = await t.api(pl).post(`/mail/mails/${mid}/ai/merge-page`, { pageId: page.id });
  assert.equal(r.statusCode, 200, r.body);
  assert.match(r.json().proposal.payload.section, /Angebot Design/);
  const ap = await t.api(pl).post(`/ai/proposals/${r.json().proposal.id}/approve`);
  assert.equal(ap.statusCode, 200, ap.body);
  const after = await t.db.one(`select version, content_md from doc_pages where id = $1`, [page.id]);
  assert.equal(after.version, page.version + 1);
  assert.match(after.content_md, /Entscheidung bis Freitag/);
  assert.ok(await t.db.maybeOne(`select 1 from mail_page_links where mail_id = $1 and page_id = $2 and kind = 'section'`, [mid, page.id]));
  await t.db.query(`update doc_pages set status = 'final' where id = $1`, [page.id]);
  assert.equal((await t.api(pl).post(`/mail/mails/${mid}/ai/merge-page`, { pageId: page.id })).statusCode, 400);
  await t.db.query(`update doc_pages set status = 'draft' where id = $1`, [page.id]);
});

test('Statusbericht-Entwurf als Entwurfsseite in „Berichte“; Frage ans Projekt mit Quellen', async () => {
  const pl = await t.login('pl@demo.local');
  const r = await t.api(pl).post(`/projects/${t.ids.projects.web}/ai/status-report`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().page.status, 'draft');
  assert.match(r.json().page.title, /Statusbericht-Entwurf \(KI\)/);
  const folder = await t.db.one(`select f.name from doc_pages p join doc_folders f on f.id = p.folder_id where p.id = $1`, [r.json().page.id]);
  assert.equal(folder.name, 'Berichte');
  const prompt: string = calls[calls.length - 1].body.messages[0].content;
  assert.match(prompt, /Arbeitspakete gesamt/, 'Kennzahlen des Regelwerks im Kontext');

  const ask = await t.api(pl).post(`/projects/${t.ids.projects.web}/ai/ask`, { question: 'Von wem kam das Angebot für das Design?' });
  assert.equal(ask.statusCode, 200, ask.body);
  assert.match(ask.json().answer, /Katrin Müller/);
  assert.ok(ask.json().sources.length >= 1);
  assert.ok(ask.json().sources.every((s: any) => ['task', 'page', 'mail'].includes(s.type) && s.title));
  const leser = await t.login('leser@demo.local');
  assert.equal((await t.api(leser).post(`/projects/${t.ids.projects.web}/ai/ask`, { question: 'Was läuft?' })).statusCode, 403);
});
