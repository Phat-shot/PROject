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
  // Tests laufen zu jeder Uhrzeit: das Arbeitszeitfenster für Mails nach außen ist hier aus (eigener Test schaltet es ein)
  await db.query(`update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{ai}', coalesce(settings->'ai', '{}'::jsonb) || '{"externalWindow":{"enabled":false}}'::jsonb)`);
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

/**
 * Fake-LLM (OpenAI-kompatibel): Neuformulierung nach außen (composeExternal, Schema mit withheld) erkennen und die Absicht
 * unverändert zurückgeben, ohne Token; null bei allen anderen Aufrufen (die Fakes zählen und beantworten sie wie bisher).
 */
export function composeEcho(body: any): Response | null {
  if (!body?.response_format?.json_schema?.schema?.properties?.withheld) return null;
  const prompt = String(body.messages?.at(-1)?.content ?? '');
  const intent = prompt.slice(prompt.lastIndexOf('Absicht des Agenten'));
  const content = JSON.stringify({ subject: intent.match(/^Betreff: (.*)$/m)?.[1] ?? '', text: intent.split(/^Text:\n/m)[1] ?? '', withheld: [] });
  return new Response(JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 0, completion_tokens: 0 } }), { status: 200 });
}
