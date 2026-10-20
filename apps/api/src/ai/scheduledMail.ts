import type { Db } from '../db.js';
import type { MailService } from '../mail/service.js';
import type { AccountRow } from '../mail/types.js';
import * as L from '../docs/layout.js';

/**
 * Geplanter Versand (Arbeitszeitfenster, Konzept 8): Mails der Agenten nach außen, die außerhalb des Fensters entstanden sind,
 * sendet der Worker zum geplanten Zeitpunkt aus dem Konto des Entwurfs; mit page_id als PDF der Seite. Versandstatus ins Log.
 */
export async function runScheduledMails(db: Db, mail: MailService, now = new Date()): Promise<number> {
  const rows = await db.query(`select * from mail_drafts where status = 'scheduled' and send_at <= $1 order by send_at limit 20`, [now]);
  let n = 0;
  for (const d of rows.rows as any[]) {
    const log = (body: string) => (d.task_id ? db.query(`insert into task_comments (task_id, user_id, body, source) values ($1,$2,$3,'ai')`, [d.task_id, d.user_id, body]) : Promise.resolve());
    try {
      const account = await db.maybeOne<AccountRow>(`select * from mail_accounts where id = $1`, [d.account_id]);
      if (!account) throw new Error('Konto nicht mehr vorhanden');
      const to: string[] = d.to_addrs ?? []; const cc: string[] = d.cc_addrs ?? [];
      let attachments: { filename: string; content: Buffer; contentType: string }[] | undefined;
      if (d.page_id) {
        const page = await db.maybeOne(`select * from doc_pages where id = $1 and deleted_at is null`, [d.page_id]);
        if (!page) throw new Error('Seite nicht mehr vorhanden');
        if (page.status !== 'final') throw new Error(`Seite „${page.title}“ ist nicht mehr final`);
        const u = await db.one(`select name from users where id = $1`, [d.user_id]);
        const pdf = await L.pagePdf(db, page, u.name);
        await L.storePagePdf(db, page, pdf, d.user_id);
        attachments = [pdf];
      }
      await mail.sendFromAccount(account, { to, cc, subject: d.subject, text: d.body, taskId: d.task_id, inReplyTo: d.in_reply_to ?? null, references: d.in_reply_references ?? null, userId: d.user_id, projectId: d.project_id, attachments });
      await db.query(`update mail_drafts set status = 'sent', sent_at = now(), sent_by = $2 where id = $1`, [d.id, d.user_id]);
      await log(`Geplante Mail gesendet an ${to.join(', ')}: „${d.subject}“ (Arbeitszeitfenster)`);
      n++;
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 200);
      await db.query(`update mail_drafts set status = 'failed', error = $2 where id = $1`, [d.id, msg]);
      await log(`Geplante Mail an ${(d.to_addrs ?? []).join(', ')} nicht gesendet: ${msg}`);
    }
  }
  return n;
}
