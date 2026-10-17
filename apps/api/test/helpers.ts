import { buildApp } from '../src/app.js';
import { createDb, runMigrations } from '../src/db.js';
import { MailService } from '../src/mail/service.js';
import { seed, seedDevMails, DEMO_PASSWORD } from '../src/seed.js';

export async function testApp(opts: { fetchFn?: typeof fetch } = {}) {
  process.env.DATABASE_URL = 'memory';
  process.env.NODE_ENV = 'test';
  const db = await createDb();
  await runMigrations(db);
  const ids = await seed(db);
  const mail = new MailService(db, opts.fetchFn);
  await seedDevMails(db, (id, m) => mail.dev.inject(id, m), (id) => mail.syncAccount(id));
  const app = await buildApp({ db, mail, fetchFn: opts.fetchFn });
  await app.ready();

  async function login(email: string) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: DEMO_PASSWORD } });
    if (res.statusCode !== 200) throw new Error(`Login fehlgeschlagen: ${res.body}`);
    const cookie = res.cookies.find((c) => c.name === 'pt_session')!;
    return { pt_session: cookie.value };
  }

  const api = (cookies: Record<string, string>) => ({
    get: (url: string) => app.inject({ method: 'GET', url: `/api${url}`, cookies }),
    post: (url: string, payload?: unknown) => app.inject({ method: 'POST', url: `/api${url}`, cookies, payload: payload as any }),
    patch: (url: string, payload?: unknown) => app.inject({ method: 'PATCH', url: `/api${url}`, cookies, payload: payload as any }),
    put: (url: string, payload?: unknown) => app.inject({ method: 'PUT', url: `/api${url}`, cookies, payload: payload as any }),
    del: (url: string) => app.inject({ method: 'DELETE', url: `/api${url}`, cookies })
  });

  return { app, db, mail, ids, login, api, close: async () => { await app.close(); await db.close(); } };
}
