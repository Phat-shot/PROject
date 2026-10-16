import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { createDb, runMigrations } from './db.js';
import { MailService } from './mail/service.js';
import { seedDevMails, seedIfEmpty } from './seed.js';
import { ensureBuiltinTemplates } from './docs/service.js';
import { startWorker } from './worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const db = await createDb();
  const applied = await runMigrations(db);
  if (applied.length) console.log('Migrationen angewendet:', applied.join(', '));
  if (process.env.SEED !== 'false') await seedIfEmpty(db);
  await ensureBuiltinTemplates(db);

  const mail = new MailService(db);
  if (process.env.SEED !== 'false' && process.env.NODE_ENV !== 'production') {
    await seedDevMails(db, (id, m) => mail.dev.inject(id, m), (id) => mail.syncAccount(id));
  }
  const staticDir = process.env.STATIC_DIR ?? path.resolve(here, '..', '..', 'web', 'dist');
  const app = await buildApp({ db, mail, staticDir, logger: process.env.LOG !== 'false' });

  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
  const stop = startWorker(db, mail, { intervalMs: Number(process.env.SYNC_INTERVAL_MS ?? 60_000) });
  console.log(`Projekttool API läuft auf http://localhost:${port} (DB: ${db.kind})`);

  const shutdown = async () => {
    stop();
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
