import type { Db } from './db.js';
import type { MailService } from './mail/service.js';
import { dispatch } from './notify.js';
import { createRecurrenceInstance, dateStr, loadTasks } from './tasks/service.js';
import { nextDueDate, shouldCreateOnDue, type Recurrence } from './tasks/recurrence.js';
import { audit } from './audit.js';
import { runEscalations } from './tasks/escalation.js';
import { runReports } from './docs/report.js';
import { runNotificationMails } from './notifyMail.js';
import { runReminders } from './tasks/reminders.js';
import { runAgents } from './ai/agent.js';
import { runQueuedMailAi } from './ai/mailAi.js';
import { runWorkflows } from './workflows/engine.js';
import { runQuestions } from './questions.js';
import { expireWaits } from './tasks/waiting.js';
import { expireProposals } from './ai/agentApproval.js';
import { runScheduledMails } from './ai/scheduledMail.js';
import { runProjectReviews } from './ai/knowledge.js';
import { runUnconfirmedBookings } from './resources/service.js';

/** Tägliche Regelläufe: Erinnerungen (fällig bald, überfällig; Empfänger nach Regel N, Standard die zuständige Person) und Wiederholungen „vor Fälligkeit“. */
export async function runDailyRules(db: Db, today = new Date().toISOString().slice(0, 10)) {
  const soon = new Date(new Date(today + 'T00:00:00Z').getTime() + 3 * 86400_000).toISOString().slice(0, 10);
  const tasks = await loadTasks(db, `t.archived_at is null and exists (select 1 from projects p where p.id = t.project_id and p.status = 'active')`, []);
  let created = 0;
  for (const t of tasks) {
    if (t.done) continue;
    if (t.dueDate) {
      if (t.dueDate < today) {
        await dispatch(db, { event: 'due', projectId: t.projectId, taskId: t.id, type: 'task.overdue', title: `Überfällig: ${t.title}`, body: `Fällig war ${t.dueDate}`, link: `/projekte/${t.projectId}/board?task=${t.id}`, ref: { type: 'task', id: t.id }, dedupeKey: `overdue:${t.id}:${today}` });
      } else if (t.dueDate <= soon) {
        await dispatch(db, { event: 'due', projectId: t.projectId, taskId: t.id, type: 'task.due_soon', title: `Bald fällig: ${t.title}`, body: `Fällig am ${t.dueDate}`, link: `/projekte/${t.projectId}/board?task=${t.id}`, ref: { type: 'task', id: t.id }, dedupeKey: `due_soon:${t.id}:${t.dueDate}` });
      }
    }
  }
  // Wiederholung „vor Fälligkeit“: nächste Instanz anlegen, sobald lead_days erreicht sind
  const rec = await db.query(`select t.*, c.is_done from tasks t join board_columns c on c.id = t.column_id where t.recurrence is not null and t.archived_at is null and not t.recurrence_next_created and t.due_date is not null`);
  for (const r of rec.rows) {
    const rule: Recurrence = r.recurrence;
    if (rule.mode !== 'on_due') continue;
    const due = dateStr(r.due_date)!;
    if (!shouldCreateOnDue(due, rule, today)) continue;
    const next = nextDueDate(due, rule);
    const id = await createRecurrenceInstance(db, r, next, true);
    await db.query(`update tasks set recurrence_next_created = true where id = $1`, [r.id]);
    const org = await db.one(`select org_id from projects where id = $1`, [r.project_id]);
    await audit(db, { orgId: org.org_id, projectId: r.project_id, userId: null, action: 'task.recurrence_created', objectType: 'task', objectId: id, details: { from: r.id, due: next, trigger: 'on_due' } });
    created++;
  }
  return { created };
}

/** Tägliches Aufräumen: Papierkorb nach 30 Tagen; gelesene und erledigte Meldungen nach 180 Tagen (offene Fragen bleiben, bis sie erledigt sind). */
export async function runCleanup(db: Db) {
  await db.query(`delete from tasks where deleted_at < now() - interval '30 days'`);
  await db.query(`delete from doc_pages where deleted_at < now() - interval '30 days'`);
  await db.query(`delete from notifications where read_at is not null and created_at < now() - interval '180 days' and (ref_type is distinct from 'question' or resolved_at is not null)`);
}

/**
 * Worker: regelbasierte Abläufe ohne KI. Je Lauf: Mail-Synchronisation aller Konten, abgelaufene Sitzungen,
 * Benachrichtigungen per Mail (sofort bzw. Digest zur Stunde der Org in Europe/Berlin); einmal täglich Erinnerungen,
 * Wiederholungen, Eskalationen, Reports und das Aufräumen alter Meldungen.
 */
export function startWorker(db: Db, mail: MailService, opts: { intervalMs: number }) {
  let running = false;
  let lastAgents = 0;
  let lastDaily = '';
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const accounts = await db.query(`select id from mail_accounts`);
      for (const a of accounts.rows) {
        const r = await mail.syncAccount(a.id);
        if (r.error) console.warn(`[worker] Sync ${a.id} fehlgeschlagen: ${r.error}`);
      }
      await db.query(`delete from sessions where expires_at < now()`);
      await runNotificationMails(db, mail);
      if (Date.now() - lastAgents >= 60_000) { lastAgents = Date.now(); await runQuestions(db); await expireWaits(db); await expireProposals(db); await runScheduledMails(db, mail); await runProjectReviews(db, mail, fetch); await runAgents(db, mail, fetch); await runQueuedMailAi(db, mail, fetch); await runWorkflows(db, mail); }
      const today = new Date().toISOString().slice(0, 10);
      if (lastDaily !== today) {
        await runCleanup(db);
        await runDailyRules(db, today);
        await runEscalations(db, today);
        await runReminders(db, mail, today);
        await runReports(db, mail, today);
        await runUnconfirmedBookings(db);
        lastDaily = today;
      }
    } catch (e) {
      console.error('[worker]', e);
    } finally {
      running = false;
    }
  };
  const handle = setInterval(tick, opts.intervalMs);
  setTimeout(tick, 2000);
  return () => clearInterval(handle);
}
