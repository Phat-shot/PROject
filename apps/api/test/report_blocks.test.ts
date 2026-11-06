import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { periodRange, renderReportBlocks, renderPortfolioReport, normalizeBlocks, ruleSummary, REPORT_BLOCK_TYPES } from '../src/docs/reportBlocks.js';
import { sanitizeHtml, htmlToMd } from '../src/docs/html.js';
import { htmlToPdf } from '../src/docs/pdfHtml.js';
import { reportingOf } from '../src/docs/report.js';
import { DEFAULT_REPORT_BLOCKS, REPORT_BLOCK_LABEL } from '@projekttool/shared';

/** Gefälschte Anthropic-API: Management-Summary erkennt sich am Prompt. */
const calls: { body: any }[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith('https://api.anthropic.com/v1/messages')) return new Response('{}', { status: 404 });
  const body = JSON.parse(String(init?.body));
  calls.push({ body });
  const prompt: string = body.messages[0].content;
  const text = prompt.includes('Management-Summary') ? '### Lage\n\nDas Projekt läuft mit leichtem Verzug.\n\n### Fortschritt\n\n2 von 12 erledigt.' : 'bereit';
  return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } });
};

delete process.env.ANTHROPIC_API_KEY;
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());
const TODAY = '2026-11-06';

test('periodRange: seit letztem Bericht, Woche, Monat, Quartal, n Tage mit Beschriftung', () => {
  assert.deepEqual(periodRange('since_last', undefined, '2026-10-30', TODAY), { since: '2026-10-30', label: 'seit 30.10.2026', days: 7 });
  assert.deepEqual(periodRange('since_last', undefined, null, TODAY), { since: '2026-10-30', label: 'letzte 7 Tage', days: 7 });
  assert.equal(periodRange('since_last', undefined, TODAY, TODAY).label, 'letzte 7 Tage', 'Lauf am selben Tag zählt nicht');
  assert.deepEqual(periodRange('week', undefined, '2026-10-01', TODAY), { since: '2026-10-30', label: 'letzte 7 Tage', days: 7 });
  assert.deepEqual(periodRange('month', undefined, null, TODAY), { since: '2026-10-07', label: 'letzte 30 Tage', days: 30 });
  assert.equal(periodRange('quarter', undefined, null, TODAY).since, '2026-08-08');
  assert.deepEqual(periodRange('days', 3, null, TODAY), { since: '2026-11-03', label: 'letzte 3 Tage', days: 3 });
  assert.equal(periodRange('days', undefined, null, TODAY).days, 7, 'days ohne Zahl: 7');
  assert.equal(periodRange('days', 9999, null, TODAY).days, 365);
  assert.equal(periodRange(undefined, undefined, null, TODAY).days, 7);
});

test('normalizeBlocks und reportingOf: nur bekannte Typen, Grenzen für Tage/Limit, Standardblöcke ohne Angabe', () => {
  const n = normalizeBlocks([{ id: 'a', type: 'summary', chart: true }, { type: 'kaputt' }, { type: 'outlook', days: 9999, limit: 0, title: ' Ausblick  ' }, { type: 'text', text: 'Hallo' }, null, 'x']);
  assert.deepEqual(n, [{ id: 'a', type: 'summary', chart: true }, { id: 'b3', type: 'outlook', days: 365, limit: 1, title: 'Ausblick' }, { id: 'b4', type: 'text', text: 'Hallo' }]);
  assert.equal(normalizeBlocks(undefined), undefined);
  assert.deepEqual(normalizeBlocks([]), []);
  const p = reportingOf({ enabled: true, textSource: 'nope', graphic: 'ja' });
  assert.deepEqual(p.blocks, DEFAULT_REPORT_BLOCKS);
  assert.equal(p.textSource, 'rules');
  assert.equal(p.graphic, true);
  assert.deepEqual(reportingOf({ blocks: [], graphic: false, textSource: 'ai' }).blocks, []);
  assert.equal(reportingOf({ graphic: false }).graphic, false);
});

test('Sanitizer: SVG-Grundformen bleiben, Skripte, Ereignisse und foreignObject fliegen raus; Markdown ohne Diagrammtext', () => {
  const svg = '<div class="report-chart"><svg xmlns="http://www.w3.org/2000/svg" width="100" height="20" viewBox="0 0 100 20" role="img" aria-label="Test"><g transform="translate(1,2)"><rect x="0" y="0" width="50" height="10" rx="2" fill="#2e7d32"></rect></g><line x1="0" y1="1" x2="9" y2="1" stroke="#ccc" stroke-width="1" stroke-dasharray="2,1"></line><circle cx="5" cy="5" r="3" fill="red"></circle><text x="1" y="9" font-size="9" text-anchor="middle" font-weight="bold">Label</text><path d="M0 0 L1 1" fill="none" stroke="#000"></path></svg></div>';
  const clean = sanitizeHtml(svg);
  for (const tag of ['<svg', '<g ', '<rect', '<line', '<circle', '<text', '<path']) assert.ok(clean.includes(tag), tag);
  for (const a of ['width="50"', 'rx="2"', 'fill="#2e7d32"', 'stroke-dasharray="2,1"', 'text-anchor="middle"', 'd="M0 0 L1 1"', 'transform="translate(1,2)"']) assert.ok(clean.includes(a), a);
  const dirty = sanitizeHtml('<svg width="10" height="10" onload="x()"><script>alert(1)</script><rect x="1" fill="red" onclick="y()"></rect><foreignObject><iframe src="https://evil"></iframe></foreignObject><a href="javascript:1"><text x="1" y="2">ok</text></a><image href="https://evil/t.png"></image><style>*{}</style></svg>');
  assert.ok(!/script|onload|onclick|foreignObject|iframe|javascript|<image|<style/i.test(dirty), dirty);
  assert.ok(dirty.includes('<text x="1" y="2">ok</text>'));
  assert.equal(htmlToMd('<h2>A</h2>' + svg + '<p>Text</p>').includes('Label'), false, 'Beschriftungen des Diagramms stehen nicht im Markdown');
});

test('Jeder Blocktyp rendert mit Demodaten (mit und ohne Grafik), Standardtitel oder eigener Titel, Fakten je Block', async () => {
  const pl = await t.login('pl@demo.local');
  for (const item of [{ kind: 'risk', title: 'Agentur liefert zu spät', probability: 4, impact: 4 }, { kind: 'risk', title: 'Budget reicht nicht', probability: 2, impact: 3 }, { kind: 'decision', title: 'CMS-Entscheidung', description: 'Headless oder klassisch' }, { kind: 'issue', title: 'Hosting-Vertrag unklar', status: 'mitigated' }]) {
    assert.equal((await t.api(pl).post(`/projects/${t.ids.projects.web}/raid`, item)).statusCode, 200);
  }
  const blocks = REPORT_BLOCK_TYPES.map((type, i) => ({ id: `b${i}`, type, chart: true, period: 'month' as const, text: type === 'text' ? '**Fett** und _kursiv_' : undefined }));
  const r = await renderReportBlocks(t.db, t.ids.projects.web, blocks, { today: TODAY, lastRunOn: '2026-10-30', graphic: true, textSource: 'rules' });
  for (const type of REPORT_BLOCK_TYPES) assert.ok(r.html.includes(`<h2>${REPORT_BLOCK_LABEL[type]}</h2>`), type);
  assert.ok(!r.html.includes('Block konnte nicht erzeugt werden'), r.html);
  assert.ok((r.html.match(/<svg/g) ?? []).length >= 6, 'Diagramme für Gesamtstand, Änderungen, Meilensteine, Teilprojekte, Risiken, Zeit');
  assert.ok(r.html.includes('<strong>Fett</strong>'));
  assert.ok(r.html.includes('(regelbasiert)'));
  assert.ok(r.html.includes('<strong>Lage.</strong>'));
  assert.equal(r.textSource, 'rules');
  const s = r.facts.summary as any;
  assert.equal(s.total, 12); assert.equal(s.done, 2); assert.equal(s.overdue, 2); assert.ok(['green', 'yellow', 'red'].includes(s.color));
  assert.ok((r.facts.overdue as any).count >= 2);
  const risks = r.facts.risks as any;
  assert.equal(risks.open, 4); assert.equal(risks.critical, 1); assert.equal(risks.openDecisions, 1);
  assert.ok(r.html.includes('R-1') && r.html.includes('4×4 = 16') && r.html.includes('Risikomatrix'));
  assert.ok(Array.isArray((r.facts.milestones as any).upcoming));
  assert.equal((r.facts.outlook as any).days, 14);
  assert.ok(r.html.includes('Design-Freigabe'), 'Meilenstein im Zeitstrahl und in der Tabelle');
  assert.ok(r.html.includes('Zeitraum: letzte 30 Tage'));
  // Ohne Grafik keine SVGs, eigener Titel ersetzt den Standard, Chart-Schalter je Block
  const plain = await renderReportBlocks(t.db, t.ids.projects.web, [{ id: 'x', type: 'summary', title: 'Lage auf einen Blick', chart: true }, { id: 'y', type: 'subprojects', chart: false }], { today: TODAY, graphic: false });
  assert.ok(!plain.html.includes('<svg'));
  assert.ok(plain.html.includes('<h2>Lage auf einen Blick</h2>'));
  const one = await renderReportBlocks(t.db, t.ids.projects.web, [{ id: 'x', type: 'summary', chart: true }, { id: 'y', type: 'subprojects', chart: false }], { today: TODAY, graphic: true });
  assert.equal((one.html.match(/<svg/g) ?? []).length, 1);
  // Ampel der PL geht vor der berechneten
  await t.db.query(`update projects set health = $2 where id = $1`, [t.ids.projects.web, JSON.stringify({ color: 'green', note: 'Alles im Griff', updatedAt: null, updatedBy: null })]);
  const h = await renderReportBlocks(t.db, t.ids.projects.web, [{ id: 'x', type: 'summary' }, { id: 'ai', type: 'ai_summary' }], { today: TODAY, graphic: false });
  assert.equal((h.facts.summary as any).color, 'green');
  assert.ok(h.html.includes('laut Projektleitung: Alles im Griff'));
  assert.ok(h.html.includes('liegt im Plan'));
  await t.db.query(`update projects set health = '{}'::jsonb where id = $1`, [t.ids.projects.web]);
  // Leere Blockliste = Standard
  const def = await renderReportBlocks(t.db, t.ids.projects.web, [], { today: TODAY, graphic: false });
  assert.ok(def.html.includes('<h2>Gesamtstand</h2>') && def.html.includes('<h2>Ausblick</h2>'));
});

test('Änderungsblock: erledigt, neu, Termin verschoben, Statuswechsel und Zuständigkeitswechsel aus dem Audit', async () => {
  const pl = await t.login('pl@demo.local');
  const tasks = (await t.api(pl).get(`/projects/${t.ids.projects.web}/tasks`)).json().tasks as any[];
  const open = tasks.find((x) => !x.done && x.title.startsWith('Hosting'));
  assert.equal((await t.api(pl).patch(`/tasks/${open.id}`, { dueDate: '2026-12-15' })).statusCode, 200);
  assert.equal((await t.api(pl).patch(`/tasks/${open.id}`, { responsibleUserId: t.ids.users.max })).statusCode, 200);
  const cols = (await t.api(pl).get(`/projects/${t.ids.projects.web}`)).json().columns as any[];
  const inWork = cols.find((c) => c.name === 'In Arbeit');
  assert.equal((await t.api(pl).patch(`/tasks/${open.id}`, { columnId: inWork.id })).statusCode, 200);
  const today = new Date().toISOString().slice(0, 10);
  const r = await renderReportBlocks(t.db, t.ids.projects.web, [{ id: 'c', type: 'changes', period: 'week', chart: true }], { today, graphic: true });
  const f = r.facts.changes as any;
  assert.ok(f.datesMoved >= 1, JSON.stringify(f));
  assert.ok(f.reassigned >= 1);
  assert.ok(f.statusChanges >= 1);
  assert.ok(r.html.includes('→ 15.12.2026'));
  assert.ok(r.html.includes('→ Max'));
  assert.ok(r.html.includes('→ In Arbeit'));
  assert.ok(r.html.includes('<svg'), 'Säulen erledigt vs. neu');
});

test('PDF: Berichts-HTML mit SVG-Diagrammen wird als Vektorgrafik gezeichnet', async () => {
  const r = await renderReportBlocks(t.db, t.ids.projects.web, DEFAULT_REPORT_BLOCKS, { today: TODAY, lastRunOn: '2026-10-30', graphic: true });
  const pdf = await htmlToPdf(t.db, `<h1>Test</h1>${r.html}`, { title: 'Test', project: 'WEB', projectId: t.ids.projects.web, version: 1, status: 'draft' });
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  assert.ok(pdf.length > 5000);
  // Ungültige oder leere Grafik stört nicht
  const odd = await htmlToPdf(t.db, '<p>a</p><svg width="0" height="0"></svg><svg width="100" height="30"><path d="kaputt"></path><rect x="1" y="1" width="10" height="10" fill="nope"></rect><text x="1" y="20" text-anchor="end">x</text><g transform="translate(5)"><circle cx="1" cy="1" r="2" fill="#abc"></circle></g></svg><p>b</p>', { title: 'T', project: 'P', version: 1, status: 'draft' });
  assert.equal(odd.subarray(0, 4).toString(), '%PDF');
});

test('Vorschau-Routen: HTML für PL und Leser, PDF-Download, Parameter geprüft, KI-Block ohne Agent regelbasiert', async () => {
  const pl = await t.login('pl@demo.local');
  const leser = await t.login('leser@demo.local');
  const pid = t.ids.projects.web;
  const r1 = await t.api(pl).post(`/projects/${pid}/reporting/preview`, { today: TODAY });
  assert.equal(r1.statusCode, 200, r1.body);
  assert.ok(r1.json().html.includes('<h2>Gesamtstand</h2>'));
  assert.ok(r1.json().html.includes('<svg'), 'Standard: grafisch');
  assert.equal(r1.json().title, 'Management-Report WEB 06.11.2026');
  const r2 = await t.api(leser).post(`/projects/${pid}/reporting/preview`, { blocks: [{ id: 'a', type: 'overdue' }, { id: 'b', type: 'ai_summary' }], textSource: 'ai', graphic: false, today: TODAY });
  assert.equal(r2.statusCode, 200, r2.body);
  assert.ok(!r2.json().html.includes('<svg'));
  assert.ok(r2.json().html.includes('(regelbasiert – KI nicht verfügbar'), r2.json().html);
  assert.equal(r2.json().textSource, 'rules');
  assert.equal((await t.api(pl).post(`/projects/${pid}/reporting/preview`, { today: '06.11.2026' })).statusCode, 400);
  assert.equal((await t.api(pl).post(`/projects/${pid}/reporting/preview`, { blocks: [{ type: 'unbekannt' }] })).statusCode, 400, 'nur unbekannte Typen = keine Blöcke');
  assert.equal((await t.api(await t.login('admin@demo.local')).post(`/projects/${pid}/reporting/preview`, {})).statusCode, 403, 'kein Mitglied');
  const pdf = await t.api(pl).get(`/projects/${pid}/reporting/preview.pdf?today=${TODAY}&blocks=${encodeURIComponent(JSON.stringify([{ id: 'a', type: 'summary', chart: true }, { id: 'm', type: 'milestones', chart: true }]))}`);
  assert.equal(pdf.statusCode, 200, pdf.body);
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.match(String(pdf.headers['content-disposition']), /attachment; filename="Management-Report_WEB_06.11.2026.pdf"/);
  assert.equal(pdf.rawPayload.subarray(0, 4).toString(), '%PDF');
  assert.equal((await t.api(pl).get(`/projects/${pid}/reporting/preview.pdf?blocks=kein-json`)).statusCode, 400);
});

test('KI-Management-Summary: Agent des Projekts mit assist.report schreibt den Text aus den Fakten, Kennzeichnung als KI-Text', async () => {
  const pl = await t.login('pl@demo.local');
  const admin = await t.login('admin@demo.local');
  const pid = t.ids.projects.web;
  const prof = (await t.api(admin).post('/ai/profiles', { name: 'Claude Test', provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'good' })).json().profile;
  const helper = (await t.api(admin).post('/agents', { name: 'Berichtsagent', aiProfileId: prof.id })).json().agent;
  assert.equal((await t.api(pl).put(`/projects/${pid}/members/${helper.id}`, { role: 'member' })).statusCode, 200);
  const before = calls.length;
  const r = await t.api(pl).post(`/projects/${pid}/reporting/preview`, { blocks: [{ id: 'ai', type: 'ai_summary', title: 'Summary' }, { id: 's', type: 'summary' }], textSource: 'ai', today: TODAY });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().textSource, 'ai');
  assert.ok(r.json().html.includes('<h2>Summary</h2>'));
  assert.ok(r.json().html.includes('leichtem Verzug'));
  assert.ok(r.json().html.includes('(KI-Text, geprüft von: –)'));
  assert.equal(calls.length, before + 1);
  const prompt: string = calls.at(-1)!.body.messages[0].content;
  assert.ok(prompt.includes('"total":12') && prompt.includes('"overdue"'), 'Fakten der Blöcke als Kontext');
  assert.ok(prompt.includes('Entscheidungsbedarf'));
  // Leser ohne „KI nutzen“: Regeltext mit Hinweis statt KI
  const leser = await t.login('leser@demo.local');
  const r2 = await t.api(leser).post(`/projects/${pid}/reporting/preview`, { blocks: [{ id: 'ai', type: 'ai_summary' }], textSource: 'ai', today: TODAY });
  assert.equal(r2.statusCode, 200);
  assert.ok(r2.json().html.includes('(regelbasiert – KI nicht verfügbar'));
  // Berichtslauf mit textSource ai: der Agent schreibt die Summary in die Seite
  assert.equal((await t.api(pl).patch(`/projects/${pid}`, { reporting: { enabled: true, mode: 'proposal', textSource: 'ai', blocks: [{ id: 'ai', type: 'ai_summary' }, { id: 's', type: 'summary', chart: true }] } })).statusCode, 200);
  const run = (await t.api(pl).post(`/projects/${pid}/reporting/run`)).json().result;
  const page = (await t.api(pl).get(`/docs/pages/${run.pageId}`)).json().page;
  assert.ok(page.contentHtml.includes('(KI-Text, geprüft von: –)'), page.contentHtml.slice(0, 500));
  assert.ok(page.contentHtml.includes('<svg'));
  await t.api(pl).patch(`/projects/${pid}`, { reporting: { enabled: false, textSource: 'rules', blocks: DEFAULT_REPORT_BLOCKS } });
});

test('Berichtslauf: Blöcke aus der Policy, Monatsrhythmus im Titel, leere Blockliste = alter Kennzahlenblock', async () => {
  const pl = await t.login('pl@demo.local');
  const pid = t.ids.projects.web;
  assert.equal((await t.api(pl).patch(`/projects/${pid}`, { reporting: { enabled: true, mode: 'proposal', interval: 'monthly', dayOfMonth: 1, blocks: [{ id: 'a', type: 'summary', chart: false }, { id: 't', type: 'text', text: '# Hinweis\n\nFreitext der PL' }] } })).statusCode, 200);
  const pol = (await t.api(pl).get(`/projects/${pid}`)).json().project.reporting;
  assert.equal(pol.blocks.length, 2);
  assert.equal(pol.graphic, true);
  const run = (await t.api(pl).post(`/projects/${pid}/reporting/run`)).json().result;
  assert.match(run.title, /^Statusbericht WEB (Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember) \d{4}$/);
  const page = (await t.api(pl).get(`/docs/pages/${run.pageId}`)).json().page;
  assert.ok(page.contentHtml.includes('<h2>Gesamtstand</h2>'));
  assert.ok(page.contentHtml.includes('Freitext der PL'));
  assert.ok(!page.contentHtml.includes('<svg'), 'chart: false');
  assert.equal((await t.api(pl).patch(`/projects/${pid}`, { reporting: { blocks: [] } })).statusCode, 200);
  const run2 = (await t.api(pl).post(`/projects/${pid}/reporting/run`)).json().result;
  const page2 = (await t.api(pl).get(`/docs/pages/${run2.pageId}`)).json().page;
  assert.ok(page2.contentHtml.includes('Kennzahlen (automatisch'), 'Fallback');
  await t.api(pl).patch(`/projects/${pid}`, { reporting: { enabled: false, interval: 'weekly', blocks: DEFAULT_REPORT_BLOCKS } });
});

test('Portfolio-Report: nur lesbare Projekte, kompakte Tabelle mit Ampel, Balkenliste, Detailblöcke je Projekt, PDF', async () => {
  const pl = await t.login('pl@demo.local');
  const leser = await t.login('leser@demo.local');
  const r = await t.api(pl).post('/portfolio/report', { period: 'month', today: TODAY, blocks: [{ id: 'm', type: 'milestones' }, { id: 'o', type: 'outlook', days: 30 }, { id: 'x', type: 'ai_summary' }] });
  assert.equal(r.statusCode, 200, r.body);
  const keys = r.json().projects.map((p: any) => p.key).sort();
  assert.deepEqual(keys, ['ERP', 'WEB']);
  assert.ok(r.json().html.includes('<h2>Gesamtübersicht</h2>'));
  assert.ok(r.json().html.includes('<svg'));
  assert.ok(r.json().html.includes('<h2>WEB Website-Relaunch</h2>') && r.json().html.includes('<h3>Meilensteine</h3>') && r.json().html.includes('Horizont: 30 Tage'));
  assert.ok(!r.json().html.includes('Management-Summary'), 'KI-Block gehört nicht ins Portfolio');
  assert.equal(r.json().title, 'Portfolio-Report 06.11.2026');
  // Leser sieht nur WEB; fremde projectIds fallen heraus
  const r2 = await t.api(leser).post('/portfolio/report', { today: TODAY, graphic: false });
  assert.deepEqual(r2.json().projects.map((p: any) => p.key), ['WEB']);
  assert.ok(!r2.json().html.includes('<svg'));
  const r3 = await t.api(leser).post('/portfolio/report', { projectIds: [t.ids.projects.erp], today: TODAY });
  assert.equal(r3.statusCode, 200);
  assert.deepEqual(r3.json().projects, []);
  assert.equal((await t.api(pl).post('/portfolio/report', { projectIds: ['x'] })).statusCode, 400);
  assert.equal((await t.api(pl).post('/portfolio/report', { period: 'jahr' })).statusCode, 400);
  assert.equal((await t.app.inject({ method: 'POST', url: '/api/portfolio/report', payload: {} })).statusCode, 401);
  const pdf = await t.api(pl).get(`/portfolio/report.pdf?today=${TODAY}&period=week&blocks=${encodeURIComponent(JSON.stringify([{ id: 'c', type: 'changes' }]))}`);
  assert.equal(pdf.statusCode, 200, pdf.body);
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.equal(pdf.rawPayload.subarray(0, 4).toString(), '%PDF');
  const direct = await renderPortfolioReport(t.db, [], { today: TODAY });
  assert.ok(direct.html.includes('0 Projekte'));
});

test('Regeltext: Satzbausteine je Lage', () => {
  const base = { project: { id: 'x', key: 'K', name: 'Test' }, today: TODAY } as any;
  const s = { color: 'red', total: 10, done: 2, pct: 20, planned: 5, plannedDone: 1, plannedPct: 20, overdue: 4, blocked: 1, escalations: 2, escalationsHigh: 1, dueWeek: 3, healthSet: null, healthNote: null };
  const red = ruleSummary({ ...base, summary: s, risks: { open: 3, critical: 1, openDecisions: 2 } });
  assert.ok(red.includes('steht auf Rot: 4 überfällig, 1 blockiert, 2 Eskalationen'));
  assert.ok(red.includes('Entscheidungsbedarf: 2 offene Entscheidungen') && red.includes('1 Eskalationen ab Stufe 2'));
  const green = ruleSummary({ ...base, summary: { ...s, color: 'green', overdue: 0, blocked: 0, escalations: 0, escalationsHigh: 0 }, milestones: { upcoming: [{ name: 'Go-Live', date: '2027-02-25', days: 111 }], reached: [] }, outlook: { days: 14, dueCount: 2 } });
  assert.ok(green.includes('liegt im Plan') && green.includes('Kein Entscheidungsbedarf') && green.includes('„Go-Live“ am 25.02.2027 (in 111 Tagen)') && green.includes('2 Arbeitspakete werden in den nächsten 14 Tagen fällig'));
  assert.ok(ruleSummary({ ...base, summary: { ...s, color: 'yellow' } }).includes('ist in Verzug (4 überfällig, 1 blockiert)'));
  assert.ok(ruleSummary(base).includes('Keine Kennzahlen'));
});
