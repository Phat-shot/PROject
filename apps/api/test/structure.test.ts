import test from 'node:test';
import assert from 'node:assert/strict';
import { composeEcho, testApp } from './helpers.js';
import { runAgentOnTask } from '../src/ai/agent.js';
import { flushAgentRuns } from '../src/ai/agentEvents.js';
import { applyPlanningDepth, planningDepthText } from '../src/ai/structure.js';

/** Lokales LLM: Agentenläufe liefern `next`, Prompts werden gesammelt. */
let next: any[] = [];
const prompts: string[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const echo = composeEcho(body);
  if (echo) return echo;
  if (String(input) !== 'http://llm.local:8000/v1/chat/completions') return new Response('{}', { status: 404 });
  prompts.push(String(body.messages?.at(-1)?.content ?? ''));
  const content = body.response_format ? JSON.stringify({ note: 'Struktur-Test', actions: next }) : 'bereit';
  return new Response(JSON.stringify({ model: 'qwen', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
};
delete process.env.ANTHROPIC_API_KEY;
const t = await testApp({ fetchFn: fakeFetch });
test.after(() => t.close());

const web = () => t.ids.projects.web;
const A = (x: Record<string, unknown>) => ({ type: 'none', text: '', column: '', itemId: '', to: [], subject: '', reason: '', kind: '', checkAfterHours: 0, until: '', remindAfterHours: 0, escalateAfterHours: 0, pageId: '', title: '', folder: '', status: '', ref: '', responsible: '', startDate: '', dueDate: '', subproject: '', items: [], startsAt: '', endsAt: '', location: '', questionId: '', meetingId: '', target: '', ...x });
const logOf = async (id: string) => (await t.db.query(`select body from task_comments where task_id = $1 order by created_at`, [id])).rows.map((r: any) => String(r.body));

test('Struktur-Regel (reine Funktion): auto, aufgaben, checkliste', () => {
  const auto = applyPlanningDepth([{ type: 'create_aufgabe', title: 'Angebot prüfen', ref: 'WEB-3' }, { type: 'create_aufgabe', title: 'Angebot prüfen', dueDate: '2026-11-20' }, { type: 'create_aufgabe', title: 'Angebot prüfen', items: ['a'] }], { depth: 'auto', isAp: true });
  assert.deepEqual(auto.actions.map((a) => a.type), ['add_item', 'create_aufgabe', 'create_aufgabe']);
  assert.equal((auto.actions[0] as any).ref, 'WEB-3');
  assert.equal(auto.notes.length, 1); assert.match(auto.notes[0], /als Checklistenpunkt angelegt, weil/);
  const check = applyPlanningDepth([{ type: 'create_aufgabe', title: 'Ein langer Schritt, der im Modus auto eine Aufgabe wäre, weil der Titel so lang ist', items: ['x', 'y'] }, { type: 'create_aufgabe', title: 'Mit Person', responsible: 'anna@demo.local' }], { depth: 'checkliste', isAp: true });
  assert.deepEqual(check.actions.map((a) => a.type), ['add_item', 'add_item', 'add_item', 'create_aufgabe']);
  const tasks = applyPlanningDepth([{ type: 'add_item', text: 'Grundriss prüfen' }, { type: 'add_item', text: 'Grundriss prüfen', ref: 'WEB-9' }], { depth: 'aufgaben', isAp: true });
  assert.deepEqual(tasks.actions.map((a) => a.type), ['create_aufgabe', 'add_item']);
  assert.equal(applyPlanningDepth([{ type: 'add_item', text: 'x' }], { depth: 'aufgaben', isAp: false }).actions[0].type, 'add_item', 'an einer Aufgabe bleibt die Checkliste');
  assert.match(planningDepthText('irgendwas'), /^Planungstiefe dieses Projekts: auto/);
});

test('Projekt-Einstellung planningDepth: Standard auto, PATCH prüft die Werte', async () => {
  const pl = await t.login('pl@demo.local');
  assert.equal((await t.api(pl).get(`/projects/${web()}`)).json().project.planningDepth, 'auto');
  assert.equal((await t.api(pl).patch(`/projects/${web()}`, { planningDepth: 'tief' })).statusCode, 400);
  assert.equal((await t.api(pl).patch(`/projects/${web()}`, { planningDepth: 'checkliste' })).statusCode, 200);
  assert.equal((await t.api(pl).get(`/projects/${web()}`)).json().project.planningDepth, 'checkliste');
  await t.api(pl).patch(`/projects/${web()}`, { planningDepth: 'auto' });
});

test('reparent: Aufgabe unter ein anderes Arbeitspaket (Teilprojekt folgt, Checkliste und Log bleiben), Grenzen, Rechte', async () => {
  const pl = await t.login('pl@demo.local');
  const sp = (await t.db.one(`select id from subprojects where project_id = $1 and not restricted order by position limit 1`, [web()])).id;
  const ap1 = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'AP Eins', responsibleUserId: t.ids.users.anna })).json().task;
  const ap2 = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'AP Zwei', subprojectId: sp, responsibleUserId: t.ids.users.max })).json().task;
  const a = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Schritt A', parentId: ap1.id })).json().task;
  await t.api(pl).post(`/tasks/${a.id}/checklist`, { title: 'Punkt 1' });
  await t.api(pl).post(`/tasks/${a.id}/comments`, { body: 'Stand A' });

  const leser = await t.login('leser@demo.local');
  assert.equal((await t.api(leser).post(`/tasks/${a.id}/reparent`, { parentId: ap2.id })).statusCode, 403, 'Leser nicht');
  assert.equal((await t.api(pl).post(`/tasks/${a.id}/reparent`, { parentId: a.id })).statusCode, 400, 'nicht unter sich selbst');
  assert.equal((await t.api(pl).post(`/tasks/${ap1.id}/reparent`, { parentId: ap2.id })).statusCode, 400, 'AP mit Aufgaben nicht unter ein AP');
  const erp = (await t.api(pl).post(`/projects/${t.ids.projects.erp}/tasks`, { title: 'Fremd' })).json().task;
  assert.equal((await t.api(pl).post(`/tasks/${a.id}/reparent`, { parentId: erp.id })).statusCode, 400, 'kein fremdes Projekt');

  const r = await t.api(pl).post(`/tasks/${a.id}/reparent`, { parentId: ap2.id });
  assert.equal(r.statusCode, 200, r.body);
  const moved = r.json().task;
  assert.equal(moved.parentId, ap2.id);
  assert.equal(moved.subprojectId, sp, 'Teilprojekt folgt dem neuen Arbeitspaket');
  assert.equal(moved.checklistTotal, 1);
  assert.ok((await logOf(a.id)).some((b) => /Verschoben: von WEB-\d+ „AP Eins“ unter WEB-\d+ „AP Zwei“/.test(b)), 'Log an der Aufgabe');
  assert.ok((await logOf(ap1.id)).some((b) => b.includes('nach WEB-') && b.includes('verschoben')), 'Log an der Quelle');
  assert.ok((await logOf(ap2.id)).some((b) => b.includes('hierher verschoben')), 'Log am Ziel');
  assert.equal((await t.api(pl).get(`/tasks/${ap2.id}`)).json().subtasks.length, 1);
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'task.reparent' and object_id = $1`, [a.id]), 'Audit');
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and ref_id = $2 and title like 'Verschoben:%'`, [t.ids.users.max, a.id]), 'Zuständiger des neuen AP informiert');
  // Keine zweite Ebene: Ziel darf keine Aufgabe sein
  const b = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Schritt B', parentId: ap1.id })).json().task;
  assert.equal((await t.api(pl).post(`/tasks/${b.id}/reparent`, { parentId: a.id })).statusCode, 400);

  // Aufgabe → eigenes Arbeitspaket: Spalte des bisherigen AP, Teilprojekt wählbar
  const col = (await t.db.one(`select id from board_columns where project_id = $1 and name = 'In Arbeit'`, [web()])).id;
  await t.api(pl).post(`/tasks/${ap2.id}/move`, { columnId: col });
  const up = await t.api(pl).post(`/tasks/${moved.id}/reparent`, { parentId: null, subprojectId: null });
  assert.equal(up.statusCode, 200, up.body);
  assert.equal(up.json().task.parentId, null);
  assert.equal(up.json().task.columnId, col);
  assert.equal(up.json().task.subprojectId, null);
  assert.ok((await logOf(ap2.id)).some((x) => x.includes('zum eigenen Arbeitspaket gemacht')));

  // Arbeitspaket → Teilprojekt (Aufgaben folgen)
  const tp = await t.api(pl).post(`/tasks/${ap1.id}/reparent`, { parentId: null, subprojectId: sp });
  assert.equal(tp.statusCode, 200, tp.body);
  assert.equal(tp.json().task.subprojectId, sp);
  assert.equal((await t.api(pl).get(`/tasks/${b.id}`)).json().task.subprojectId, sp);
  assert.ok((await logOf(ap1.id)).some((x) => /^Teilprojekt: keines → „/.test(x)));
});

test('Checklistenpunkt → Aufgabe, Aufgabe → Checklistenpunkt (mit Grund bei Zeiten), Punkt verschieben', async () => {
  const pl = await t.login('pl@demo.local');
  const ap = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'AP Umwandeln', responsibleUserId: t.ids.users.anna })).json().task;
  const other = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'AP Ziel' })).json().task;
  let d = (await t.api(pl).post(`/tasks/${ap.id}/checklist`, { title: 'Elektriker anfragen' })).json().task;
  const item = d.checklist[0];
  const pr = await t.api(pl).post(`/tasks/${ap.id}/checklist/${item.id}/promote`, { dueDate: '2026-11-20', responsibleUserId: t.ids.users.max });
  assert.equal(pr.statusCode, 200, pr.body);
  const nt = pr.json().task;
  assert.equal(nt.parentId, ap.id); assert.equal(nt.title, 'Elektriker anfragen'); assert.equal(nt.dueDate, '2026-11-20'); assert.equal(nt.responsibleUserId, t.ids.users.max);
  assert.equal(pr.json().source.checklistTotal, 0, 'Punkt entfernt');
  assert.ok((await logOf(ap.id)).some((x) => x.includes('wurde Aufgabe WEB-')));
  assert.ok(await t.db.maybeOne(`select 1 from notifications where user_id = $1 and ref_id = $2 and type = 'task.assigned'`, [t.ids.users.max, nt.id]));
  // Checkliste einer Aufgabe: Aufgabe am AP darüber
  d = (await t.api(pl).post(`/tasks/${nt.id}/checklist`, { title: 'Angebot vergleichen' })).json().task;
  const pr2 = await t.api(pl).post(`/tasks/${nt.id}/checklist/${d.checklist[0].id}/promote`, {});
  assert.equal(pr2.json().task.parentId, ap.id);

  // Aufgabe → Checklistenpunkt: erst mit Zeitbuchung verboten, dann mit Log-Zusammenfassung am AP
  await t.api(pl).post(`/tasks/${nt.id}/comments`, { body: 'Angebot liegt vor' });
  const te = await t.db.one(`insert into time_entries (project_id, task_id, user_id, date, minutes) values ($1,$2,$3,'2026-11-05',30) returning id`, [web(), nt.id, t.ids.users.pl]);
  const no = await t.api(pl).post(`/tasks/${nt.id}/demote`);
  assert.equal(no.statusCode, 400); assert.match(no.json().message ?? no.body, /Zeitbuchungen/);
  await t.db.query(`delete from time_entries where id = $1`, [te.id]);
  const de = await t.api(pl).post(`/tasks/${nt.id}/demote`);
  assert.equal(de.statusCode, 200, de.body);
  assert.equal(de.json().task.id, ap.id);
  const items = (await t.api(pl).get(`/tasks/${ap.id}`)).json().task.checklist;
  assert.ok(items.some((i: any) => i.title === 'Elektriker anfragen' && i.responsibleUserId === t.ids.users.max));
  assert.equal((await t.db.maybeOne(`select 1 from tasks where id = $1`, [nt.id])), null, 'Aufgabe gelöscht');
  assert.ok((await logOf(ap.id)).some((x) => x.includes('wurde Checklistenpunkt') && x.includes('Angebot liegt vor')), 'Log zusammengefasst');
  assert.equal((await t.api(pl).post(`/tasks/${ap.id}/demote`)).statusCode, 400, 'nur Aufgaben');

  // Punkt verschieben
  const it = items.find((i: any) => i.title === 'Elektriker anfragen');
  const mv = await t.api(pl).post(`/tasks/${ap.id}/checklist/${it.id}/move`, { toTaskId: other.id });
  assert.equal(mv.statusCode, 200, mv.body);
  assert.equal(mv.json().target.checklistTotal, 1);
  assert.ok((await logOf(other.id)).some((x) => x.includes('hierher verschoben')));
  assert.equal((await t.api(pl).post(`/tasks/${ap.id}/checklist/${it.id}/move`, { toTaskId: other.id })).statusCode, 400, 'Punkt hängt nicht mehr hier');
});

let agent: any;
const agentRow = () => ({ id: agent.id, name: agent.name, org_id: t.ids.org, persona: null });
/** Manueller Lauf ohne Nebenläufe: erst anstehende Läufe (Zuweisung, Änderungen) abwarten, danach nichts mehr aus `next` wiederholen. */
const runOwn = async (taskId: string, actions: any[]) => { await flushAgentRuns(); next = actions; const r = await runAgentOnTask(t.db, t.mail, fakeFetch, agentRow(), taskId, 'manual'); next = []; await flushAgentRuns(); return r; };

test('Agent: move_aufgabe, move_ap, promote_item, move_item, demote_aufgabe (Selbstständig) mit Log; Struktur-Regel im Prompt', async () => {
  const admin = await t.login('admin@demo.local');
  const pl = await t.login('pl@demo.local');
  const p = (await t.api(admin).post('/ai/profiles', { name: 'Qwen', provider: 'local', baseUrl: 'http://llm.local:8000/v1', model: 'qwen' })).json().profile;
  await t.api(admin).put('/ai/settings', { agentDailyBudget: 50 });
  agent = (await t.api(admin).post('/agents', { name: 'Struktura', aiProfileId: p.id })).json().agent;
  await t.api(pl).put(`/projects/${web()}/members/${agent.id}`, { role: 'pl' });
  await t.api(pl).put(`/projects/${web()}/agent-policy`, { mode: 'auto', confirm: [] });
  const sp = await t.api(pl).post(`/projects/${web()}/subprojects`, { name: 'Sanitär' });
  const own = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Bad planen', responsibleUserId: agent.id })).json().task;
  await flushAgentRuns();
  const target = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Bad umsetzen' })).json().task;
  const a1 = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Fliesen wählen', parentId: own.id })).json().task;
  const a2 = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Armaturen', parentId: own.id })).json().task;
  const items = (await t.api(pl).post(`/tasks/${own.id}/checklist`, { title: 'Maße prüfen' })).json().task.checklist;
  const items2 = (await t.api(pl).post(`/tasks/${own.id}/checklist`, { title: 'Fugenfarbe' })).json().task.checklist;
  const run = await runOwn(own.id, [
    A({ type: 'move_aufgabe', ref: `WEB-${a1.number}`, target: `WEB-${target.number}` }),
    A({ type: 'move_ap', ref: `WEB-${target.number}`, subproject: 'Sanitär' }),
    A({ type: 'promote_item', itemId: items[0].id, dueDate: '2026-11-25', responsible: 'anna@demo.local' }),
    A({ type: 'move_item', itemId: items2[1].id, target: `WEB-${target.number}` }),
    A({ type: 'demote_aufgabe', ref: `WEB-${a2.number}` }),
    A({ type: 'move_aufgabe', ref: `WEB-${own.number}`, target: `WEB-${target.number}` })
  ]);
  assert.deepEqual(run.actions.map((a: any) => a.type), ['move_aufgabe', 'move_ap', 'promote_item', 'move_item', 'demote_aufgabe'], run.error ?? '');
  assert.match(run.error ?? '', /ist ein Arbeitspaket/, 'AP nicht mit move_aufgabe');
  assert.match(prompts.at(-1)!, /Planungstiefe dieses Projekts: auto/);
  assert.equal((await t.api(pl).get(`/tasks/${a1.id}`)).json().task.parentId, target.id);
  assert.equal((await t.api(pl).get(`/tasks/${target.id}`)).json().task.subprojectId, sp.json().subproject.id);
  assert.equal((await t.api(pl).get(`/tasks/${a1.id}`)).json().task.subprojectId, sp.json().subproject.id, 'Aufgabe folgt dem Teilprojekt des AP');
  const d = (await t.api(pl).get(`/tasks/${own.id}`)).json();
  const promoted = d.subtasks.find((x: any) => x.title === 'Maße prüfen');
  assert.ok(promoted, 'Task wurde Aufgabe'); assert.equal(promoted.dueDate, '2026-11-25'); assert.equal(promoted.responsibleUserId, t.ids.users.anna);
  assert.ok(d.task.checklist.some((i: any) => i.title === 'Armaturen'), 'Aufgabe wurde Task');
  assert.ok(!d.task.checklist.some((i: any) => i.title === 'Fugenfarbe'), 'Task verschoben');
  assert.ok((await t.api(pl).get(`/tasks/${target.id}`)).json().task.checklist.some((i: any) => i.title === 'Fugenfarbe'));
  const log = await logOf(own.id);
  assert.ok(log.some((x) => x.includes('nach WEB-') && x.includes('verschoben (Struktura (KI-Agent))')), 'Log an der Quelle vom Agenten');
  assert.ok(await t.db.maybeOne(`select 1 from audit_log where action = 'task.reparent' and user_id = $1`, [agent.id]));
});

test('Agent: Rückfrage bei wichtigen Schritten hält Verschieben an (Klasse Umstrukturieren) und führt nach Bestätigung aus', async () => {
  const pl = await t.login('pl@demo.local');
  await t.api(pl).put(`/projects/${web()}/agent-policy`, { mode: 'confirm_critical' });
  const own = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Küche planen', responsibleUserId: agent.id })).json().task;
  await flushAgentRuns();
  const target = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Küche umsetzen' })).json().task;
  const a1 = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Geräte bestellen', parentId: own.id })).json().task;
    const run = await runOwn(own.id, [A({ type: 'comment', text: 'Ich hänge die Bestellung um.' }), A({ type: 'move_aufgabe', ref: `WEB-${a1.number}`, target: `WEB-${target.number}` })]);
  assert.equal(run.status, 'ok', run.error ?? '');
  assert.deepEqual(run.actions.map((a: any) => a.type), ['comment']);
  assert.equal((await t.api(pl).get(`/tasks/${a1.id}`)).json().task.parentId, own.id, 'noch nicht verschoben');
  const q = await t.db.one(`select * from questions where task_id = $1 and kind = 'approval' and status = 'open'`, [own.id]);
  const props = (await t.db.query(`select * from ai_proposals where question_id = $1`, [q.id])).rows;
  assert.equal(props.length, 1); assert.equal(props[0].action_class, 'restructure');
  assert.match(props[0].payload.label, /Aufgabe WEB-\d+ unter WEB-\d+ verschieben/);
  const r = await t.api(pl).post(`/questions/${q.id}/decide`, { approve: 'all' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await t.db.one(`select status from ai_proposals where id = $1`, [props[0].id])).status, 'approved');
  assert.equal((await t.api(pl).get(`/tasks/${a1.id}`)).json().task.parentId, target.id, 'nach Bestätigung verschoben');
  assert.ok((await logOf(own.id)).some((x) => x.startsWith('Ausgeführt nach Bestätigung')));
});

test('Agent: Struktur-Regel je Planungstiefe (auto, checkliste, aufgaben) mit Hinweis im Log und Lauf-Protokoll', async () => {
  const pl = await t.login('pl@demo.local');
  await t.api(pl).put(`/projects/${web()}/agent-policy`, { mode: 'auto', confirm: [] });
  const own = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Garten planen', responsibleUserId: agent.id })).json().task;
  await flushAgentRuns();
  // auto: kurz, ohne Termin und Zuständigkeit → Task; mit Termin → Aufgabe
    let run = await runOwn(own.id, [A({ type: 'create_aufgabe', title: 'Rasen mähen' }), A({ type: 'create_aufgabe', title: 'Hecke schneiden', dueDate: '2026-11-30' })]);
  assert.deepEqual(run.actions.map((a: any) => a.type), ['add_item', 'create_aufgabe'], run.error ?? '');
  let d = (await t.api(pl).get(`/tasks/${own.id}`)).json();
  assert.ok(d.task.checklist.some((i: any) => i.title === 'Rasen mähen'));
  assert.equal(d.subtasks.length, 1); assert.equal(d.subtasks[0].title, 'Hecke schneiden');
  assert.ok(d.comments.some((c: any) => c.body.startsWith('Struktur-Regel: „Rasen mähen“ als Checklistenpunkt angelegt, weil der Schritt weder Termin')), 'Hinweis im Log');
  assert.match((await t.db.one(`select reasoning from agent_runs where id = $1`, [run.runId])).reasoning, /Struktur-Regel/, 'Hinweis im Lauf-Protokoll');

  // checkliste: Aufgabe ohne Termin/Zuständigkeit wird Task, auch an einem anderen AP (ref), mit items
  await t.api(pl).patch(`/projects/${web()}`, { planningDepth: 'checkliste' });
  const other = (await t.api(pl).post(`/projects/${web()}/tasks`, { title: 'Terrasse', responsibleUserId: agent.id })).json().task;
  await flushAgentRuns();
    run = await runOwn(own.id, [A({ type: 'create_aufgabe', title: 'Holz bestellen, prüfen und abnehmen lassen mit dem ganzen Team vor Ort', ref: `WEB-${other.number}`, items: ['Maße', 'Preis'] }), A({ type: 'create_aufgabe', title: 'Mit Person', responsible: 'anna@demo.local' })]);
  assert.deepEqual(run.actions.map((a: any) => a.type), ['add_item', 'add_item', 'add_item', 'create_aufgabe'], run.error ?? '');
  assert.match(prompts.at(-1)!, /Planungstiefe dieses Projekts: checkliste/);
  const o = (await t.api(pl).get(`/tasks/${other.id}`)).json();
  assert.deepEqual(o.task.checklist.map((i: any) => i.title), ['Holz bestellen, prüfen und abnehmen lassen mit dem ganzen Team vor Ort', 'Maße', 'Preis']);
  assert.ok(o.comments.some((c: any) => c.body.startsWith('Task ergänzt:')), 'Log am Ziel-AP');
  assert.equal((await t.api(pl).get(`/tasks/${own.id}`)).json().subtasks.filter((x: any) => x.title === 'Mit Person').length, 1);

  // aufgaben: add_item wird Aufgabe; create_ap mit items legt Aufgaben an
  await t.api(pl).patch(`/projects/${web()}`, { planningDepth: 'aufgaben' });
    run = await runOwn(own.id, [A({ type: 'add_item', text: 'Beet anlegen' }), A({ type: 'create_ap', title: 'Zaun', items: ['Pfosten setzen', 'Latten montieren'] })]);
  assert.deepEqual(run.actions.map((a: any) => a.type), ['create_aufgabe', 'create_ap'], run.error ?? '');
  d = (await t.api(pl).get(`/tasks/${own.id}`)).json();
  assert.ok(d.subtasks.some((x: any) => x.title === 'Beet anlegen'));
  assert.ok(d.comments.some((c: any) => c.body.includes('als Aufgabe angelegt, weil die Planungstiefe des Projekts „Immer Aufgaben“ ist')));
  const zaun = await t.db.one(`select id from tasks where project_id = $1 and title = 'Zaun'`, [web()]);
  const z = (await t.api(pl).get(`/tasks/${zaun.id}`)).json();
  assert.equal(z.task.checklistTotal, 0); assert.deepEqual(z.subtasks.map((x: any) => x.title).sort(), ['Latten montieren', 'Pfosten setzen']);
  await t.api(pl).patch(`/projects/${web()}`, { planningDepth: 'auto' });
});
