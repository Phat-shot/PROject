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
import { aiPolicyRoutes } from './routes/aiPolicy.js';
import { analyticsRoutes } from './routes/analytics.js';
import { meetingRoutes } from './routes/meetings.js';
import { agentRoutes } from './routes/agents.js';
import { copyRoutes } from './routes/copy.js';
import { chatRoutes } from './routes/chat.js';
import { workflowRoutes } from './routes/workflows.js';
import { notifyRuleRoutes } from './routes/notifyRules.js';
import { registerAgentChatRunner, registerAgentRunner, registerMailAiRunner } from './ai/agentEvents.js';
import { runForTask } from './ai/agent.js';
import { runAgentChat } from './ai/agentChat.js';
import { runMailAi } from './ai/mailAi.js';
import { registerAiCallLog, registerAiUsage } from './ai/client.js';
import { MailService } from './mail/service.js';
import { registerRateLimit } from './rateLimit.js';
import { publicBase } from './docs/share.js';
import { questionRoutes } from './routes/questions.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { telephonyRoutes } from './routes/telephony.js';
import { resourceRoutes } from './routes/resources.js';

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

/**
 * Hinter einem Reverse-Proxy (Traefik) ist req.ip sonst die Proxy-Adresse: alle Clients teilten sich die Drosselung.
 * TRUST_PROXY: true oder vertrauenswürdige Adressen/Netze (z. B. "loopback,linklocal,uniquelocal" für Docker-Netze).
 */
export function trustProxyFrom(v: string | undefined): boolean | string {
  if (!v || v === 'false') return false;
  return v === 'true' ? true : v;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 10 * 1024 * 1024, trustProxy: trustProxyFrom(process.env.TRUST_PROXY) });
  app.decorate('db', opts.db);
  app.decorate('mail', opts.mail);
  app.decorate('fetchFn', opts.fetchFn ?? fetch);
  registerAgentRunner((taskId, trigger, agentId) => runForTask(opts.db, opts.mail, opts.fetchFn ?? fetch, taskId, trigger, agentId));
  registerAgentChatRunner((agentId, channelId, messageId) => runAgentChat(opts.db, opts.fetchFn ?? fetch, agentId, channelId, messageId));
  registerMailAiRunner((runId) => runMailAi(opts.db, opts.mail, opts.fetchFn ?? fetch, runId));
  // Zentrales KI-Log (Verwaltung › KI › KI-Log); Einträge älter als 90 Tage fallen weg, offene von vor einem Neustart gelten als abgebrochen
  void opts.db.query(`update ai_calls set status = 'error', error = 'abgebrochen (Neustart des Servers)', finished_at = now() where status = 'running' and started_at < now() - interval '1 hour'`).catch(() => undefined);
  registerAiCallLog({
    start: async (cfg, meta) => {
      if (Math.random() < 0.02) await opts.db.query(`delete from ai_calls where started_at < now() - interval '90 days'`);
      const r = await opts.db.maybeOne(`insert into ai_calls (org_id, profile_id, profile_name, model, agent_user_id, project_id, task_id, feature, thinking)
        select a.org_id, a.id, a.name, $2, $3, $4, $5, $6, $7 from ai_profiles a where a.id = $1 returning id`,
        [cfg.profileId, cfg.model, cfg.agentUserId ?? null, meta.projectId ?? null, meta.taskId ?? null, meta.feature, cfg.provider === 'local' ? cfg.enableThinking ?? null : null]);
      return r?.id ?? null;
    },
    finish: (id, e) => opts.db.query(`update ai_calls set status = $2, finished_at = now(), duration_ms = (extract(epoch from now() - started_at) * 1000)::int, input_tokens = $3, output_tokens = $4, reasoning_chars = $5, retried = $6, error = $7, model = coalesce($8, model) where id = $1`,
      [id, e.status, e.inputTokens ?? null, e.outputTokens ?? null, e.reasoningChars ?? null, Boolean(e.retried), e.error ?? null, e.model ?? null])
  });
  registerAiUsage((profileId, i, o) => opts.db.query(`update ai_profiles set tokens_in = tokens_in + $2, tokens_out = tokens_out + $3, last_used_at = now() where id = $1`, [profileId, i, o]));
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
      await api.register(aiPolicyRoutes);
      await api.register(analyticsRoutes);
      await api.register(meetingRoutes);
      await api.register(agentRoutes);
      await api.register(copyRoutes);
      await api.register(chatRoutes);
      await api.register(workflowRoutes);
      await api.register(notifyRuleRoutes);
      await api.register(questionRoutes);
      await api.register(knowledgeRoutes);
      await api.register(resourceRoutes);
      await api.register(telephonyRoutes);
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
