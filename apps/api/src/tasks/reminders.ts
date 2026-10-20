import type { Db } from '../db.js';
import type { MailService } from '../mail/service.js';
import type { ReminderPolicy } from '@projekttool/shared';
import { loadTasks, resolveProjectLead } from './service.js';
import { publicBase } from '../docs/share.js';
import { projectAccount } from '../mail/accounts.js';

const DEFAULT: ReminderPolicy = { enabled: false, daysBefore: [3, 0], overdueEveryDays: 3, includeInternal: false };

export function remindersOf(raw: any): ReminderPolicy {
  const p = { ...DEFAULT, ...(raw ?? {}) };
  p.daysBefore = Array.isArray(p.daysBefore) ? ([...new Set<number>(p.daysBefore.map((d: any) => Number(d)).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 60))] as number[]).sort((a, b) => b - a) : DEFAULT.daysBefore;
  p.overdueEveryDays = p.overdueEveryDays == null ? null : Math.max(1, Math.min(30, Number(p.overdueEveryDays) || 1));
  return p;
}

const fmt = (iso: string) => iso.split('-').reverse().join('.');
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400_000);

/**
 * Erinnerungen vor und nach der Fälligkeit über das Projektkonto: an externe Zuständige (Mail-Adresse), auf Wunsch auch
 * an interne. Antworten landen über die Plus-Adresse im Arbeitspaket. Je Arbeitspaket, Art und Tag höchstens eine Mail.
 */
export async function runReminders(db: Db, mail: MailService, today: string): Promise<{ sent: number }> {
  const projects = await db.query(`select p.* from projects p where p.status = 'active' and (p.reminders->>'enabled')::boolean`);
  let sent = 0;
  for (const p of projects.rows) {
    const policy = remindersOf(p.reminders);
    const account = await projectAccount(db, p.id);
    if (!account) continue;
    const lead = await resolveProjectLead(db, p.id);
    const tasks = await loadTasks(db, `t.project_id = $1 and t.archived_at is null and t.due_date is not null`, [p.id], lead);
    for (const t of tasks) {
      if (t.done || !t.dueDate) continue;
      const to = t.responsibleEmail ?? (policy.includeInternal ? t.responsible.email : null);
      if (!to) continue;
      const diff = daysBetween(today, t.dueDate); // >0 vor Fälligkeit, <0 überfällig
      let kind: string | null = null;
      if (diff >= 0 && policy.daysBefore.includes(diff)) kind = `before:${diff}`;
      else if (diff < 0 && policy.overdueEveryDays && (-diff) % policy.overdueEveryDays === 0) kind = 'overdue';
      if (!kind) continue;
      const dup = await db.maybeOne(`select 1 from task_reminders where task_id = $1 and kind = $2 and sent_on = $3`, [t.id, kind, today]);
      if (dup) continue;
      const open = (await db.query(`select title from checklist_items where task_id = $1 and not done order by position`, [t.id])).rows.map((r: any) => `  • ${r.title}`);
      const subject = diff < 0 ? `${p.key}-${t.number}: überfällig seit ${-diff} Tag(en) – ${t.title}` : diff === 0 ? `${p.key}-${t.number}: heute fällig – ${t.title}` : `${p.key}-${t.number}: in ${diff} Tag(en) fällig – ${t.title}`;
      const text = `Guten Tag,\n\n${diff < 0 ? `das Arbeitspaket „${t.title}“ war am ${fmt(t.dueDate)} fällig.` : `das Arbeitspaket „${t.title}“ ist am ${fmt(t.dueDate)} fällig.`}${open.length ? `\n\nOffene Punkte:\n${open.join('\n')}` : ''}\n\nBitte antworten Sie einfach auf diese Mail mit dem aktuellen Stand; die Antwort landet automatisch im Arbeitspaket.\n\nProjekt ${p.name}\n${publicBase()}\n`;
      try {
        await mail.sendFromAccount(account, { to: [to], subject, text, taskId: t.id, userId: lead.userId ?? p.created_by, projectId: p.id });
        await db.query(`insert into task_reminders (task_id, kind, sent_on) values ($1,$2,$3) on conflict do nothing`, [t.id, kind, today]);
        sent++;
      } catch (e: any) {
        console.warn(`[worker] Erinnerung ${p.key}-${t.number} an ${to} fehlgeschlagen: ${String(e?.message ?? e)}`);
      }
    }
  }
  return { sent };
}
