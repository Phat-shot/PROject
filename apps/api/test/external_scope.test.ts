import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { flushAgentRuns } from '../src/ai/agentEvents.js';
import { audienceOf, checkOutbound, externalContext, releasedText } from '../src/outbound.js';
import { contactChain } from '../src/tasks/service.js';
import { newShareToken } from '../src/docs/share.js';

/**
 * Informationsgrenze für Externe (Anforderung 8): Regel E, Außenkontext, Neuformulierung (strict), deterministische Prüfung,
 * Außenprüfung in Mail › Freigaben, erster Kontakt als Entwurf, refer, Hinweise bei KI-Entwürfen, Chat-Agent.
 */
const calls: any[] = [];
const composes: string[] = [];
/** Anfragen der Neuformulierung (Schema) */
const composeBodies: any[] = [];
let next: any[] = [];
/** Antwort der Neuformulierung; Standard: Absicht unverändert */
let compose: (prompt: string) => string = (p) => { const i = p.slice(p.lastIndexOf('Absicht des Agenten')); return JSON.stringify({ subject: i.match(/^Betreff: (.*)$/m)?.[1] ?? '', text: i.split(/^Text:\n/m)[1] ?? '', withheld: [] }); };
let free = 'Guten Tag,\n\nalles erledigt.\n\nViele Grüße';
const fakeFetch: typeof fetch = async (input, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (String(input) !== 'http://llm.local:8000/v1/chat/completions') return new Response('{}', { status: 404 });
  const isCompose = Boolean(body.response_format?.json_schema?.schema?.properties?.withheld);
  if (isCompose) { composes.push(String(body.messages[1].content)); composeBodies.push(body); } else calls.push(body);
  const content = isCompose ? compose(String(body.messages[1].content)) : body.response_format ? JSON.stringify({ note: 'erledigt', actions: next }) : free;
  return new Response(JSON.stringify({ model: 'lokal-llm', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
};
delete process.env.ANTHROPIC_API_KEY;
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());

const A = (x: Record<string, unknown>) => ({ type: 'none', text: '', column: '', itemId: '', to: [], subject: '', reason: '', kind: '', checkAfterHours: 0, until: '', remindAfterHours: 0, escalateAfterHours: 0, pageId: '', title: '', folder: '', status: '', ref: '', responsible: '', startDate: '', dueDate: '', subproject: '', items: [], startsAt: '', endsAt: '', location: '', ...x });
const web = () => t.ids.projects.web;
const aud = (taskId: string | null, recipients: string[]) => audienceOf(t.db, { projectId: web(), taskId, recipients });
const logOf = async (taskId: string) => (await t.db.query(`select body, visibility, source from task_comments where task_id = $1 order by created_at`, [taskId])).rows as any[];
/** Anthropic Structured Outputs begrenzt Union-Typen (Typ-Listen, anyOf) */
const unions = (o: any): number => !o || typeof o !== 'object' ? 0 : (Array.isArray(o.type) || o.anyOf ? 1 : 0) + Object.values(o).reduce((n: number, v) => n + unions(v), 0);
let agent: any;
let ap = { id: '', number: 0 };
let other = { id: '', number: 0 };

test('Regel E: intern, Org-Benutzer ohne Zugriff, Extern mit Aufgabenbezug, unbekannt; die strengste Klasse gilt', async () => {
  const t4 = t.ids.tasks.t4;
  const t2 = t.ids.tasks.t2;
  assert.equal((await aud(t4, ['pl@demo.local'])).audience, 'internal');
  assert.equal((await aud(t4, ['Max Keller <max@demo.local>'])).audience, 'internal');
  assert.equal((await aud(t4, ['admin@demo.local'])).audience, 'outside', 'Org-Benutzer ohne Projektzugriff');
  assert.equal((await aud(t4, ['k.mueller@mueller-design.de'])).audience, 'task_external', 'externe Zuständigkeit und Mails am AP');
  assert.equal((await aud(t2, ['k.mueller@mueller-design.de'])).audience, 'unknown_external', 'Projektkontakt allein ist kein Aufgabenbezug');
  assert.equal((await aud(t4, ['pl@demo.local', 'k.mueller@mueller-design.de'])).audience, 'task_external', 'ein externer Empfänger macht die Mail extern');
  assert.equal((await aud(t4, ['k.mueller@mueller-design.de', 'neu@firma.example'])).audience, 'unknown_external');
  // Eingeschränktes Teilprojekt: Mitglied ohne Sicht ist outside
  const vertrag = await t.db.one(`select id from tasks where title = 'Agenturvertrag verhandeln'`);
  assert.equal((await aud(vertrag.id, ['max@demo.local'])).audience, 'outside');
  assert.equal((await aud(vertrag.id, ['anna@demo.local'])).audience, 'internal');
  // Teilnahme an einer verknüpften Besprechung
  const pl = await t.login('pl@demo.local');
  const m = await t.api(pl).post(`/projects/${web()}/meetings`, { title: 'Abstimmung Wireframes', startsAt: '2026-11-03T10:00:00Z', endsAt: '2026-11-03T11:00:00Z', attendees: [{ email: 'gast@extern.example', name: 'Gast' }] });
  assert.equal(m.statusCode, 200, m.body);
  await t.db.query(`insert into meeting_tasks (meeting_id, task_id) values ($1,$2)`, [m.json().meeting.id, t2]);
  assert.equal((await aud(t2, ['gast@extern.example'])).audience, 'task_external');
  // AP-Familie: Zuständigkeit an einer Aufgabe darunter zählt für das AP, am Über-AP für die Aufgabe; Geschwister-Aufgaben nicht
  const cms = await t.db.one(`select id from tasks where title = 'CMS-Auswahl: Headless vs. klassisch'`);
  const demos = await t.db.one(`select id from tasks where title = 'Demos von drei Anbietern'`);
  const fach = await t.db.one(`select id from tasks where title = 'Anforderungen der Fachbereiche sammeln'`);
  await t.db.query(`update tasks set responsible_email = 'vertrieb@anbieter.example' where id = $1`, [demos.id]);
  assert.equal((await aud(cms.id, ['vertrieb@anbieter.example'])).audience, 'task_external', 'Aufgabe darunter');
  assert.equal((await aud(demos.id, ['vertrieb@anbieter.example'])).audience, 'task_external');
  assert.equal((await aud(fach.id, ['vertrieb@anbieter.example'])).audience, 'unknown_external', 'Geschwister-Aufgabe ist kein Bezug');
  const top = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Gerüst stellen', responsibleEmail: 'geruest@extern.example' })).json().task;
  const sub = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Gerüst abnehmen lassen', parentId: top.id })).json().task;
  assert.equal((await aud(sub.id, ['geruest@extern.example'])).audience, 'task_external', 'Zuständigkeit am Über-AP');
  assert.equal((await aud(t2, ['geruest@extern.example'])).audience, 'unknown_external');
});

test('Außenkontext: Außenbeschreibung, freigegebene Log-Einträge, eigene Tasks, externes Profil; nichts aus anderen APs; Rechte der Routen', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const leser = await t.login('leser@demo.local');
  const t4 = t.ids.tasks.t4;
  // Externes Profil pflegt die PL
  const profile = { name: 'Neubau Firmensitz', address: 'Hafenstraße 1, Hamburg', access: 'Zufahrt über Tor 3', contacts: [{ name: 'Bauleitung Nord', email: 'bauleitung@firma.example', role: 'Bauleitung' }] };
  assert.equal((await t.api(max).put(`/projects/${web()}/external-profile`, profile)).statusCode, 403);
  assert.equal((await t.api(pl).put(`/projects/${web()}/external-profile`, { contacts: [{ name: 'X', email: 'kaputt' }] })).statusCode, 400);
  const p = await t.api(pl).put(`/projects/${web()}/external-profile`, profile);
  assert.equal(p.statusCode, 200, p.body);
  assert.equal((await t.api(max).get(`/projects/${web()}`)).json().project.externalProfile.contacts[0].email, 'bauleitung@firma.example');
  // Außenbeschreibung: PL oder „Projektplan ändern“
  assert.equal((await t.api(leser).patch(`/tasks/${t4}`, { externalBrief: 'x' })).statusCode, 403);
  const b = await t.api(max).patch(`/tasks/${t4}`, { externalBrief: 'Angebot für Design und Umsetzung, Rückmeldung bis 25.10.' });
  assert.equal(b.statusCode, 200, b.body);
  assert.equal(b.json().task.externalBrief, 'Angebot für Design und Umsetzung, Rückmeldung bis 25.10.');
  // Log: eigener Eintrag für Externe sichtbar; fremde Einträge freigeben PL, „Projektplan ändern“ oder die verfassende Person
  const ext = (await t.api(pl).post(`/tasks/${t4}/comments`, { body: 'Abnahme der Entwürfe am 30.10. vor Ort.', visibility: 'external' })).json().comment;
  assert.equal(ext.visibility, 'external');
  const intern = (await t.api(pl).post(`/tasks/${t4}/comments`, { body: 'Intern: Budget für die Agentur max. 40.000 EUR.' })).json().comment;
  await t.api(pl).put(`/projects/${web()}/members/${t.ids.users.max}`, { role: 'member', canEditPlan: false });
  assert.equal((await t.api(max).patch(`/tasks/${t4}/comments/${intern.id}`, { visibility: 'external' })).statusCode, 403);
  const own = (await t.api(max).post(`/tasks/${t4}/comments`, { body: 'Max: Rückruf erledigt.' })).json().comment;
  assert.equal((await t.api(max).patch(`/tasks/${t4}/comments/${own.id}`, { visibility: 'external' })).statusCode, 200);
  assert.equal((await t.api(max).patch(`/tasks/${t4}/comments/${own.id}`, { visibility: 'internal' })).statusCode, 200);
  await t.api(pl).put(`/projects/${web()}/members/${t.ids.users.max}`, { role: 'member', canEditPlan: true });
  const detail = (await t.api(pl).get(`/tasks/${t4}`)).json();
  assert.equal(detail.comments.find((c: any) => c.id === ext.id).visibility, 'external');
  assert.equal(detail.comments.find((c: any) => c.id === intern.id).visibility, 'internal');

  const ctx = await externalContext(t.db, t4, await aud(t4, ['k.mueller@mueller-design.de']));
  assert.match(ctx.text, /Projekt nach außen: Neubau Firmensitz/);
  assert.match(ctx.text, /Bauleitung Nord \(Bauleitung\) <bauleitung@firma\.example>/);
  assert.match(ctx.text, /Beschreibung für Externe: Angebot für Design und Umsetzung/);
  assert.match(ctx.text, /Beschreibung: Angebot vom 12\.10\./, 'AP ist diesem Externen zugewiesen: Beschreibung gehört dazu');
  assert.match(ctx.text, /Abnahme der Entwürfe am 30\.10\./);
  assert.match(ctx.text, /Re: Rückfrage Angebot – Lizenzen/, 'Mails mit dem Empfänger am AP');
  for (const no of ['40.000', 'Max: Rückruf', 'Wireframes Startseite', 'Konzept & Design', 'max@demo.local', 'pl@demo.local', 'Statusbericht KW 41', 'Design-Freigabe']) assert.ok(!ctx.text.includes(no), `Außenkontext enthält „${no}“`);
  // Freigegebene Seiten: Verteiler des Ordners Protokolle enthält k.mueller
  assert.match(ctx.text, /freigegebene Seiten: .*„Protokoll JF Auftraggeber 02\.10\.2026“/);
});

test('Außenkontext bei mehreren Empfängern: nur, was für alle gilt (Tasks, Besprechungen, Freigaben inkl. Unterseiten)', async () => {
  const pl = await t.login('pl@demo.local');
  const a = 'trockenbau@extern.example';
  const b = 'maler@extern.example';
  const flur = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Trockenbau Flur abstimmen' })).json().task;
  await t.api(pl).post(`/tasks/${flur.id}/checklist`, { title: 'Ständerwerk stellen', responsibleEmail: a });
  await t.api(pl).post(`/tasks/${flur.id}/checklist`, { title: 'Wände streichen', responsibleEmail: b });
  const both = await aud(flur.id, [a, b]);
  assert.equal(both.audience, 'task_external');
  // Besprechungen: mit beiden bzw. nur mit einem
  const meet = async (title: string, attendees: string[]) => {
    const m = await t.api(pl).post(`/projects/${web()}/meetings`, { title, startsAt: '2026-11-10T09:00:00Z', endsAt: '2026-11-10T10:00:00Z', attendees: attendees.map((email) => ({ email, name: email })) });
    assert.equal(m.statusCode, 200, m.body);
    await t.db.query(`insert into meeting_tasks (meeting_id, task_id) values ($1,$2)`, [m.json().meeting.id, flur.id]);
  };
  await meet('Baubesprechung Flur', [a, b]);
  await meet('Aufmaß Trockenbau', [a]);
  // Freigabe an der Oberseite mit „inkl. Unterseiten“ für beide; eine zweite Seite nur für einen
  const auftrag = await t.db.one(`select id from doc_pages where title = 'Projektauftrag Website-Relaunch'`);
  const report = await t.db.one(`select id from doc_pages where title = 'Statusbericht KW 41'`);
  for (const [page, email, children] of [[auftrag.id, a, true], [auftrag.id, b, true], [report.id, a, false]] as const) {
    await t.db.query(`insert into doc_shares (page_id, project_id, token, email, mode, include_children, created_by) values ($1,$2,$3,$4,'read',$5,$6)`, [page, web(), newShareToken(), email, children, t.ids.users.pl]);
  }
  const ctx = await externalContext(t.db, flur.id, both);
  for (const no of ['Ständerwerk', 'Wände streichen', 'Aufmaß Trockenbau', 'Statusbericht KW 41']) assert.ok(!ctx.text.includes(no), `Außenkontext für beide enthält „${no}“`);
  assert.match(ctx.text, /Termine mit den Empfängern: Baubesprechung Flur/);
  assert.match(ctx.text, /freigegebene Seiten: .*„Anforderungen Barrierefreiheit“ \(Entwurf, geht nicht hinaus\)/, 'Unterseite über include_children');
  assert.match(ctx.text, /„Projektauftrag Website-Relaunch“/);
  // Nur einer: seine Tasks, seine Besprechung, seine Seite
  const one = await externalContext(t.db, flur.id, await aud(flur.id, [a]));
  assert.match(one.text, /- \[ \] Ständerwerk stellen/);
  assert.ok(!one.text.includes('Wände streichen'));
  assert.match(one.text, /Aufmaß Trockenbau/);
  assert.match(one.text, /„Statusbericht KW 41“/);
});

test('checkOutbound: fremde Kennungen, Titel, Teilprojekte, interne Adressen, App-Links, andere Projekte, Seiten; Anhänge nicht final → blocked', async () => {
  const t4 = t.ids.tasks.t4;
  const a = await aud(t4, ['k.mueller@mueller-design.de']);
  const t2n = (await t.db.one(`select number from tasks where id = $1`, [t.ids.tasks.t2])).number;
  const check = (text: string, pageIds?: string[]) => checkOutbound(t.db, { projectId: web(), taskId: t4, aud: a, subject: 'Angebot', text, pageIds });
  assert.deepEqual(await check('Guten Tag Frau Müller,\n\nwie besprochen klären wir die Rückfragen zu Lizenzen bis Freitag. Fragen gern an bauleitung@firma.example.\n\nGrüße'), { result: 'pass', findings: [] });
  const kinds = async (text: string) => (await check(text)).findings.map((f) => f.kind);
  assert.deepEqual(await kinds(`Siehe auch WEB-${t2n}.`), ['ref']);
  assert.deepEqual(await kinds('Parallel laufen die Wireframes Startseite und Produktseiten.'), ['task']);
  assert.deepEqual(await kinds('Das gehört zu Umsetzung CMS.'), ['subproject']);
  assert.deepEqual(await kinds('Rückfragen bitte an max@demo.local.'), ['address']);
  assert.deepEqual(await kinds('Details: http://localhost:5173/projekte/abc/doku/def'), ['link']);
  assert.deepEqual(await kinds('Wie im Projekt ERP-Einführung (ERP-1) besprochen.'), ['project', 'project']);
  const page = await check('Anbei ein Auszug aus dem Statusbericht KW 41.');
  assert.equal(page.findings[0].kind, 'page');
  assert.ok(page.findings[0].pageId);
  // Was Menschen für Externe bestimmt haben (Außenbeschreibung), ist kein Fund
  assert.equal((await check('Zum Angebot für Design und Umsetzung melden wir uns bis 25.10.')).result, 'pass');
  // Was der Externe selbst schreibt, schaltet die Prüfung nicht ab: seine Mail geht an die Neuformulierung, ist aber keine Ausnahme
  t.mail.dev.inject(t.ids.accounts.project, { from: { address: 'k.mueller@mueller-design.de', name: 'Katrin Müller' }, to: [`projekt-web+t${t.ids.tasks.t4Code}@demo.local`], subject: 'Stand?', text: `Wie steht es um WEB-${t2n}, Agenturvertrag verhandeln, Wireframes Startseite und Produktseiten und den Statusbericht KW 41? Und Umsetzung CMS?`, folder: 'INBOX' } as any);
  await t.mail.syncAccount(t.ids.accounts.project);
  const ctx = await externalContext(t.db, t4, a);
  assert.match(ctx.text, /Wie steht es um WEB-\d+, Agenturvertrag verhandeln/);
  assert.ok(!ctx.trusted.includes('Agenturvertrag') && ctx.trusted.includes('Angebot für Design und Umsetzung'));
  const echo = await check(`Zu WEB-${t2n}: verschoben. Agenturvertrag verhandeln stockt. Wireframes Startseite und Produktseiten fast fertig, Statusbericht KW 41 ist rot, Umsetzung CMS hängt.`);
  assert.equal(echo.result, 'held');
  assert.deepEqual(echo.findings.map((f) => f.kind).sort(), ['page', 'ref', 'subproject', 'task', 'task']);
  // Kennungen aus den tatsächlichen Kürzeln, auch mit Bindestrich oder Ziffer am Anfang
  await t.db.query(`update projects set key = 'BAU-HH' where id = $1`, [web()]);
  await t.db.query(`update projects set key = '24HH' where id = $1`, [t.ids.projects.erp]);
  try {
    const own = await check(`Siehe BAU-HH-${t2n}.`);
    assert.deepEqual(own.findings.map((f) => [f.kind, f.match]), [['ref', `BAU-HH-${t2n}`]]);
    assert.deepEqual((await check('Siehe 24HH-2 und 24hh-3.')).findings.map((f) => [f.kind, f.match]), [['project', '24HH-2'], ['project', '24hh-3']]);
    const t4n = (await t.db.one(`select number from tasks where id = $1`, [t4])).number;
    assert.equal((await check(`Zu BAU-HH-${t4n} melden wir uns.`)).result, 'pass', 'eigene Kennung');
  } finally {
    await t.db.query(`update projects set key = 'WEB' where id = $1`, [web()]);
    await t.db.query(`update projects set key = 'ERP' where id = $1`, [t.ids.projects.erp]);
  }
  // Anhänge: Entwurf blockiert, finale und freigegebene Seite geht
  const draft = await t.db.one(`select id from doc_pages where title = 'Protokoll JF Auftraggeber 16.10.2026'`);
  const final = await t.db.one(`select id from doc_pages where title = 'Protokoll JF Auftraggeber 02.10.2026'`);
  assert.equal((await check('Anbei das Protokoll.', [draft.id])).result, 'blocked');
  assert.equal((await check('Anbei das Protokoll.', [final.id])).result, 'pass');
  // Interne Empfänger werden nicht geprüft
  assert.equal((await checkOutbound(t.db, { projectId: web(), taskId: t4, aud: await aud(t4, ['pl@demo.local']), subject: 'x', text: `WEB-${t2n} max@demo.local` })).result, 'pass');
});

test('Agenten-Mail an Externe (strict): Neuformulierung kennt nur den Außenkontext, geprüft gesendet, Zurückgehaltenes im Log und Protokoll', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const prof = (await t.api(admin).post('/ai/profiles', { name: 'Lokales LLM', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'lokal-llm' })).json().profile;
  await t.api(admin).put('/ai/settings', { agentDailyBudget: 100 });
  agent = (await t.api(admin).post('/agents', { name: 'Außendienst' })).json().agent;
  await t.api(pl).put(`/projects/${web()}/members/${agent.id}`, { role: 'member', agentCanMail: true });
  other = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Elektroinstallation Küche planen' })).json().task;
  next = [A({ type: 'none', reason: 'Start' })];
  ap = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Fliesenarbeiten Bad koordinieren', responsibleUserId: agent.id, description: 'Intern: Budget 8.000 EUR, Elektro muss vorher fertig sein.' })).json().task;
  await t.api(pl).post(`/tasks/${ap.id}/checklist`, { title: 'Fliesen liefern lassen', responsibleEmail: 'fliesen@extern.example' });
  await t.api(pl).post(`/tasks/${ap.id}/checklist`, { title: 'Silikonfugen prüfen (intern)' });
  await flushAgentRuns();

  compose = () => JSON.stringify({ subject: 'Lieferung Fliesen', text: 'Guten Tag,\n\npasst Ihnen die Lieferung am 12.11.?\n\nViele Grüße\nAußendienst', withheld: ['Verweis auf ein anderes Arbeitspaket', 'Budget', 'interne Adresse'] });
  next = [A({ type: 'mail', to: ['fliesen@extern.example'], subject: 'Lieferung', text: `Hallo, Lieferung am 12.11.? Intern: erst nach Elektroinstallation Küche planen (WEB-${other.number}), Budget 8.000 EUR, Rückfragen an max@demo.local.` })];
  const before = t.mail.dev.sent.length;
  const r = await t.api(pl).post(`/tasks/${ap.id}/agent-run?wait=1`);
  assert.equal(r.statusCode, 200, r.body);
  const prompt = composes.at(-1)!;
  const context = prompt.slice(0, prompt.lastIndexOf('Absicht des Agenten'));
  assert.match(context, /Fliesenarbeiten Bad koordinieren/);
  assert.match(context, /Fliesen liefern lassen/, 'Task des Empfängers');
  for (const no of ['Silikonfugen', 'Elektroinstallation', '8.000', 'max@demo.local', 'Wireframes', 'Petra Lenz']) assert.ok(!context.includes(no), `Außenkontext enthält „${no}“`);
  assert.match(prompt, /an fliesen@extern\.example/);
  assert.equal(unions(composeBodies.at(-1).response_format.json_schema.schema), 0, 'Schema der Neuformulierung ohne Union-Typen');
  assert.equal(t.mail.dev.sent.length, before + 1);
  const sent = t.mail.dev.sent.at(-1)!.msg;
  assert.equal(sent.subject, 'Lieferung Fliesen');
  assert.ok(!sent.text.includes('Elektroinstallation') && !sent.text.includes('8.000'));
  assert.ok((await logOf(ap.id)).some((c) => /^Mail gesendet an fliesen@extern\.example: „Lieferung Fliesen“ · nach außen \(Aufgabenbezug WEB-\d+\), 3 Inhalte zurückgehalten$/.test(c.body)));
  const run = await t.db.one(`select id from agent_runs where task_id = $1 order by created_at desc limit 1`, [ap.id]);
  const chk = await t.db.one(`select * from outbound_checks where task_id = $1 order by created_at desc limit 1`, [ap.id]);
  assert.deepEqual([chk.channel, chk.audience, chk.result, chk.withheld.length, chk.run_id], ['mail', 'task_external', 'pass', 3, run.id]);
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'ai.outbound' and details->>'checkId' = $1`, [chk.id]));
});

test('Außenprüfung hält an: Entwurf mit Fundstellen in Mail › Freigaben, „Bearbeiten und senden“ nur mit Senderecht', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  compose = () => JSON.stringify({ subject: 'Lieferung Fliesen', text: `Guten Tag,\n\ndie Lieferung hängt an WEB-${other.number}.\n\nViele Grüße`, withheld: [] });
  next = [A({ type: 'mail', to: ['fliesen@extern.example'], subject: 'Lieferung', text: 'Lieferung?' })];
  const before = t.mail.dev.sent.length;
  await t.api(pl).post(`/tasks/${ap.id}/agent-run?wait=1`);
  assert.equal(t.mail.dev.sent.length, before, 'angehalten, nicht gesendet');
  const draft = await t.db.one(`select * from mail_drafts where task_id = $1 order by created_at desc limit 1`, [ap.id]);
  assert.equal(draft.status, 'pending_approval');
  assert.ok((await logOf(ap.id)).some((c) => /wartet auf Freigabe \(nicht gesendet\): „Lieferung Fliesen“ · nach außen \(Aufgabenbezug WEB-\d+\), Außenprüfung angehalten: 1 Fundstelle/.test(c.body)));
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'outbound.review' and title = 'Außenprüfung angehalten: Lieferung Fliesen'`, [t.ids.users.pl]));
  const held = (await t.api(pl).get(`/projects/${web()}/outbound-checks?result=held`)).json().checks;
  assert.equal(held.length, 1);
  assert.equal(held[0].findings[0].kind, 'ref');
  assert.equal(held[0].draft.subject, 'Lieferung Fliesen');
  assert.match(held[0].taskRef, /^WEB-\d+$/);
  const drafts = (await t.api(pl).get(`/projects/${web()}/mail/drafts`)).json().drafts;
  assert.equal(drafts.find((d: any) => d.id === draft.id).outbound.result, 'held');
  // Ohne Senderecht (Projektkonto: PL): nicht sichtbar, nicht entscheidbar
  assert.equal((await t.api(max).get(`/projects/${web()}/outbound-checks?result=held`)).json().checks.length, 0);
  assert.equal((await t.api(max).post(`/outbound-checks/${held[0].id}/decide`, { action: 'release' })).statusCode, 403);
  const d = await t.api(pl).post(`/outbound-checks/${held[0].id}/decide`, { action: 'edit', body: 'Guten Tag,\n\npasst die Lieferung am 12.11.?\n\nViele Grüße' });
  assert.equal(d.statusCode, 200, d.body);
  assert.equal(t.mail.dev.sent.length, before + 1);
  assert.match(t.mail.dev.sent.at(-1)!.msg.text, /passt die Lieferung am 12\.11\./);
  assert.ok((await t.db.one(`select decided_at from outbound_checks where id = $1`, [held[0].id])).decided_at);
  assert.ok((await logOf(ap.id)).some((c) => /^Nach außen an fliesen@extern\.example \(Außenprüfung\): von Petra Lenz bearbeitet und freigegeben, gesendet/.test(c.body)));
  assert.equal((await t.api(pl).get(`/projects/${web()}/outbound-checks?result=held`)).json().checks.length, 0);
  assert.equal((await t.api(pl).post(`/outbound-checks/${held[0].id}/decide`, { action: 'release' })).statusCode, 400, 'schon entschieden');

  // Ablehnen: nichts gesendet, Entwurf weg, Log, Audit, der Agent läuft erneut
  await t.api(pl).post(`/tasks/${ap.id}/agent-run?wait=1`);
  const again = (await t.api(pl).get(`/projects/${web()}/outbound-checks?result=held`)).json().checks[0];
  const runs0 = (await t.db.one(`select count(*)::int as c from agent_runs where task_id = $1 and trigger = 'rejected'`, [ap.id])).c;
  next = [A({ type: 'none', reason: 'abgelehnt zur Kenntnis' })];
  const sent0 = t.mail.dev.sent.length;
  const blk = await t.api(pl).post(`/outbound-checks/${again.id}/decide`, { action: 'block' });
  assert.equal(blk.statusCode, 200, blk.body);
  assert.equal(t.mail.dev.sent.length, sent0);
  assert.equal(await t.db.maybeOne(`select 1 from mail_drafts where id = $1`, [again.mailDraftId]), null);
  assert.ok((await t.db.one(`select decided_at from outbound_checks where id = $1`, [again.id])).decided_at);
  assert.ok((await logOf(ap.id)).some((c) => c.body === 'Außenprüfung: Mail von Außendienst an fliesen@extern.example abgelehnt (nicht gesendet): „Lieferung Fliesen“'));
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'ai.outbound' and details->>'checkId' = $1 and details->>'decision' = 'block'`, [again.id]));
  await flushAgentRuns();
  assert.equal((await t.db.one(`select count(*)::int as c from agent_runs where task_id = $1 and trigger = 'rejected'`, [ap.id])).c, runs0 + 1);
});

test('Entscheiden nur mit Senderecht, auch für die verfassende Person; eigene Mails an Externe: Hinweis vor dem Senden und Protokoll, kein Block', async () => {
  const pl = await t.login('pl@demo.local');
  const max = await t.login('max@demo.local');
  const t4 = t.ids.tasks.t4;
  // Max hat an der Hosting-Ansicht (persönliches Konto der PL) nur Entwurfsrecht: Einreichen protokolliert einen Hinweis
  const sub = await t.api(max).post('/mail/drafts', { viewId: t.ids.views.hosting, projectId: web(), taskId: t4, to: ['k.mueller@mueller-design.de'], subject: 'Stand', body: 'Parallel laufen die Wireframes Startseite und Produktseiten.', send: true });
  assert.equal(sub.statusCode, 200, sub.body);
  const draft = sub.json().draft;
  assert.equal(draft.status, 'pending_approval');
  assert.deepEqual([draft.outbound.channel, draft.outbound.result, draft.outbound.findings[0].kind], ['draft', 'held', 'task']);
  // Kein Weg an der Freigabe der Eigentümerin vorbei: decide verlangt das echte Senderecht und nur Agenten-Kanäle
  for (const action of ['edit', 'release']) assert.equal((await t.api(max).post(`/outbound-checks/${draft.outbound.checkId}/decide`, { action, body: 'beliebiger Text' })).statusCode, 403);
  assert.equal((await t.api(pl).post(`/outbound-checks/${draft.outbound.checkId}/decide`, { action: 'release' })).statusCode, 400, 'Hinweise zu Entwürfen von Menschen entscheidet das normale Senden');
  assert.equal((await t.db.one(`select status, sent_by from mail_drafts where id = $1`, [draft.id])).status, 'pending_approval');
  for (const c of [max, pl]) assert.ok(!(await t.api(c).get(`/projects/${web()}/outbound-checks?result=held`)).json().checks.some((x: any) => x.id === draft.outbound.checkId));
  await t.api(pl).del(`/mail/drafts/${draft.id}`);

  // Vorschau vor dem Senden: Hinweise ohne Protokoll; Titel aus eingeschränkten Teilprojekten nur für Personen, die sie sehen
  const n0 = (await t.db.one(`select count(*)::int as c from outbound_checks`)).c;
  const text = 'Parallel laufen die Wireframes Startseite und Produktseiten und Agenturvertrag verhandeln.';
  const hint = (c: any) => t.api(c).post(`/projects/${web()}/outbound-hint`, { taskId: t4, to: ['k.mueller@mueller-design.de'], subject: 'Stand', body: text });
  const forPl = (await hint(pl)).json().outbound;
  assert.equal(forPl.audience, 'task_external');
  assert.deepEqual(forPl.findings.map((f: any) => f.match).sort(), ['Agenturvertrag verhandeln', 'Wireframes Startseite und Produktseiten']);
  assert.deepEqual((await hint(max)).json().outbound.findings.map((f: any) => f.match), ['Wireframes Startseite und Produktseiten'], 'kein Hinweis auf ein eingeschränktes Teilprojekt');
  assert.equal((await t.api(pl).post(`/projects/${web()}/outbound-hint`, { taskId: t4, to: ['max@demo.local'], subject: 'x', body: text })).json().outbound, null, 'intern: keine Prüfung');
  assert.equal((await t.db.one(`select count(*)::int as c from outbound_checks`)).c, n0);
  const vertrag = await t.db.one(`select id from tasks where title = 'Agenturvertrag verhandeln'`);
  assert.equal((await t.api(max).post(`/projects/${web()}/outbound-hint`, { taskId: vertrag.id, to: ['x@extern.example'], subject: 'x', body: 'x' })).statusCode, 403);

  // Die PL sendet selbst: gesendet, Prüfung als Hinweis protokolliert (Kanal draft)
  const sent0 = t.mail.dev.sent.length;
  const own = await t.api(pl).post('/mail/drafts', { viewId: t.ids.views.project, projectId: web(), taskId: t4, to: ['k.mueller@mueller-design.de'], subject: 'Stand', body: 'Parallel laufen die Wireframes Startseite und Produktseiten.', send: true });
  assert.equal(own.statusCode, 200, own.body);
  assert.equal(own.json().draft.status, 'sent');
  assert.equal(t.mail.dev.sent.length, sent0 + 1);
  const chk = await t.db.one(`select * from outbound_checks where mail_draft_id = $1`, [own.json().draft.id]);
  assert.deepEqual([chk.channel, chk.result, chk.findings[0].kind], ['draft', 'held', 'task']);
});

test('Erster Kontakt immer als Entwurf, keine Mail an Interne, fehlgeschlagene Neuformulierung hält an, Stufe check ohne Neuformulierung', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  compose = (p) => { const i = p.slice(p.lastIndexOf('Absicht des Agenten')); return JSON.stringify({ subject: i.match(/^Betreff: (.*)$/m)?.[1] ?? '', text: i.split(/^Text:\n/m)[1] ?? '', withheld: [] }); };
  let before = t.mail.dev.sent.length;
  next = [A({ type: 'mail', to: ['neu@firma.example'], subject: 'Anfrage Fliesen', text: 'Guten Tag, bitte um ein Angebot. Viele Grüße' })];
  await t.api(pl).post(`/tasks/${ap.id}/agent-run?wait=1`);
  assert.equal(t.mail.dev.sent.length, before, 'auch mit „darf Mails senden“ nicht direkt');
  assert.ok((await logOf(ap.id)).some((c) => /„Anfrage Fliesen“ · nach außen \(ohne Bezug zum AP, erster Kontakt\), erster Kontakt geht als Entwurf/.test(c.body)));
  const first = await t.db.one(`select * from outbound_checks where task_id = $1 order by created_at desc limit 1`, [ap.id]);
  assert.deepEqual([first.audience, first.result, Boolean(first.mail_draft_id)], ['unknown_external', 'pass', true]);
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'draft.review' and body = 'Anfrage Fliesen'`, [t.ids.users.pl]));

  next = [A({ type: 'mail', to: ['max@demo.local'], subject: 'Frage', text: 'Kurze Frage.' })];
  const n = (await t.db.one(`select count(*)::int as c from mail_drafts where task_id = $1`, [ap.id])).c;
  const r = await t.api(pl).post(`/tasks/${ap.id}/agent-run?wait=1`);
  assert.match(String(r.json().error), /Projektmitglieder erreichst du per chat/);
  assert.equal((await t.db.one(`select count(*)::int as c from mail_drafts where task_id = $1`, [ap.id])).c, n);

  compose = () => 'kein JSON';
  next = [A({ type: 'mail', to: ['fliesen@extern.example'], subject: 'Termin', text: 'Termin am 13.11.?' })];
  before = t.mail.dev.sent.length;
  await t.api(pl).post(`/tasks/${ap.id}/agent-run?wait=1`);
  assert.equal(t.mail.dev.sent.length, before);
  const failed = await t.db.one(`select * from outbound_checks where task_id = $1 order by created_at desc limit 1`, [ap.id]);
  assert.deepEqual([failed.result, failed.findings[0].kind], ['held', 'compose']);

  // Stufe check (Verwaltung › KI): keine Neuformulierung, nur Prüfung
  assert.equal((await t.api(admin).put('/ai/settings', { externalGuard: 'check' })).json().externalGuard, 'check');
  const c0 = composes.length;
  next = [A({ type: 'mail', to: ['fliesen@extern.example'], subject: 'Termin 2', text: 'Guten Tag, passt der 14.11.? Viele Grüße' })];
  await t.api(pl).post(`/tasks/${ap.id}/agent-run?wait=1`);
  assert.equal(composes.length, c0);
  assert.equal(t.mail.dev.sent.length, before + 1);
  assert.equal(t.mail.dev.sent.at(-1)!.msg.text, 'Guten Tag, passt der 14.11.? Viele Grüße');
  assert.equal((await t.api(admin).put('/ai/settings', { externalGuard: 'kaputt' })).statusCode, 400);
  await t.api(admin).put('/ai/settings', { externalGuard: 'strict' });
});

test('Prompt kennzeichnet Absenderklassen; refer: Log, Meldung und Chat an die erste Person der Kette, Verweis an den Externen; Freigabe der Antwort', async () => {
  const pl = await t.login('pl@demo.local');
  const code = (await t.db.one(`select mail_code from tasks where id = $1`, [ap.id])).mail_code;
  next = [A({ type: 'none', reason: 'gelesen' })];
  await t.api(pl).patch(`/tasks/${ap.id}`, { externalBrief: 'Lieferung und Verlegung der Fliesen im Bad, Termin nach Absprache.' });
  t.mail.dev.inject(t.ids.accounts.project, { from: { address: 'fliesen@extern.example', name: 'Fliesen GmbH' }, to: [`projekt-web+t${code}@demo.local`], subject: 'Lieferung und Budget', text: 'Lieferung ok. Wie hoch ist eigentlich das Budget für den ganzen Neubau?', folder: 'INBOX' } as any);
  next = [A({ type: 'none', reason: 'gelesen' })];
  await t.mail.syncAccount(t.ids.accounts.project);
  await flushAgentRuns();
  const prompt = String(calls.filter((c) => c.response_format && String(c.messages[1].content).includes('Fliesenarbeiten Bad koordinieren')).at(-1).messages[1].content);
  assert.match(prompt, /VON fliesen@extern\.example \(von Extern \(task_external\), Scope WEB-\d+\): Lieferung und Budget/);
  assert.match(prompt, /Außenbeschreibung \(was Externe zu diesem AP erfahren dürfen\): Lieferung und Verlegung der Fliesen im Bad/);
  assert.match(String(calls.at(-1).messages[0].content), /Nicht-Interne erfahren nur, was zu ihrer Aufgabe gehört/, 'Satz im Sheet');

  next = [A({ type: 'refer', text: 'Der Fliesenleger fragt nach dem Budget des ganzen Neubaus.', subject: 'Budget' })];
  const before = t.mail.dev.sent.length;
  const r = await t.api(pl).post(`/tasks/${ap.id}/agent-run?wait=1`);
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().actions.map((x: any) => x.type), ['refer']);
  const log = await logOf(ap.id);
  assert.ok(log.some((c) => c.body === 'Rückfrage von extern (fliesen@extern.example) außerhalb der Aufgabe an Petra Lenz weitergegeben (Projektleitung): Der Fliesenleger fragt nach dem Budget des ganzen Neubaus.'));
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and type = 'external.referral'`, [t.ids.users.pl]));
  const dm = await t.db.one(`select c.id as channel_id, m.body from chat_messages m join chat_channels c on c.id = m.channel_id and c.kind = 'dm' join chat_channel_members x on x.channel_id = c.id and x.user_id = $2 where m.user_id = $1 order by m.created_at desc limit 1`, [agent.id, t.ids.users.pl]);
  assert.match(dm.body, /^WEB-\d+ „Fliesenarbeiten Bad koordinieren“: Rückfrage von extern \(fliesen@extern\.example\)/);
  // An den Externen nur der Verweis an den Kontakt aus dem externen Profil, im Verlauf seiner Mail
  assert.equal(t.mail.dev.sent.length, before + 1);
  const notice = t.mail.dev.sent.at(-1)!.msg;
  assert.deepEqual(notice.to, ['fliesen@extern.example']);
  assert.equal(notice.subject, 'Re: Lieferung und Budget');
  assert.match(notice.text, /Ihre Frage zu „Budget“ gebe ich an Bauleitung Nord \(Bauleitung\), bauleitung@firma\.example weiter\./);
  assert.ok(!notice.text.includes('Petra'));

  // Antwort der PL im Chat mit „darf weitergegeben werden“: Log-Eintrag für Externe sichtbar, danach im Außenkontext
  next = [A({ type: 'none', reason: 'Antwort liegt vor' })];
  await t.api(pl).post(`/chat/channels/${dm.channel_id}/messages`, { body: 'Das Budget ist vertraulich. Das Lieferfenster ist KW 47, darf weitergegeben werden.' });
  await flushAgentRuns();
  const rel = (await logOf(ap.id)).filter((c) => c.source === 'chat').at(-1);
  assert.equal(rel.visibility, 'external');
  assert.equal(rel.body, 'Rückmeldung per Chat an Außendienst: Das Budget ist vertraulich. Das Lieferfenster ist KW 47');
  const next2 = String(calls.filter((c) => c.response_format && !String(c.messages[0].content).includes('Man erreicht dich im Chat') && String(c.messages[1].content).includes('Fliesenarbeiten Bad koordinieren')).at(-1).messages[1].content);
  assert.match(next2, /Petra Lenz \[für Externe sichtbar\]: Rückmeldung per Chat an Außendienst/, 'der Agent läuft und sieht die Freigabe');
  const ctx = await externalContext(t.db, ap.id, await aud(ap.id, ['fliesen@extern.example']));
  assert.match(ctx.text, /Lieferfenster ist KW 47/);
  // Ohne den Satz, verneint oder als Frage bleibt eine Antwort intern
  for (const body of ['Noch ein interner Hinweis.', 'Das Budget beträgt 1,2 Mio. Nichts davon darf weitergegeben werden.', 'Kein Wort darf weitergegeben werden!', 'Was davon darf weitergegeben werden, kläre ich noch.']) {
    await t.api(pl).post(`/chat/channels/${dm.channel_id}/messages`, { body });
    await flushAgentRuns();
    assert.equal((await logOf(ap.id)).find((c) => c.body === `Rückmeldung per Chat an Außendienst: ${body}`)?.visibility, 'internal', body);
  }
  assert.ok(!(await externalContext(t.db, ap.id, await aud(ap.id, ['fliesen@extern.example']))).text.includes('1,2 Mio'));
  assert.equal(releasedText('Lieferung Montag. Das darf weitergegeben werden.'), 'Lieferung Montag.');
  assert.equal(releasedText('Termin 5.11.\nDarf weitergegeben werden'), 'Termin 5.11.');
  for (const no of ['Darf weitergegeben werden.', 'Ob das darf weitergegeben werden?', 'Das darf nicht weitergegeben werden.', 'Es darf weitergegeben werden, dass wir prüfen.']) assert.equal(releasedText(no), null, no);

  // Ohne Ansprechpartner im externen Profil: Verweis an „die Projektleitung“ über die Projektadresse, kein interner Name
  const prof = (await t.api(pl).get(`/projects/${web()}`)).json().project.externalProfile;
  await t.api(pl).put(`/projects/${web()}/external-profile`, { ...prof, contacts: [] });
  next = [A({ type: 'refer', text: 'Fragt nach den Kosten der Küche.', subject: 'Küche' })];
  const before2 = t.mail.dev.sent.length;
  await t.api(pl).post(`/tasks/${ap.id}/agent-run?wait=1`);
  assert.equal(t.mail.dev.sent.length, before2 + 1);
  const notice2 = t.mail.dev.sent.at(-1)!.msg;
  assert.match(notice2.text, /Ihre Frage zu „Küche“ gebe ich an die Projektleitung \(erreichbar über projekt-web@demo\.local\) weiter\./);
  for (const no of ['Petra', 'Lenz', 'pl@demo.local']) assert.ok(!notice2.text.includes(no), no);
  await t.api(pl).put(`/projects/${web()}/external-profile`, prof);
});

test('Kette (Regel C): Über-AP, Teilprojekt-Verantwortung mit Sicht, PL; Agenten-Chat nur an Interne', async () => {
  const pl = await t.login('pl@demo.local');
  const chain = async (title: string) => { const x = await t.db.one(`select id, project_id, parent_id, subproject_id from tasks where title = $1`, [title]); return (await contactChain(t.db, x, { exclude: [agent.id] })).map((c) => [c.name, c.why]); };
  const cmsN = (await t.db.one(`select number from tasks where title = 'CMS-Auswahl: Headless vs. klassisch'`)).number;
  assert.deepEqual(await chain('Angebot Agentur Müller-Design prüfen'), [['Max Keller', 'verantwortlich für Teilprojekt „Konzept & Design“'], ['Petra Lenz', 'Projektleitung'], ['Anna Berger', 'stellvertretende Projektleitung']]);
  assert.deepEqual((await chain('Anforderungen der Fachbereiche sammeln'))[0], ['Max Keller', `zuständig für WEB-${cmsN}`], 'Zuständige des Über-AP');
  // Eingeschränktes Teilprojekt: wer es nicht sieht, wird übersprungen
  const vertrag = await t.db.one(`select id from tasks where title = 'Agenturvertrag verhandeln'`);
  await t.db.query(`update tasks set responsible_user_id = $2 where id = $1`, [vertrag.id, t.ids.users.max]);
  const klausel = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Haftungsklausel prüfen', parentId: vertrag.id })).json().task;
  assert.ok(klausel?.id);
  assert.deepEqual((await chain('Haftungsklausel prüfen'))[0], ['Anna Berger', 'verantwortlich für Teilprojekt „Vertrag und Budget“']);
  await t.db.query(`update tasks set responsible_user_id = null where id = $1`, [vertrag.id]);

  // Agent an einem AP im eingeschränkten Teilprojekt: keine Direktnachricht an Mitglieder ohne Sicht, nicht in den Projektkanal
  next = [A({ type: 'none', reason: 'Start' })];
  await t.api(pl).patch(`/tasks/${vertrag.id}`, { responsibleUserId: agent.id });
  await flushAgentRuns();
  const dmsTo = async (userId: string) => (await t.db.one(`select count(*)::int as c from chat_messages m join chat_channel_members x on x.channel_id = m.channel_id and x.user_id = $2 join chat_channels c on c.id = m.channel_id and c.kind = 'dm' where m.user_id = $1`, [agent.id, userId])).c;
  const projectPosts = async () => (await t.db.one(`select count(*)::int as c from chat_messages m join chat_channels c on c.id = m.channel_id and c.kind = 'project' where m.user_id = $1`, [agent.id])).c;
  const max0 = await dmsTo(t.ids.users.max);
  const proj0 = await projectPosts();
  next = [A({ type: 'chat', to: ['max@demo.local'], text: 'Vertragsentwurf liegt bei 40.000 EUR.' })];
  const r1 = (await t.api(pl).post(`/tasks/${vertrag.id}/agent-run?wait=1`)).json();
  assert.match(String(r1.error), /Chat verworfen: Max Keller hat keinen Zugriff auf das Teilprojekt/);
  next = [A({ type: 'chat', to: ['projekt'], text: 'Vertragsentwurf liegt bei 40.000 EUR.' })];
  const r2 = (await t.api(pl).post(`/tasks/${vertrag.id}/agent-run?wait=1`)).json();
  assert.match(String(r2.error), /Projektkanal nicht bei eingeschränkten Teilprojekten/);
  assert.equal(await dmsTo(t.ids.users.max), max0);
  assert.equal(await projectPosts(), proj0);
  // Wer das Teilprojekt sieht, bekommt die Nachricht
  next = [A({ type: 'chat', to: ['anna@demo.local'], text: 'Bitte Haftungsklausel ansehen.' })];
  const anna0 = await dmsTo(t.ids.users.anna);
  const r3 = (await t.api(pl).post(`/tasks/${vertrag.id}/agent-run?wait=1`)).json();
  assert.equal(r3.error, undefined);
  assert.equal(await dmsTo(t.ids.users.anna), anna0 + 1);
  await t.api(pl).patch(`/tasks/${vertrag.id}`, { responsibleUserId: null });
});

test('Antwort auf die Ursprungsmail und PDF-Versand laufen über die Außengrenze; angehaltenes PDF hängt nach Freigabe die Seite an', async () => {
  const pl = await t.login('pl@demo.local');
  // reply_origin: Neuformulierung mit festem Betreff (Verlauf bleibt)
  t.mail.dev.inject(t.ids.accounts.project, { from: { address: 'kundin@extern.example', name: 'Kundin' }, to: ['projekt-web@demo.local'], subject: 'Frage zu Fliesenfarben', text: 'Welche Farben gibt es?', folder: 'INBOX' } as any);
  await t.mail.syncAccount(t.ids.accounts.project);
  const m1 = await t.db.one(`select id from mails where subject = 'Frage zu Fliesenfarben'`);
  next = [A({ type: 'none', reason: 'Start' })];
  const t1 = (await t.api(pl).post(`/mail/mails/${m1.id}/create-task`, { projectId: web() })).json().task;
  await t.api(pl).patch(`/tasks/${t1.id}`, { responsibleUserId: agent.id });
  await flushAgentRuns();
  compose = () => JSON.stringify({ subject: 'Anderer Betreff', text: 'Guten Tag,\n\nes gibt Weiß und Grau.\n\nViele Grüße', withheld: [] });
  next = [A({ type: 'reply_origin', text: 'Weiß und Grau, siehe Fliesenarbeiten Bad koordinieren.' })];
  const c0 = composes.length;
  await t.api(pl).post(`/tasks/${t1.id}/agent-run?wait=1`);
  assert.equal(composes.length, c0 + 1);
  const reply = t.mail.dev.sent.at(-1)!.msg;
  assert.equal(reply.subject, 'Re: Frage zu Fliesenfarben', 'Betreff der Antwort bleibt');
  assert.match(reply.text, /es gibt Weiß und Grau/);
  assert.equal((await t.db.one(`select channel from outbound_checks where task_id = $1 order by created_at desc limit 1`, [t1.id])).channel, 'reply_origin');

  // PDF an den Verteiler (gf@demo.local): Begleittext nennt eine nicht freigegebene Seite → Entwurf mit Seite, Freigabe mit Seitenfreigabe
  await t.api(pl).put(`/projects/${web()}/members/${agent.id}`, { role: 'member', agentCanMail: true, canFinalize: true });
  const page = await t.db.one(`select id from doc_pages where title = 'Protokoll JF Auftraggeber 02.10.2026'`);
  const report = await t.db.one(`select id from doc_pages where title = 'Statusbericht KW 41'`);
  next = [A({ type: 'doc_send_pdf', pageId: page.id, to: ['gf@demo.local'], subject: 'Protokoll JF', text: 'Anbei das Protokoll, Zahlen im Statusbericht KW 41.' })];
  const before = t.mail.dev.sent.length;
  await t.api(pl).post(`/tasks/${ap.id}/agent-run?wait=1`);
  assert.equal(t.mail.dev.sent.length, before);
  const draft = await t.db.one(`select * from mail_drafts where task_id = $1 and page_id is not null order by created_at desc limit 1`, [ap.id]);
  assert.equal(draft.page_id, page.id);
  const held = (await t.api(pl).get(`/projects/${web()}/outbound-checks?result=held`)).json().checks.find((c: any) => c.mailDraftId === draft.id);
  assert.equal(held.channel, 'pdf');
  assert.equal(held.draft.pageTitle, 'Protokoll JF Auftraggeber 02.10.2026');
  assert.equal(held.findings[0].pageId, report.id);
  // Seite inzwischen nicht mehr final: nichts gesendet, nichts freigegeben
  await t.db.query(`update doc_pages set status = 'draft' where id = $1`, [page.id]);
  const nf = await t.api(pl).post(`/outbound-checks/${held.id}/decide`, { action: 'release', sharePageIds: [report.id] });
  assert.equal(nf.statusCode, 400);
  assert.match(nf.json().error ?? nf.body, /nicht mehr final/);
  assert.equal(t.mail.dev.sent.length, before);
  assert.equal(await t.db.maybeOne(`select 1 from doc_shares where page_id = $1 and email = 'gf@demo.local'`, [report.id]), null);
  await t.db.query(`update doc_pages set status = 'final' where id = $1`, [page.id]);
  const d = await t.api(pl).post(`/outbound-checks/${held.id}/decide`, { action: 'release', sharePageIds: [report.id] });
  assert.equal(d.statusCode, 200, d.body);
  const sent = t.mail.dev.sent.at(-1)!.msg;
  assert.deepEqual(sent.to, ['gf@demo.local']);
  assert.match(sent.attachments![0].filename, /^Protokoll_JF_Auftraggeber_02\.10\.2026_v\d+\.pdf$/);
  assert.ok(await t.db.maybeOne(`select 1 from doc_shares where page_id = $1 and email = 'gf@demo.local' and mode = 'read' and revoked_at is null`, [report.id]), 'Seite in der Außenprüfung freigegeben');
  // Seite ist jetzt freigegeben: derselbe Begleittext geht durch
  next = [A({ type: 'doc_send_pdf', pageId: page.id, to: ['gf@demo.local'], subject: 'Protokoll JF 2', text: 'Anbei das Protokoll, Zahlen im Statusbericht KW 41.' })];
  await t.api(pl).post(`/tasks/${ap.id}/agent-run?wait=1`);
  assert.equal(t.mail.dev.sent.at(-1)!.msg.subject, 'Protokoll JF 2');

  // Senderecht ohne „Final setzen / Versand“: freigeben ja, Seiten freigeben nein
  const max = await t.login('max@demo.local');
  t.mail.dev.inject(t.ids.accounts.project, { from: { address: 'kunde2@extern.example', name: 'Kunde' }, to: ['projekt-web@demo.local'], subject: 'Frage zu Fugen', text: 'Welche Fugenfarbe?', folder: 'INBOX' } as any);
  await t.mail.syncAccount(t.ids.accounts.project);
  const m2 = await t.db.one(`select id from mails where subject = 'Frage zu Fugen'`);
  next = [A({ type: 'none', reason: 'Start' })];
  const t2x = (await t.api(pl).post(`/mail/mails/${m2.id}/create-task`, { projectId: web() })).json().task;
  await t.api(pl).patch(`/tasks/${t2x.id}`, { responsibleUserId: agent.id });
  await flushAgentRuns();
  compose = (p) => { const i = p.slice(p.lastIndexOf('Absicht des Agenten')); return JSON.stringify({ subject: i.match(/^Betreff: (.*)$/m)?.[1] ?? '', text: i.split(/^Text:\n/m)[1] ?? '', withheld: [] }); };
  next = [A({ type: 'reply_origin', text: 'Grau, wie im Statusbericht KW 41.' })];
  await t.api(pl).post(`/tasks/${t2x.id}/agent-run?wait=1`);
  const viaView = (await t.api(pl).get(`/projects/${web()}/outbound-checks?result=held`)).json().checks.find((c: any) => c.taskId === t2x.id);
  assert.equal(viaView.channel, 'reply_origin');
  assert.equal(viaView.findings[0].pageId, report.id);
  assert.equal((await t.api(max).post(`/outbound-checks/${viaView.id}/decide`, { action: 'release' })).statusCode, 403, 'Mitglied ohne Senderecht an der Ansicht');
  await t.db.query(`insert into mail_view_rights (view_id, user_id, can_read, can_draft, can_send, can_ai, can_create_task) values ($1,$2,true,true,true,false,false)`, [t.ids.views.project, t.ids.users.max]);
  assert.equal((await t.api(max).post(`/outbound-checks/${viaView.id}/decide`, { action: 'release', sharePageIds: [report.id] })).statusCode, 403);
  assert.equal(await t.db.maybeOne(`select 1 from doc_shares where page_id = $1 and email = 'kunde2@extern.example'`, [report.id]), null);
  const okMax = await t.api(max).post(`/outbound-checks/${viaView.id}/decide`, { action: 'release' });
  assert.equal(okMax.statusCode, 200, okMax.body);
  assert.deepEqual(t.mail.dev.sent.at(-1)!.msg.to, ['kunde2@extern.example']);
  await t.db.query(`delete from mail_view_rights where view_id = $1 and user_id = $2`, [t.ids.views.project, t.ids.users.max]);
});

test('Hinweise statt Sperre: Abschluss-Antwort mit KI zeigt Fundstellen; Chat-Agent gibt Org-Benutzern ohne Projektzugriff nichts aus dem Projekt', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const prof = (await t.api(admin).get('/ai/profiles')).json().profiles.find((p: any) => p.name === 'Lokales LLM');
  assert.equal((await t.api(pl).patch(`/projects/${web()}`, { aiProfileId: prof.id })).statusCode, 200);
  const t1 = await t.db.one(`select t.id from tasks t join mail_task_links l on l.task_id = t.id join mails m on m.id = l.mail_id where m.subject = 'Frage zu Fliesenfarben' and l.origin`);
  free = 'Guten Tag,\n\nerledigt; parallel läuft Elektroinstallation Küche planen.\n\nViele Grüße\nPetra Lenz';
  const r = await t.api(pl).get(`/tasks/${t1.id}/final-reply?ai=1`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().outbound.result, 'held');
  assert.equal(r.json().outbound.findings[0].kind, 'task');
  assert.match(r.json().body, /Elektroinstallation/, 'die Person entscheidet selbst');
  assert.equal((await t.api(pl).get(`/tasks/${t1.id}/final-reply`)).json().outbound, null, 'ohne KI keine Prüfung');

  // Direktnachricht vom Org-Admin (kein Projektmitglied): keine Arbeitspakete aus WEB im Prompt
  const dm = (await t.api(admin).post('/chat/dm', { userId: agent.id })).json();
  const channelId = dm.channel?.id ?? dm.id ?? dm.channelId;
  assert.ok(channelId, JSON.stringify(dm));
  const n0 = calls.length;
  await t.api(admin).post(`/chat/channels/${channelId}/messages`, { body: 'Woran arbeitest du gerade?' });
  await flushAgentRuns();
  // Ohne gemeinsames Projekt: Hilfe und Hinweis ohne LLM-Aufruf, nichts aus dem Projekt
  assert.ok(!calls.slice(n0).some((c) => String(c.messages[0].content).includes('# Chat')), 'kein Chat-Lauf nötig');
  const help = await t.db.one(`select body from chat_messages where channel_id = $1 and user_id = $2 order by created_at desc limit 1`, [channelId, agent.id]);
  assert.match(help.body, /kein gemeinsames Projekt/);
  assert.ok(!help.body.includes('Fliesenarbeiten'));
});
