import type { Db } from './db.js';
import type { MailService } from './mail/service.js';

/**
 * Worker: regelbasierte Abläufe ohne KI. Alpha: Mail-Synchronisation aller Konten,
 * Aufräumen abgelaufener Sitzungen. Wiederholungen, Erinnerungen und Reports folgen.
 */
export function startWorker(db: Db, mail: MailService, opts: { intervalMs: number }) {
  let running = false;
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
