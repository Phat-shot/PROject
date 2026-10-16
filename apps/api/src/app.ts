import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Db } from './db.js';
import { HttpError } from './errors.js';
import { SESSION_COOKIE, userFromToken } from './auth.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { projectRoutes } from './routes/projects.js';
import { taskRoutes } from './routes/tasks.js';
import { mailRoutes } from './routes/mail.js';
import { docRoutes } from './routes/docs.js';
import { devRoutes } from './routes/dev.js';
import { searchRoutes } from './routes/search.js';
import { timeRoutes } from './routes/time.js';
import { setupRoutes } from './routes/setup.js';
import { MailService } from './mail/service.js';

export interface AppOptions {
  db: Db;
  mail: MailService;
  staticDir?: string;
  logger?: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    mail: MailService;
  }
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 10 * 1024 * 1024 });
  app.decorate('db', opts.db);
  app.decorate('mail', opts.mail);
  app.decorateRequest('user', null);

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });

  app.addHook('preHandler', async (req) => {
    req.user = await userFromToken(opts.db, req.cookies[SESSION_COOKIE]);
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) {
      reply.status(err.status).send({ error: err.message, details: err.details });
      return;
    }
    if (err.validation) {
      reply.status(400).send({ error: 'Ungültige Eingabe', details: err.validation });
      return;
    }
    req.log.error(err);
    reply.status(500).send({ error: 'Interner Fehler' });
  });

  await app.register(
    async (api) => {
      await api.register(setupRoutes);
      await api.register(authRoutes);
      await api.register(userRoutes);
      await api.register(projectRoutes);
      await api.register(taskRoutes);
      await api.register(mailRoutes);
      await api.register(docRoutes);
      await api.register(searchRoutes);
      await api.register(timeRoutes);
      if (process.env.NODE_ENV !== 'production') await api.register(devRoutes);
      api.get('/health', async () => ({ ok: true, db: opts.db.kind }));
    },
    { prefix: '/api' }
  );

  const staticDir = opts.staticDir;
  if (staticDir && existsSync(path.join(staticDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: staticDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        reply.status(404).send({ error: 'Nicht gefunden' });
        return;
      }
      reply.sendFile('index.html');
    });
  }
  return app;
}
