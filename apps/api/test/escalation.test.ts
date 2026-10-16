import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { criticality, targetLevel, DEFAULT_POLICY, runEscalations } from '../src/tasks/escalation.js';

let t: Awaited<ReturnType<typeof testApp>>;
before(async () => { t = await testApp(); });
after(async () => { await t.close(); });

test('Kritikalität und Stufenregel', () => {
  assert.equal(criticality({ priority: 'normal', overdueDays: 0, successors: 0, milestoneWithinDays: null, blocked: false }), 0);
  const high = criticality({ priority: 'critical', overdueDays: 3, successors: 2, milestoneWithinDays: 10, blocked: false });
  assert.ok(high >= 6);
  assert.equal(targetLevel({ overdueDays: 1, staleDays: 0, blocked: false, score: 0 }, DEFAULT_POLICY), 0);
  assert.equal(targetLevel({ overdueDays: 2, staleDays: 0, blocked: false, score: 0 }, DEFAULT_POLICY), 1);
  assert.equal(targetLevel({ overdueDays: 5, staleDays: 0, blocked: false, score: 0 }, DEFAULT_POLICY), 2);
  assert.equal(targetLevel({ overdueDays: 10, staleDays: 0, blocked: false, score: 0 }, DEFAULT_POLICY), 3);
  // Hohe Kritikalität halbiert die Fristen
  assert.equal(targetLevel({ overdueDays: 1, staleDays: 0, blocked: false, score: 7 }, DEFAULT_POLICY), 1);
  assert.equal(targetLevel({ overdueDays: 5, staleDays: 0, blocked: false, score: 7 }, DEFAULT_POLICY), 3);
  // Blockiert oder hängt → mindestens Stufe 1
  assert.equal(targetLevel({ overdueDays: 0, staleDays: 0, blocked: true, score: 2 }, DEFAULT_POLICY), 1);
  assert.equal(targetLevel({ overdueDays: 0, staleDays: 7, blocked: false, score: 0 }, DEFAULT_POLICY), 1);
});

test('Worker eskaliert entlang der Kette und setzt zurück, Blockiert-Flag informiert sofort', async () => {
  const pl = await t.login('pl@demo.local');
  // Aufgabe im Teilprojekt „Konzept & Design“ (Verantwortlich Max), zuständig Lea, Deadline in der Vergangenheit
  const detail = (await t.api(pl).get(`/projects/${t.ids.projects.web}`)).json();
  const konzept = detail.subprojects.find((s: any) => s.name.startsWith('Konzept'));
  const created = await t.api(pl).post(`/projects/${t.ids.projects.web}/tasks`, { title: 'Freigabe Bildrechte', subprojectId: konzept.id, dueDate: '2026-10-01', responsibleUserId: t.ids.users.leser, priority: 'normal' });
  const taskId = created.json().task.id;
  // Eskalationskontakt setzen (intern Admin, extern Auftraggeber)
  const pol = await t.api(pl).patch(`/projects/${t.ids.projects.web}`, { escalation: { contactUserId: t.ids.users.admin, contactEmail: 'gf@kunde.de', externalMode: 'proposal' } });
  assert.equal(pol.statusCode, 200, pol.body);
  assert.equal((await t.api(pl).patch(`/projects/${t.ids.projects.web}`, { escalation: { stageDays: [5, 2, 10] } })).statusCode, 400);

  // Tag 2 → Stufe 1 (Max als TP-Verantwortlicher)
  let r = await runEscalations(t.db, '2026-10-03');
  assert.ok(r.raised >= 1);
  let task = (await t.api(pl).get(`/tasks/${taskId}`)).json();
  assert.equal(task.task.escalationLevel, 1);
  const max = await t.login('max@demo.local');
  assert.ok((await t.api(max).get('/notifications')).json().notifications.some((n: any) => n.type === 'escalation' && n.title.includes('Stufe 1') && n.title.includes('Bildrechte')));
  // Tag 5 → Stufe 2 (PL)
  await runEscalations(t.db, '2026-10-06');
  task = (await t.api(pl).get(`/tasks/${taskId}`)).json();
  assert.equal(task.task.escalationLevel, 2);
  assert.ok((await t.api(pl).get('/notifications')).json().notifications.some((n: any) => n.type === 'escalation' && n.title.includes('Stufe 2')));
  // Tag 10 → Stufe 3: interner Kontakt benachrichtigt, externe Mail als Entwurf zur Freigabe
  await runEscalations(t.db, '2026-10-11');
  task = (await t.api(pl).get(`/tasks/${taskId}`)).json();
  assert.equal(task.task.escalationLevel, 3);
  const admin = await t.login('admin@demo.local');
  assert.ok((await t.api(admin).get('/notifications')).json().notifications.some((n: any) => n.type === 'escalation' && n.title.includes('Stufe 3')));
  const drafts = (await t.api(pl).get(`/projects/${t.ids.projects.web}/mail/drafts`)).json().drafts;
  const esc = drafts.find((d: any) => d.subject.startsWith('Eskalation WEB'));
  assert.ok(esc, 'Eskalationsmail-Entwurf');
  assert.equal(esc.status, 'pending_approval');
  assert.deepEqual(esc.toAddrs, ['gf@kunde.de']);
  assert.ok(task.comments.filter((c: any) => c.source === 'system').length >= 3, 'Log-Einträge je Stufe');
  // Warnungen-Endpunkt
  const w = await t.api(pl).get(`/projects/${t.ids.projects.web}/escalations`);
  assert.ok(w.json().escalations.some((e: any) => e.taskId === taskId && e.chain.length === 4));
  // Deadline in die Zukunft → Rücksetzung
  await t.api(pl).patch(`/tasks/${taskId}`, { dueDate: '2027-01-15' });
  const back = await runEscalations(t.db, '2026-10-12');
  assert.ok(back.reset >= 1);
  task = (await t.api(pl).get(`/tasks/${taskId}`)).json();
  assert.equal(task.task.escalationLevel, 0);

  // Blockiert-Flag: sofortige Meldung an TP-Verantwortung, Stufe 1 beim nächsten Lauf
  const lea = await t.login('leser@demo.local');
  assert.equal((await t.api(lea).patch(`/tasks/${taskId}`, { blocked: true, blockedReason: 'Lizenz unklar' })).statusCode, 403, 'Leser darf nicht ändern');
  const blk = await t.api(max).patch(`/tasks/${taskId}`, { blocked: true, blockedReason: 'Lizenz unklar' });
  assert.equal(blk.statusCode, 200, blk.body);
  assert.equal(blk.json().task.blocked, true);
  await runEscalations(t.db, '2026-10-13');
  task = (await t.api(pl).get(`/tasks/${taskId}`)).json();
  assert.equal(task.task.escalationLevel, 1);
  // Manuell auf Stufe 2, Reset durch PL
  const man = await t.api(max).post(`/tasks/${taskId}/escalate`, { level: 2, note: 'Entscheidung nötig' });
  assert.equal(man.statusCode, 200, man.body);
  assert.equal(man.json().task.escalationLevel, 2);
  assert.equal((await t.api(max).post(`/tasks/${taskId}/escalation/reset`)).statusCode, 403);
  assert.equal((await t.api(pl).post(`/tasks/${taskId}/escalation/reset`)).json().task.escalationLevel, 0);
});

test('Mandanten-Einstellungen für PDF-Stil', async () => {
  const pl = await t.login('pl@demo.local');
  assert.equal((await t.api(pl).put('/org/settings', { accentColor: '#aa0000' })).statusCode, 403);
  const admin = await t.login('admin@demo.local');
  assert.equal((await t.api(admin).put('/org/settings', { accentColor: 'rot' })).statusCode, 400);
  const ok = await t.api(admin).put('/org/settings', { company: 'Demo GmbH', accentColor: '#aa0000', footerText: 'Vertraulich' });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal((await t.api(pl).get('/org/settings')).json().settings.accentColor, '#aa0000');
  const docs = (await t.api(pl).get(`/projects/${t.ids.projects.web}/docs`)).json();
  const p = docs.pages.find((x: any) => x.title.startsWith('Projektauftrag'));
  const pdf = await t.api(pl).get(`/docs/pages/${p.id}/pdf`);
  assert.equal(pdf.statusCode, 200);
  assert.ok(pdf.rawPayload.length > 2000);
});
