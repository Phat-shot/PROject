import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { requireUser } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { publicBase } from '../docs/share.js';
import { seal, unseal } from '../secrets.js';
import { finishCall, handleFlowEvent, normNumber, verifyFlowRequest, type FlowEvent } from '../telephony/phone.js';

/**
 * Telefonie: Ereignisse von sipgate Flow (KI am Telefon) und sipgate.io (Anruf-Log ohne KI) sowie die Verwaltung
 * (Org-Admin): Freischaltung, Schlüssel, Rufnummern mit Projekt, Agent und KI-Profil, Anrufliste.
 */
export async function telephonyRoutes(app: FastifyInstance) {
  const db = app.db;
  const config = (orgId: string) => db.maybeOne(`select * from telephony_config where org_id = $1`, [orgId]);

  // Webhooks in eigenem Kontext: Flow braucht den Rohtext (HMAC), sipgate.io sendet Formulardaten
  await app.register(async (hooks) => {
    hooks.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      (req as any).rawBody = body;
      try { done(null, body ? JSON.parse(String(body)) : {}); } catch (e: any) { done(Object.assign(e, { statusCode: 400 }), undefined); }
    });
    hooks.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of new URLSearchParams(String(body))) {
        const key = k.replace(/\[\]$/, '');
        if (k.endsWith('[]')) out[key] = [...((out[key] as string[] | undefined) ?? []), v]; else out[key] = v;
      }
      done(null, out);
    });

    hooks.post<{ Params: { orgId: string }; Body: FlowEvent }>('/telephony/flow/:orgId', async (req, reply) => {
      const cfg = /^[0-9a-f-]{36}$/i.test(req.params.orgId) ? await config(req.params.orgId) : null;
      if (!cfg?.enabled || !verifyFlowRequest(unseal(cfg.flow_secret) ?? '', req.headers as Record<string, unknown>, String((req as any).rawBody ?? ''))) return reply.status(401).send({ error: 'Nicht autorisiert' });
      return handleFlowEvent(db, app.fetchFn, req.params.orgId, req.body);
    });

    // sipgate.io Push-API: newCall → Anruf anlegen und answer/hangup abonnieren; answer/hangup → Zeiten und Ende
    hooks.post<{ Params: { orgId: string; token: string }; Body: Record<string, any> }>('/telephony/sipgate-io/:orgId/:token', async (req, reply) => {
      const cfg = /^[0-9a-f-]{36}$/i.test(req.params.orgId) ? await config(req.params.orgId) : null;
      const token = cfg ? unseal(cfg.io_token) : null;
      if (!cfg?.enabled || !token || token !== req.params.token) return reply.status(401).send('Nicht autorisiert');
      const b = req.body ?? {};
      const callId = String(b.callId ?? '').slice(0, 100);
      if (!callId) return reply.status(400).send('callId fehlt');
      const orgId = req.params.orgId;
      if (b.event === 'newCall') {
        const direction = b.direction === 'out' ? 'out' : 'in';
        const from = normNumber(b.from); const to = normNumber(b.to);
        const line = await db.maybeOne(`select id, project_id from phone_lines where org_id = $1 and number = $2`, [orgId, direction === 'in' ? to : from]);
        const caller = from ? await db.maybeOne(`select id from users where org_id = $1 and active and kind <> 'agent' and phone = $2 limit 1`, [orgId, direction === 'in' ? from : to]) : null;
        await db.query(`insert into calls (org_id, line_id, provider, external_id, direction, from_number, to_number, caller_user_id, project_id) values ($1,$2,'sipgate_io',$3,$4,$5,$6,$7,$8) on conflict (provider, external_id) do nothing`,
          [orgId, line?.id ?? null, callId, direction, from || null, to || null, caller?.id ?? null, line?.project_id ?? null]);
        const url = `${publicBase()}/api/telephony/sipgate-io/${orgId}/${token}`;
        reply.header('content-type', 'application/xml');
        return `<?xml version="1.0" encoding="UTF-8"?><Response onAnswer="${url}" onHangup="${url}"/>`;
      }
      if (b.event === 'answer') await db.query(`update calls set answered_at = coalesce(answered_at, now()), summary = coalesce(summary, $3) where provider = 'sipgate_io' and external_id = $1 and org_id = $2`, [callId, orgId, b.user ? `angenommen von ${[].concat(b.user).join(', ')}` : null]);
      if (b.event === 'hangup') await db.query(`update calls set status = 'ended', ended_at = now(), error = case when $3 = 'normalClearing' then error else $3 end where provider = 'sipgate_io' and external_id = $1 and org_id = $2`, [callId, orgId, String(b.cause ?? '').slice(0, 60) || null]);
      return reply.status(200).send('');
    });
  });

  // ---------- Verwaltung (Org-Admin) ----------
  const admin = (req: any) => { const u = requireUser(req); if (u.globalRole !== 'org_admin') throw forbidden('Telefonie verwaltet der Org-Admin'); return u; };
  const urls = (orgId: string, ioToken: string | null) => ({ flowUrl: `${publicBase()}/api/telephony/flow/${orgId}`, ioUrl: ioToken ? `${publicBase()}/api/telephony/sipgate-io/${orgId}/${ioToken}` : null });
  const mapLine = (l: any) => ({ id: l.id, number: l.number, label: l.label, projectId: l.project_id, agentUserId: l.agent_user_id, aiProfileId: l.ai_profile_id, greeting: l.greeting, active: l.active });

  app.get('/telephony', async (req) => {
    const user = admin(req);
    const cfg = await config(user.orgId);
    const lines = await db.query(`select * from phone_lines where org_id = $1 order by number`, [user.orgId]);
    return { enabled: Boolean(cfg?.enabled), hasSecret: Boolean(cfg?.flow_secret), ...urls(user.orgId, cfg ? unseal(cfg.io_token) : null), lines: lines.rows.map(mapLine) };
  });

  app.put<{ Body: { enabled?: boolean } }>('/telephony', async (req) => {
    const user = admin(req);
    await db.query(`insert into telephony_config (org_id, enabled) values ($1,$2) on conflict (org_id) do update set enabled = $2, updated_at = now()`, [user.orgId, Boolean(req.body?.enabled)]);
    await audit(db, { orgId: user.orgId, userId: user.id, action: 'telephony.settings', objectType: 'org', objectId: user.orgId, details: { enabled: Boolean(req.body?.enabled) } });
    return { ok: true };
  });

  // Neuer Schlüssel für Flow (Header x-api-token bzw. HMAC) und neues Pfad-Token für sipgate.io; der Schlüssel wird nur jetzt angezeigt
  app.post('/telephony/secret', async (req) => {
    const user = admin(req);
    const secret = randomBytes(24).toString('base64url');
    const io = randomBytes(18).toString('base64url');
    await db.query(`insert into telephony_config (org_id, flow_secret, io_token) values ($1,$2,$3) on conflict (org_id) do update set flow_secret = $2, io_token = $3, updated_at = now()`, [user.orgId, seal(secret), seal(io)]);
    await audit(db, { orgId: user.orgId, userId: user.id, action: 'telephony.secret', objectType: 'org', objectId: user.orgId });
    return { secret, ...urls(user.orgId, io) };
  });

  const validLine = async (orgId: string, b: any) => {
    const number = normNumber(b.number);
    if (!/^\d{6,16}$/.test(number)) throw badRequest('Rufnummer mit Vorwahl, z. B. +49 211 1234567');
    if (b.projectId && !(await db.maybeOne(`select 1 from projects where id = $1 and org_id = $2`, [b.projectId, orgId]))) throw badRequest('Projekt nicht gefunden');
    if (b.agentUserId && !(await db.maybeOne(`select 1 from users where id = $1 and org_id = $2 and kind = 'agent'`, [b.agentUserId, orgId]))) throw badRequest('KI-Agent nicht gefunden');
    if (b.agentUserId && b.projectId && !(await db.maybeOne(`select 1 from project_members where project_id = $1 and user_id = $2`, [b.projectId, b.agentUserId]))) throw badRequest('Der Agent ist nicht Mitglied des Projekts (Projekt › Einstellungen › KI)');
    if (b.aiProfileId && !(await db.maybeOne(`select 1 from ai_profiles where id = $1 and org_id = $2 and project_id is null`, [b.aiProfileId, orgId]))) throw badRequest('KI-Profil nicht gefunden');
    return { number, label: String(b.label ?? '').trim().slice(0, 100), projectId: b.projectId || null, agentUserId: b.agentUserId || null, aiProfileId: b.aiProfileId || null, greeting: String(b.greeting ?? '').trim().slice(0, 500) || null, active: b.active !== false };
  };
  app.post<{ Body: any }>('/telephony/lines', async (req) => {
    const user = admin(req);
    const v = await validLine(user.orgId, req.body ?? {});
    if (await db.maybeOne(`select 1 from phone_lines where org_id = $1 and number = $2`, [user.orgId, v.number])) throw badRequest('Rufnummer ist schon eingerichtet');
    const r = await db.one(`insert into phone_lines (org_id, number, label, project_id, agent_user_id, ai_profile_id, greeting, active) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`, [user.orgId, v.number, v.label, v.projectId, v.agentUserId, v.aiProfileId, v.greeting, v.active]);
    await audit(db, { orgId: user.orgId, userId: user.id, action: 'telephony.line.create', objectType: 'phone_line', objectId: r.id, details: { number: v.number } });
    return { line: mapLine(r) };
  });
  app.put<{ Params: { id: string }; Body: any }>('/telephony/lines/:id', async (req) => {
    const user = admin(req);
    const cur = await db.maybeOne(`select * from phone_lines where id = $1 and org_id = $2`, [req.params.id, user.orgId]);
    if (!cur) throw notFound('Rufnummer nicht gefunden');
    const v = await validLine(user.orgId, req.body ?? {});
    if (v.number !== cur.number && (await db.maybeOne(`select 1 from phone_lines where org_id = $1 and number = $2`, [user.orgId, v.number]))) throw badRequest('Rufnummer ist schon eingerichtet');
    const r = await db.one(`update phone_lines set number = $2, label = $3, project_id = $4, agent_user_id = $5, ai_profile_id = $6, greeting = $7, active = $8 where id = $1 returning *`, [cur.id, v.number, v.label, v.projectId, v.agentUserId, v.aiProfileId, v.greeting, v.active]);
    await audit(db, { orgId: user.orgId, userId: user.id, action: 'telephony.line.update', objectType: 'phone_line', objectId: cur.id, details: { number: v.number } });
    return { line: mapLine(r) };
  });
  app.delete<{ Params: { id: string } }>('/telephony/lines/:id', async (req) => {
    const user = admin(req);
    const r = await db.query(`delete from phone_lines where id = $1 and org_id = $2 returning id`, [req.params.id, user.orgId]);
    if (!r.rows.length) throw notFound('Rufnummer nicht gefunden');
    await audit(db, { orgId: user.orgId, userId: user.id, action: 'telephony.line.delete', objectType: 'phone_line', objectId: req.params.id });
    return { ok: true };
  });

  // Anrufe: Org-Admin alle, PL die seines Projekts
  app.get<{ Querystring: { projectId?: string } }>('/telephony/calls', async (req) => {
    const user = requireUser(req);
    const pid = req.query.projectId ?? null;
    if (pid) { if (!(await db.maybeOne(`select 1 from project_members where project_id = $1 and user_id = $2 and role = 'pl'`, [pid, user.id])) && user.globalRole !== 'org_admin') throw forbidden(); }
    else if (user.globalRole !== 'org_admin') throw forbidden('Anrufe sieht der Org-Admin');
    const r = await db.query(
      `select c.*, l.label as line_label, p.key as project_key, t.number as task_number, u.name as caller_name, a.name as agent_name from calls c
         left join phone_lines l on l.id = c.line_id left join projects p on p.id = c.project_id left join tasks t on t.id = c.task_id
         left join users u on u.id = c.caller_user_id left join users a on a.id = c.agent_user_id
       where c.org_id = $1 and ($2::uuid is null or c.project_id = $2) order by c.started_at desc limit 100`, [user.orgId, pid]);
    return { calls: r.rows.map((c: any) => ({ id: c.id, provider: c.provider, direction: c.direction, from: c.from_number, to: c.to_number, lineLabel: c.line_label, callerName: c.caller_name, agentName: c.agent_name, projectId: c.project_id, projectKey: c.project_key, taskId: c.task_id, taskNumber: c.task_number, status: c.status, summary: c.summary, error: c.error, startedAt: c.started_at, answeredAt: c.answered_at, endedAt: c.ended_at, transcript: c.transcript ?? [] })) };
  });

  // Hängende Flow-Anrufe (kein session_end angekommen) nach 2 Stunden abschließen; läuft beim Abruf der Liste nebenbei
  app.addHook('onResponse', async (req) => {
    if (req.url.startsWith('/api/telephony/calls')) {
      const stale = await db.query(`select * from calls where provider = 'flow' and status = 'active' and started_at < now() - interval '2 hours' limit 20`);
      for (const c of stale.rows) await finishCall(db, c).catch(() => undefined);
    }
  });
}
