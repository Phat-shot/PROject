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
import { icsRoutes } from './routes/ics.js';
import { raidRoutes } from './routes/raid.js';
import { portfolioRoutes } from './routes/portfolio.js';
import { oauthRoutes } from './routes/oauth.js';
import { aiRoutes } from './routes/ai.js';
import { analyticsRoutes } from './routes/analytics.js';
import { meetingRoutes } from './routes/meetings.js';
import { agentRoutes } from './routes/agents.js';
import { copyRoutes } from './routes/copy.js';
import { chatRoutes } from './routes/chat.js';
import { workflowRoutes } from './routes/workflows.js';
import { registerAgentChatRunner, registerAgentRunner, registerMailAiRunner } from './ai/agentEvents.js';
import { runForTask } from './ai/agent.js';
import { runAgentChat } from './ai/agentChat.js';
import { runMailAi } from './ai/mailAi.js';
import { MailService } from './mail/service.js';
import { registerRateLimit } from './rateLimit.js';
import { publicBase } from './docs/share.js';

export interface AppOptions {
  db: Db;
  mail: MailService;
  staticDir?: string;
  logger?: boolean;
  /** HTTP-Client für OAuth2/OIDC (in Tests ersetzbar) */
  fetchFn?: typeof fetch;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    mail: MailService;
    fetchFn: typeof fetch;
  }
}

function safeOrigin(u: string): string | null { try { return new URL(u).origin; } catch { return null; } }
function safeHost(u: string | null | undefined): string { try { return u ? new URL(u).host : ''; } catch { return ''; } }

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 10 * 1024 * 1024 });
  app.decorate('db', opts.db);
  app.decorate('mail', opts.mail);
  app.decorate('fetchFn', opts.fetchFn ?? fetch);
  registerAgentRunner((taskId, trigger) => runForTask(opts.db, opts.mail, opts.fetchFn ?? fetch, taskId, trigger));
  registerAgentChatRunner((agentId, channelId, messageId) => runAgentChat(opts.db, opts.fetchFn ?? fetch, agentId, channelId, messageId));
  registerMailAiRunner((runId) => runMailAi(opts.db, opts.mail, opts.fetchFn ?? fetch, runId));
  app.decorateRequest('user', null);

  registerRateLimit(app);
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });

  app.addHook('preHandler', async (req) => {
    req.user = await userFromToken(opts.db, req.cookies[SESSION_COOKIE]);
  });

  // CSRF: ändernde Anfragen mit Sitzungs-Cookie müssen von der eigenen Herkunft kommen (Origin bzw. Referer gegen Host und PUBLIC_URL)
  app.addHook('onRequest', async (req, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.cookies?.[SESSION_COOKIE]) return;
    const src = req.headers.origin ?? (req.headers.referer ? safeOrigin(req.headers.referer) : null);
    if (!src) return; // kein Browser-Kontext (API-Client, Tests)
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim();
    const allowed = new Set([host, safeHost(publicBase())].filter(Boolean));
    if (!allowed.has(safeHost(src))) {
      reply.status(403).send({ error: 'Anfrage von fremder Herkunft abgelehnt' });
    }
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
    if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
      reply.status(err.statusCode).send({ error: err.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ? 'Leerer Anfragetext' : err.message });
      return;
    }
    req.log.error(err);
    if (process.env.LOG_ERRORS) console.error(err);
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
      await api.register(icsRoutes);
      await api.register(raidRoutes);
      await api.register(portfolioRoutes);
      await api.register(oauthRoutes);
      await api.register(aiRoutes);
      await api.register(analyticsRoutes);
      await api.register(meetingRoutes);
      await api.register(agentRoutes);
      await api.register(copyRoutes);
      await api.register(chatRoutes);
      await api.register(workflowRoutes);
      if (process.env.NODE_ENV !== 'production') await api.register(devRoutes);
      api.get('/health', async () => ({ ok: true, db: opts.db.kind, version: (process.env.APP_VERSION ?? 'dev').slice(0, 7) }));
    },
    { prefix: '/api' }
  );

  const staticDir = opts.staticDir;
  if (staticDir && existsSync(path.join(staticDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: staticDir });
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
