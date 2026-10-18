import type { FastifyInstance } from 'fastify';
import type { AiProposal } from '@projekttool/shared';
import { requireUser } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { requireProject } from '../rights.js';
import { mailAccess } from '../mail/access.js';
import { loadMailRow } from '../mail/actions.js';
import { aiConfigForProfile, aiConfigForProject, aiStatus, complete, MODELS } from '../ai/client.js';
import { askProject, essenceForPage, essenceForTask, statusReportDraft, summarizeMail } from '../ai/service.js';
import { loadTask, touchTask } from '../tasks/service.js';
import { htmlToMd, mdToHtml } from '../docs/html.js';
import { mapPage } from '../docs/service.js';
import { notify } from '../notify.js';
import { seal } from '../secrets.js';

function mapProposal(r: any): AiProposal {
  return { id: r.id, projectId: r.project_id, kind: r.kind, mailId: r.mail_id, taskId: r.task_id, pageId: r.page_id, payload: r.payload ?? {}, status: r.status, createdBy: r.created_by, createdByName: r.created_by_name ?? null, decidedBy: r.decided_by, decidedAt: r.decided_at, note: r.note, createdAt: r.created_at, taskTitle: r.task_title ?? null, pageTitle: r.page_title ?? null, mailSubject: r.mail_subject ?? null };
}

/**
 * KI-Modul (letztes Modul, Regel vor KI): Zusammenfassen direkt; Essenz in Arbeitspaket oder Seite nur als Vorschlag,
 * den eine Person mit Freigaberecht (oder die PL) anwendet; Statusbericht als Entwurfsseite; Frage ans Projekt mit Quellen.
 */
export async function aiRoutes(app: FastifyInstance) {
  const db = app.db;
  const cfgOrFail = async (projectId: string) => { const c = await aiConfigForProject(db, projectId); if (!c) throw badRequest('KI ist in diesem Projekt nicht aktiv. Die PL weist in den Projekteinstellungen ein KI-Profil zu (Profile verwaltet der Org-Admin).'); return c; };
  const canUse = async (user: any, projectId: string) => { const m = await requireProject(db, user, projectId, 'member'); if (m.role !== 'pl' && !m.canUseAi) throw forbidden('Kein KI-Recht in diesem Projekt (Mitgliedschaft: „KI nutzen“)'); return m; };
  const canApprove = async (user: any, projectId: string) => { const m = await requireProject(db, user, projectId, 'member'); if (m.role !== 'pl' && !m.canApprove) throw forbidden('Freigabe nur mit Recht „KI-Vorschläge freigeben“ oder als PL'); return m; };

  app.get('/ai/status', async (req) => { const user = requireUser(req); return { ...(await aiStatus(db, user.orgId)), models: MODELS }; });

  app.put<{ Body: { defaultProfileId?: string | null; agentDailyBudget?: number } }>('/ai/settings', async (req) => {
    const user = requireUser(req);
    if (user.globalRole !== 'org_admin') throw forbidden('Nur Org-Admin');
    const b = req.body ?? {};
    const cur = (await db.one(`select settings from orgs where id = $1`, [user.orgId])).settings?.ai ?? {};
    if (b.defaultProfileId) { const p = await db.maybeOne(`select 1 from ai_profiles where id = $1 and org_id = $2`, [b.defaultProfileId, user.orgId]); if (!p) throw badRequest('Profil nicht gefunden'); }
    await db.query(`update orgs set settings = settings || $2::jsonb where id = $1`, [user.orgId, JSON.stringify({ ai: { ...cur, defaultProfileId: 'defaultProfileId' in b ? b.defaultProfileId : cur.defaultProfileId ?? null, agentDailyBudget: b.agentDailyBudget != null ? Math.max(0, Math.min(1000, Number(b.agentDailyBudget) || 0)) : cur.agentDailyBudget } })]);
    await audit(db, { orgId: user.orgId, userId: user.id, action: 'ai.settings', objectType: 'org', objectId: user.orgId, details: b });
    return aiStatus(db, user.orgId);
  });

  // KI-Profile: Anbieter, Adresse, Modell, Schlüssel (nur schreibend); Org-Admin
  const validProfile = (b: any, cur?: any) => {
    const provider = (b.provider ?? cur?.provider) === 'local' ? 'local' : 'anthropic';
    const model = String(b.model ?? cur?.model ?? (provider === 'anthropic' ? MODELS[0] : '')).trim();
    if (!model || !/^[\w.:\/-]+$/i.test(model)) throw badRequest('Modell erforderlich (Name wie beim Anbieter)');
    const baseUrl = provider === 'local' ? String(b.baseUrl ?? cur?.base_url ?? '').trim().replace(/\/$/, '') : null;
    if (provider === 'local' && !/^https?:\/\//.test(baseUrl ?? '')) throw badRequest('Adresse des lokalen LLM als http(s)://…/v1');
    const name = String(b.name ?? cur?.name ?? '').trim();
    if (!name) throw badRequest('Name erforderlich');
    return { provider, model, baseUrl, name };
  };
  app.get('/ai/profiles', async (req) => { const user = requireUser(req); return { profiles: (await aiStatus(db, user.orgId)).profiles }; });
  app.post<{ Body: any }>('/ai/profiles', async (req) => {
    const user = requireUser(req);
    if (user.globalRole !== 'org_admin') throw forbidden('Nur Org-Admin');
    const b: any = req.body ?? {};
    const v = validProfile(b);
    const r = await db.one(`insert into ai_profiles (org_id, name, provider, base_url, model, api_key, thinking_off) values ($1,$2,$3,$4,$5,$6,$7) returning id`, [user.orgId, v.name, v.provider, v.baseUrl, v.model, b.apiKey?.trim() ? seal(b.apiKey.trim()) : null, b.thinkingOff === true]);
    const cur = (await db.one(`select settings from orgs where id = $1`, [user.orgId])).settings?.ai ?? {};
    if (!cur.defaultProfileId) await db.query(`update orgs set settings = settings || $2::jsonb where id = $1`, [user.orgId, JSON.stringify({ ai: { ...cur, defaultProfileId: r.id } })]);
    await audit(db, { orgId: user.orgId, userId: user.id, action: 'ai.profile.create', objectType: 'ai_profile', objectId: r.id, details: { name: v.name, provider: v.provider, model: v.model, baseUrl: v.baseUrl, thinkingOff: b.thinkingOff === true } });
    return { profile: (await aiStatus(db, user.orgId)).profiles.find((p) => p.id === r.id) };
  });
  app.patch<{ Params: { id: string }; Body: any }>('/ai/profiles/:id', async (req) => {
    const user = requireUser(req);
    if (user.globalRole !== 'org_admin') throw forbidden('Nur Org-Admin');
    const cur = await db.maybeOne(`select * from ai_profiles where id = $1 and org_id = $2`, [req.params.id, user.orgId]);
    if (!cur) throw notFound('Profil nicht gefunden');
    const b: any = req.body ?? {};
    const v = validProfile(b, cur);
    const key = b.apiKey === null ? null : b.apiKey?.trim() ? seal(b.apiKey.trim()) : cur.api_key;
    const thinkingOff = typeof b.thinkingOff === 'boolean' ? b.thinkingOff : Boolean(cur.thinking_off);
    await db.query(`update ai_profiles set name = $2, provider = $3, base_url = $4, model = $5, api_key = $6, active = $7, thinking_off = $8 where id = $1`, [cur.id, v.name, v.provider, v.baseUrl, v.model, key, typeof b.active === 'boolean' ? b.active : cur.active, thinkingOff]);
    await audit(db, { orgId: user.orgId, userId: user.id, action: 'ai.profile.update', objectType: 'ai_profile', objectId: cur.id, details: { name: v.name, provider: v.provider, model: v.model, baseUrl: v.baseUrl, active: b.active, thinkingOff, keyChanged: b.apiKey !== undefined } });
    return { profile: (await aiStatus(db, user.orgId)).profiles.find((p) => p.id === cur.id) };
  });
  app.delete<{ Params: { id: string } }>('/ai/profiles/:id', async (req) => {
    const user = requireUser(req);
    if (user.globalRole !== 'org_admin') throw forbidden('Nur Org-Admin');
    await db.query(`delete from ai_profiles where id = $1 and org_id = $2`, [req.params.id, user.orgId]);
    const cur = (await db.one(`select settings from orgs where id = $1`, [user.orgId])).settings?.ai ?? {};
    if (cur.defaultProfileId === req.params.id) await db.query(`update orgs set settings = settings || $2::jsonb where id = $1`, [user.orgId, JSON.stringify({ ai: { ...cur, defaultProfileId: null } })]);
    await audit(db, { orgId: user.orgId, userId: user.id, action: 'ai.profile.delete', objectType: 'ai_profile', objectId: req.params.id });
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/ai/profiles/:id/test', async (req) => {
    const user = requireUser(req);
    if (user.globalRole !== 'org_admin') throw forbidden('Nur Org-Admin');
    const cfg = await aiConfigForProfile(db, user.orgId, req.params.id);
    if (!cfg) throw badRequest('Profil unvollständig oder inaktiv (Adresse, Modell, Schlüssel prüfen)');
    const c = await complete(cfg, app.fetchFn, { system: 'Antworte mit genau einem Wort.', prompt: 'Sag „bereit“.', maxTokens: 20 });
    return { ok: true, model: c.model, reply: c.text };
  });

  // Mail zusammenfassen (direkt, Ergebnis wird an der Mail gespeichert)
  app.post<{ Params: { mid: string } }>('/mail/mails/:mid/ai/summarize', async (req) => {
    const user = requireUser(req);
    const mail = await loadMailRow(db, req.params.mid);
    if (!mail) throw notFound('Mail nicht gefunden');
    const access = await mailAccess(db, user, mail.id);
    if (!access.ok) throw forbidden();
    if (!access.rights.canAi) throw forbidden('Kein KI-Recht in dieser Ansicht');
    const pid = access.viewIds.length ? (await db.maybeOne(`select project_id from mail_views where id = $1`, [access.viewIds[0]]))?.project_id ?? null : null;
    if (!pid) throw badRequest('Mail gehört zu keiner Projektansicht');
    const cfg = await cfgOrFail(pid);
    return { summary: await summarizeMail(db, cfg, app.fetchFn, user, mail, pid) };
  });

  // Essenz → Arbeitspaket (Vorschlag)
  app.post<{ Params: { mid: string }; Body: { taskId: string } }>('/mail/mails/:mid/ai/essence', async (req) => {
    const user = requireUser(req);
    const mail = await loadMailRow(db, req.params.mid);
    if (!mail) throw notFound('Mail nicht gefunden');
    const access = await mailAccess(db, user, mail.id);
    if (!access.ok || !access.rights.canAi) throw forbidden('Kein KI-Recht in dieser Ansicht');
    const task = await db.maybeOne(`select t.*, c.name as column_name from tasks t join board_columns c on c.id = t.column_id where t.id = $1 and t.deleted_at is null`, [req.body?.taskId]);
    if (!task) throw notFound('Arbeitspaket nicht gefunden');
    await canUse(user, task.project_id);
    const cfg = await cfgOrFail(task.project_id);
    const cols = await db.query(`select name from board_columns where project_id = $1 order by position`, [task.project_id]);
    const e = await essenceForTask(db, cfg, app.fetchFn, user, mail, { id: task.id, title: task.title, description: task.description, dueDate: task.due_date ? String(task.due_date).slice(0, 10) : null, columnName: task.column_name, projectId: task.project_id }, cols.rows.map((c: any) => c.name));
    const r = await db.one(`insert into ai_proposals (org_id, project_id, kind, mail_id, task_id, payload, created_by) values ($1,$2,'task_update',$3,$4,$5,$6) returning *`, [user.orgId, task.project_id, mail.id, task.id, JSON.stringify(e), user.id]);
    await audit(db, { orgId: user.orgId, projectId: task.project_id, userId: user.id, action: 'ai.proposal', objectType: 'ai_proposal', objectId: r.id, details: { kind: 'task_update', taskId: task.id, mailId: mail.id } });
    await notifyApprovers(task.project_id, user.id, `KI-Vorschlag: ${task.title}`, e.summary, `/projekte/${task.project_id}/ki`);
    return { proposal: mapProposal(r) };
  });

  // Essenz → Seite (Vorschlag)
  app.post<{ Params: { mid: string }; Body: { pageId: string } }>('/mail/mails/:mid/ai/merge-page', async (req) => {
    const user = requireUser(req);
    const mail = await loadMailRow(db, req.params.mid);
    if (!mail) throw notFound('Mail nicht gefunden');
    const access = await mailAccess(db, user, mail.id);
    if (!access.ok || !access.rights.canAi) throw forbidden('Kein KI-Recht in dieser Ansicht');
    const page = await db.maybeOne(`select * from doc_pages where id = $1 and deleted_at is null`, [req.body?.pageId]);
    if (!page) throw notFound('Seite nicht gefunden');
    if (page.status === 'final') throw badRequest('Finale Seite ist gesperrt. Erst wieder öffnen.');
    await canUse(user, page.project_id);
    const cfg = await cfgOrFail(page.project_id);
    const section = await essenceForPage(db, cfg, app.fetchFn, user, mail, page);
    const r = await db.one(`insert into ai_proposals (org_id, project_id, kind, mail_id, page_id, payload, created_by) values ($1,$2,'page_append',$3,$4,$5,$6) returning *`, [user.orgId, page.project_id, mail.id, page.id, JSON.stringify({ section }), user.id]);
    await audit(db, { orgId: user.orgId, projectId: page.project_id, userId: user.id, action: 'ai.proposal', objectType: 'ai_proposal', objectId: r.id, details: { kind: 'page_append', pageId: page.id, mailId: mail.id } });
    await notifyApprovers(page.project_id, user.id, `KI-Vorschlag für Seite: ${page.title}`, `Aus Mail „${mail.subject}“`, `/projekte/${page.project_id}/ki`);
    return { proposal: mapProposal(r) };
  });

  app.get<{ Params: { id: string }; Querystring: { status?: string } }>('/projects/:id/ai/proposals', async (req) => {
    const user = requireUser(req);
    const m = await requireProject(db, user, req.params.id);
    const status = req.query.status ?? 'pending';
    const rows = await db.query(
      `select p.*, u.name as created_by_name, t.title as task_title, d.title as page_title, m.subject as mail_subject from ai_proposals p
       left join users u on u.id = p.created_by left join tasks t on t.id = p.task_id left join doc_pages d on d.id = p.page_id left join mails m on m.id = p.mail_id
       where p.project_id = $1 and ($2 = 'all' or p.status = $2) order by p.created_at desc limit 100`, [req.params.id, status]);
    return { proposals: rows.rows.map(mapProposal), canApprove: m.role === 'pl' || m.canApprove };
  });

  // Vorschlag anwenden: Log-Eintrag (Quelle KI), ggf. Status/Termin, Mail verknüpfen; bzw. Abschnitt an Seite anhängen
  app.post<{ Params: { id: string }; Body: { logEntry?: string; section?: string; applyColumn?: boolean; applyDueDate?: boolean } }>('/ai/proposals/:id/approve', async (req) => {
    const user = requireUser(req);
    const p = await db.maybeOne(`select * from ai_proposals where id = $1`, [req.params.id]);
    if (!p) throw notFound('Vorschlag nicht gefunden');
    if (p.status !== 'pending') throw badRequest('Vorschlag ist bereits entschieden');
    await canApprove(user, p.project_id);
    const b = req.body ?? {};
    if (p.kind === 'task_update') {
      const task = await db.maybeOne(`select * from tasks where id = $1 and deleted_at is null`, [p.task_id]);
      if (!task) throw notFound('Arbeitspaket nicht mehr vorhanden');
      const pay = p.payload ?? {};
      const changes: string[] = [];
      if (b.applyColumn !== false && pay.columnName) {
        const col = await db.maybeOne(`select id, is_done from board_columns where project_id = $1 and lower(name) = lower($2)`, [p.project_id, pay.columnName]);
        if (col && col.id !== task.column_id) { await db.query(`update tasks set column_id = $2 where id = $1`, [task.id, col.id]); changes.push(`Status → ${pay.columnName}`); }
      }
      if (b.applyDueDate !== false && pay.dueDate && pay.dueDate !== (task.due_date ? String(task.due_date).slice(0, 10) : null)) {
        await db.query(`update tasks set due_date = $2 where id = $1`, [task.id, pay.dueDate]);
        changes.push(`Termin → ${pay.dueDate}`);
      }
      const entry = (b.logEntry?.trim() || pay.logEntry || pay.summary || '').trim();
      const mail = p.mail_id ? await db.maybeOne(`select id, subject, from_addr, date from mails where id = $1`, [p.mail_id]) : null;
      const suffix = mail ? `\n\nQuelle: Mail „${mail.subject}“ von ${mail.from_addr} (${new Date(mail.date).toLocaleDateString('de-DE')})` : '';
      await db.query(`insert into task_comments (task_id, user_id, body, source, mail_id) values ($1,$2,$3,'ai',$4)`, [task.id, user.id, `${entry}${changes.length ? `\n\n${changes.join(', ')}` : ''}${suffix}`, mail?.id ?? null]);
      if (mail) await db.query(`insert into mail_task_links (mail_id, task_id, copied, linked_by) values ($1,$2,false,$3) on conflict do nothing`, [mail.id, task.id, user.id]);
      await touchTask(db, task.id);
      await db.query(`update ai_proposals set status = 'approved', decided_by = $2, decided_at = now() where id = $1`, [p.id, user.id]);
      await audit(db, { orgId: user.orgId, projectId: p.project_id, userId: user.id, action: 'ai.approve', objectType: 'task', objectId: task.id, details: { proposalId: p.id, changes } });
      return { ok: true, task: await loadTask(db, task.id) };
    }
    const page = await db.maybeOne(`select * from doc_pages where id = $1 and deleted_at is null`, [p.page_id]);
    if (!page) throw notFound('Seite nicht mehr vorhanden');
    if (page.status === 'final') throw badRequest('Finale Seite ist gesperrt. Erst wieder öffnen.');
    const section = (b.section?.trim() || p.payload?.section || '').trim();
    const html = `${(page.content_html ?? mdToHtml(page.content_md)).replace(/\s+$/, '')}\n${mdToHtml(section)}`;
    const u = await db.one(`update doc_pages set content_html = $2, content_md = $3, version = version + 1, updated_by = $4, updated_at = now() where id = $1 returning *`, [page.id, html, htmlToMd(html), user.id]);
    await db.query(`insert into doc_page_versions (page_id, version, title, content_md, content_html, status, saved_by) values ($1,$2,$3,$4,$5,$6,$7)`, [u.id, u.version, u.title, u.content_md, u.content_html, u.status, user.id]);
    if (p.mail_id) await db.query(`insert into mail_page_links (mail_id, page_id, kind, linked_by) values ($1,$2,'section',$3) on conflict do nothing`, [p.mail_id, page.id, user.id]);
    await db.query(`update ai_proposals set status = 'approved', decided_by = $2, decided_at = now() where id = $1`, [p.id, user.id]);
    await audit(db, { orgId: user.orgId, projectId: p.project_id, userId: user.id, action: 'ai.approve', objectType: 'doc_page', objectId: page.id, details: { proposalId: p.id, version: u.version } });
    return { ok: true, page: mapPage(u) };
  });

  app.post<{ Params: { id: string }; Body: { note?: string } }>('/ai/proposals/:id/reject', async (req) => {
    const user = requireUser(req);
    const p = await db.maybeOne(`select * from ai_proposals where id = $1`, [req.params.id]);
    if (!p) throw notFound('Vorschlag nicht gefunden');
    if (p.status !== 'pending') throw badRequest('Vorschlag ist bereits entschieden');
    await canApprove(user, p.project_id);
    await db.query(`update ai_proposals set status = 'rejected', decided_by = $2, decided_at = now(), note = $3 where id = $1`, [p.id, user.id, req.body?.note?.trim() || null]);
    await audit(db, { orgId: user.orgId, projectId: p.project_id, userId: user.id, action: 'ai.reject', objectType: 'ai_proposal', objectId: p.id, details: { note: req.body?.note } });
    return { ok: true };
  });

  // Statusbericht-Entwurf als Seite (Status Entwurf) im Ordner „Berichte“
  app.post<{ Params: { id: string } }>('/projects/:id/ai/status-report', async (req) => {
    const user = requireUser(req);
    await canUse(user, req.params.id);
    const cfg = await cfgOrFail(req.params.id);
    const today = new Date().toISOString().slice(0, 10);
    const md = await statusReportDraft(db, cfg, app.fetchFn, user, req.params.id, today);
    const folder = await db.maybeOne(`select id from doc_folders where project_id = $1 and name = 'Berichte'`, [req.params.id]);
    const title = `Statusbericht-Entwurf (KI) ${today}`;
    const html = mdToHtml(md);
    const page = await db.one(`insert into doc_pages (project_id, folder_id, title, content_md, content_html, status, created_by, updated_by) values ($1,$2,$3,$4,$5,'draft',$6,$6) returning *`, [req.params.id, folder?.id ?? null, title, md, html, user.id]);
    await db.query(`insert into doc_page_versions (page_id, version, title, content_md, content_html, status, saved_by) values ($1,1,$2,$3,$4,'draft',$5)`, [page.id, title, md, html, user.id]);
    await audit(db, { orgId: user.orgId, projectId: req.params.id, userId: user.id, action: 'ai.status_report', objectType: 'doc_page', objectId: page.id });
    return { page: mapPage(page) };
  });

  app.post<{ Params: { id: string }; Body: { question: string } }>('/projects/:id/ai/ask', async (req) => {
    const user = requireUser(req);
    await canUse(user, req.params.id);
    const q = req.body?.question?.trim();
    if (!q || q.length < 3) throw badRequest('Frage erforderlich');
    const cfg = await cfgOrFail(req.params.id);
    return askProject(db, cfg, app.fetchFn, user, req.params.id, q);
  });

  async function notifyApprovers(projectId: string, byUserId: string, title: string, body: string, link: string) {
    const rows = await db.query(`select user_id from project_members where project_id = $1 and (role = 'pl' or can_approve) and user_id <> $2`, [projectId, byUserId]);
    for (const r of rows.rows) await notify(db, { userId: r.user_id, projectId, type: 'ai.proposal', title, body, link });
  }
}
