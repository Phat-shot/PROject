import type { Db } from './db.js';
import type { MailService } from './mail/service.js';
import { publicBase } from './docs/share.js';

export type MailNotificationMode = 'off' | 'immediate' | 'daily';
/** Ab dieser Stunde (Serverzeit) geht der Tages-Digest raus. */
export const DIGEST_HOUR = 7;

/**
 * In-App-Meldungen per Mail über das Org-Postfach des Mandanten: je Benutzer „sofort“ (gesammelt pro Lauf),
 * „täglich“ (ein Digest ab DIGEST_HOUR) oder „aus“ (Standard: täglich). Gelesene Meldungen werden nicht mehr verschickt.
 * Ohne Org-Postfach passiert nichts; die Meldungen bleiben in der App.
 */
export async function runNotificationMails(db: Db, mail: MailService, now = new Date()): Promise<{ sent: number }> {
  const accounts = await db.query(`select distinct on (org_id) * from mail_accounts where type = 'org' order by org_id, created_at`);
  const byOrg = new Map<string, any>(accounts.rows.map((a: any) => [a.org_id, a]));
  if (byOrg.size === 0) return { sent: 0 };
  const users = await db.query(
    `select u.id, u.org_id, u.email, u.name, u.settings,
       (select max(mailed_at) from notifications n where n.user_id = u.id) as last_mailed
     from users u where u.active and u.org_id = any($1)
       and exists (select 1 from notifications n where n.user_id = u.id and n.mailed_at is null and n.read_at is null and n.created_at > now() - interval '7 days')`,
    [[...byOrg.keys()]]
  );
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  let sent = 0;
  for (const u of users.rows) {
    const mode: MailNotificationMode = u.settings?.mailNotifications ?? 'daily';
    if (mode === 'off') continue;
    if (mode === 'daily') {
      if (now.getHours() < DIGEST_HOUR) continue;
      if (u.last_mailed && new Date(u.last_mailed) >= dayStart) continue;
    }
    const rows = await db.query(
      `select n.*, p.key as project_key from notifications n left join projects p on p.id = n.project_id
       where n.user_id = $1 and n.mailed_at is null and n.read_at is null and n.created_at > now() - interval '7 days' order by n.created_at`,
      [u.id]
    );
    if (rows.rows.length === 0) continue;
    const base = publicBase();
    const lines = rows.rows.map((n: any) => `• ${n.project_key ? `[${n.project_key}] ` : ''}${n.title}${n.body ? ` – ${n.body}` : ''}${n.link ? `\n  ${base}${n.link}` : ''}`);
    const subject = rows.rows.length === 1 ? `PROject: ${rows.rows[0].title}` : `PROject: ${rows.rows.length} neue Meldungen`;
    const text = `Guten Tag ${u.name},\n\n${mode === 'daily' ? 'Ihre Meldungen aus PROject seit dem letzten Digest:' : 'Neue Meldungen aus PROject:'}\n\n${lines.join('\n\n')}\n\nEinstellung ändern: ${base}/einstellungen/benutzer\n`;
    try {
      await mail.sendFromAccount(byOrg.get(u.org_id), { to: [u.email], subject, text, userId: u.id });
      await db.query(`update notifications set mailed_at = $2 where id = any($1)`, [rows.rows.map((n: any) => n.id), now]);
      sent++;
    } catch (e: any) {
      console.warn(`[worker] Benachrichtigungsmail an ${u.email} fehlgeschlagen: ${String(e?.message ?? e)}`);
    }
  }
  return { sent };
}
