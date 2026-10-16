import type { Db } from './db.js';
import type { MailService } from './mail/service.js';
import { notify } from './notify.js';
import { createRecurrenceInstance, dateStr, loadTasks } from './tasks/service.js';
import { nextDueDate, shouldCreateOnDue, type Recurrence } from './tasks/recurrence.js';
import { audit } from './audit.js';

/** Tägliche Regelläufe: Erinnerungen (fällig bald, überfällig) und Wiederholungen „vor Fälligkeit“. */
export async function runDailyRules(db: Db, today = new Date().toISOString().slice(0, 10)) {
  const soon = new Date(new Date(today + 'T00:00:00Z').getTime() + 3 * 86400_000).toISOString().slice(0, 10);
  const tasks = await loadTasks(db, `t.archived_at is null and exists (select 1 from projects p where p.id = t.project_id and p.status = 'active')`, []);
  let created = 0;
  for (const t of tasks) {
    if (t.done) continue;
    if (t.dueDate && t.responsible.userId) {
      if (t.dueDate < today) {
        await notify(db, { userId: t.responsible.userId, projectId: t.projectId, type: 'task.overdue', title: `Überfällig: ${t.title}`, body: `Fällig war ${t.dueDate}`, link: `/projekte/${t.projectId}/board?task=${t.id}`, dedupeKey: `overdue:${t.id}:${today}` });
      } else if (t.dueDate <= soon) {
        await notify(db, { userId: t.responsible.userId, projectId: t.projectId, type: 'task.due_soon', title: `Bald fällig: ${t.title}`, body: `Fällig am ${t.dueDate}`, link: `/projekte/${t.projectId}/board?task=${t.id}`, dedupeKey: `due_soon:${t.id}` });
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

/**
 * Worker: regelbasierte Abläufe ohne KI. Alpha: Mail-Synchronisation aller Konten,
 * Aufräumen abgelaufener Sitzungen. Wiederholungen, Erinnerungen und Reports folgen.
 */
export function startWorker(db: Db, mail: MailService, opts: { intervalMs: number }) {
  let running = false;
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
      const today = new Date().toISOString().slice(0, 10);
      if (lastDaily !== today) {
        await runDailyRules(db, today);
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
