import type { Db } from './db.js';
import type { MailService } from './mail/service.js';
import { publicBase } from './docs/share.js';
import { pagePdf } from './docs/layout.js';
import { audit } from './audit.js';
import { beforeLocal, dueLocal } from './localTime.js';
import { orgAccount, projectAccount } from './mail/accounts.js';

/** Stunde des Tages-Digests ohne Einstellung der Org (orgs.settings.notify.digestHour, Europe/Berlin). */
export const DEFAULT_DIGEST_HOUR = 7;
export const digestHourOf = (settings: any): number => {
  const h = Number(settings?.notify?.digestHour);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : DEFAULT_DIGEST_HOUR;
};

/**
 * In-App-Meldungen per Mail. Den Modus trägt jede Meldung selbst (beim Erzeugen nach Regel N festgeschrieben): „sofort“
 * geht gesammelt je Worker-Lauf, „Digest“ einmal am Tag ab der Digest-Stunde der Org (Europe/Berlin, dueLocal) zusammen mit
 * allem Offenen, das vor der Digest-Zeit des Tages entstand (spätere Digest-Meldungen warten bis zum nächsten Tag, auch wenn
 * zur Stunde nichts offen war), „aus“ nie. Gelesene Meldungen werden nicht mehr verschickt. Versand über das Org-Postfach; ohne Org-Postfach
 * gehen nur Lieferungen (Meldungen mit angehängter Seite) über das Projektkonto. Anhänge nur an interne Empfänger mit
 * Leserecht im Projekt der Seite. Fehler gehen ins Audit (notify.mail_failed).
 */
export async function runNotificationMails(db: Db, mail: MailService, now = new Date()): Promise<{ sent: number }> {
  const users = await db.query(
    `select u.id, u.org_id, u.email, u.name, o.settings as org_settings,
       (select max(mailed_at) from notifications n where n.user_id = u.id and n.mail = 'digest') as last_digest
     from users u join orgs o on o.id = u.org_id where u.active and u.kind = 'person'
       and exists (select 1 from notifications n where n.user_id = u.id and n.mailed_at is null and n.read_at is null and n.mail <> 'off' and n.created_at > $1::timestamptz - interval '7 days')`,
    [now]
  );
  const orgAccounts = new Map<string, any>();
  const orgAccountOf = async (orgId: string) => {
    if (!orgAccounts.has(orgId)) orgAccounts.set(orgId, await orgAccount(db, orgId));
    return orgAccounts.get(orgId);
  };
  let sent = 0;
  for (const u of users.rows) {
    const rows = (await db.query(
      `select n.*, p.key as project_key from notifications n left join projects p on p.id = n.project_id
       where n.user_id = $1 and n.mailed_at is null and n.read_at is null and n.mail <> 'off' and n.created_at > $2::timestamptz - interval '7 days' order by n.created_at`,
      [u.id, now]
    )).rows;
    const hour = digestHourOf(u.org_settings);
    const digest = dueLocal(now, hour, u.last_digest);
    const due = rows.filter((n: any) => n.mail === 'now' || (digest && beforeLocal(n.created_at, now, hour)));
    if (!due.length) continue;
    const account = await orgAccountOf(u.org_id);
    if (account) {
      if (await send(db, mail, account, u, due, digest && due.some((n: any) => n.mail === 'digest'), now)) sent++;
    } else {
      // Ohne Org-Postfach: Lieferungen einzeln über das Projektkonto ihres Projekts
      for (const n of due.filter((x: any) => x.attach && x.project_id)) {
        const pa = await projectAccount(db, n.project_id);
        if (pa && (await send(db, mail, pa, u, [n], false, now))) sent++;
      }
    }
  }
  return { sent };
}

async function send(db: Db, mail: MailService, account: any, u: any, rows: any[], isDigest: boolean, now: Date): Promise<boolean> {
  const base = publicBase();
  const lines = rows.map((n: any) => `• ${n.project_key ? `[${n.project_key}] ` : ''}${n.title}${n.body ? ` – ${n.body}` : ''}${n.link ? `\n  ${base}${n.link}` : ''}`);
  const subject = rows.length === 1 ? `PROject: ${rows[0].title}` : `PROject: ${rows.length} neue Meldungen`;
  const text = `Guten Tag ${u.name},\n\n${isDigest ? 'Ihre Meldungen aus PROject seit dem letzten Digest:' : 'Neue Meldungen aus PROject:'}\n\n${lines.join('\n\n')}\n\nEinstellung ändern: ${base}/einstellungen/benachrichtigungen\n`;
  try {
    const attachments = [];
    for (const n of rows.filter((x: any) => x.attach && x.ref_type === 'page' && x.ref_id)) {
      // Nur interne Empfänger mit Leserecht: ausdrückliches Mitglied oder Sichtbarkeit „alle Benutzer“ im Projekt der Seite
      const page = await db.maybeOne(
        `select d.* from doc_pages d join projects p on p.id = d.project_id where d.id = $1 and d.deleted_at is null and p.org_id = $2
           and (p.visibility = 'org' or exists (select 1 from project_members m where m.project_id = p.id and m.user_id = $3))`,
        [n.ref_id, u.org_id, u.id]
      );
      if (page) attachments.push(await pagePdf(db, page, 'PROject'));
    }
    await mail.sendFromAccount(account, { to: [u.email], subject, text, userId: u.id, ...(attachments.length ? { attachments } : {}) });
    await db.query(`update notifications set mailed_at = $2 where id = any($1)`, [rows.map((n: any) => n.id), now]);
    return true;
  } catch (e: any) {
    const error = String(e?.message ?? e).slice(0, 500);
    console.warn(`[worker] Benachrichtigungsmail an ${u.email} fehlgeschlagen: ${error}`);
    // Höchstens ein Eintrag je Person und Stunde (der Worker versucht es jede Minute erneut)
    if (!(await db.maybeOne(`select 1 from audit_log where action = 'notify.mail_failed' and object_id = $1 and created_at > now() - interval '1 hour'`, [u.id]))) await audit(db,{ orgId: u.org_id, userId: null, action: 'notify.mail_failed', objectType: 'user', objectId: u.id, details: { error, count: rows.length } });
    return false;
  }
}
