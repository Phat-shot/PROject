import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { canSeeSubproject, getMembership, requireProject, requireTask } from '../rights.js';
import { answerQuestion, canAnswer, cancelQuestions, mapQuestion, QUESTION_SELECT, type QuestionRow } from '../questions.js';
import { decideProposals } from '../ai/agentApproval.js';

/**
 * Offene Fragen: Liste für mich (Glocke „Offen für mich“, Dashboard), je Arbeitspaket (TaskDrawer), beantworten (Adressat, jedes
 * Mitglied ab Rolle member mit Sicht auf das AP, PL) und abbrechen (fragende Person, PL oder Adressat).
 */
export async function questionRoutes(app: FastifyInstance) {
  const db = app.db;

  const mayAnswer = (user: any, q: QuestionRow) => canAnswer(db, q, user.id);

  // Fragen an mich (offen oder alle), optional je Projekt und Art
  app.get<{ Querystring: { status?: string; projectId?: string; kind?: string; mine?: string } }>('/questions', async (req) => {
    const user = requireUser(req);
    const status = req.query.status ?? 'open';
    const rows = await db.query(
      `${QUESTION_SELECT}
       where q.org_id = $1 and ($2::text = 'all' or q.status = $2) and ($3::uuid is null or q.project_id = $3) and ($4::text is null or q.kind = $4)
         and (q.addressee_id = $5 or (q.addressee_id is null and exists (select 1 from project_members m where m.project_id = q.project_id and m.user_id = $5 and m.role <> 'reader')))
       order by q.created_at desc limit 100`,
      [user.orgId, status, req.query.projectId || null, req.query.kind || null, user.id]);
    const out = [];
    for (const r of rows.rows) {
      if (r.task_id && r.addressee_id === null) { const t = await db.maybeOne(`select subproject_id from tasks where id = $1`, [r.task_id]); if (t && !(await canSeeSubproject(db, user.id, t.subproject_id))) continue; }
      out.push(mapQuestion(r));
    }
    return { questions: out, open: out.filter((q) => q.status === 'open').length };
  });

  app.get<{ Params: { id: string }; Querystring: { status?: string } }>('/tasks/:id/questions', async (req) => {
    const user = requireUser(req);
    const { task } = await requireTask(db, user, req.params.id);
    const rows = await db.query(`${QUESTION_SELECT} where q.task_id = $1 and ($2::text = 'all' or q.status = $2) order by q.created_at desc limit 50`, [task.id, req.query.status ?? 'open']);
    return { questions: rows.rows.map(mapQuestion) };
  });

  app.get<{ Params: { id: string } }>('/questions/:id', async (req) => {
    const user = requireUser(req);
    const q = await db.maybeOne(`${QUESTION_SELECT} where q.id = $1 and q.org_id = $2`, [req.params.id, user.orgId]);
    if (!q) throw notFound('Frage nicht gefunden');
    await requireProject(db, user, q.project_id, 'reader');
    return { question: mapQuestion(q) };
  });

  // Antwort aus der Aufgabe oder der Karte (option = Schlüssel einer Auswahl)
  app.post<{ Params: { id: string }; Body: { text?: string; option?: string | null } }>('/questions/:id/answer', async (req) => {
    const user = requireUser(req);
    if (user.kind === 'agent') throw forbidden('Fragen beantworten Personen');
    const q = await db.maybeOne<QuestionRow>(`select * from questions where id = $1 and org_id = $2`, [req.params.id, user.orgId]);
    if (!q) throw notFound('Frage nicht gefunden');
    if (q.status !== 'open') throw badRequest('Frage ist nicht mehr offen');
    if (!(await mayAnswer(user, q))) throw forbidden('Beantworten darf der Adressat, ein Mitglied mit Sicht auf das Arbeitspaket oder die PL');
    const option = req.body?.option ? String(req.body.option) : null;
    if (option && !(q.options ?? []).some((o) => o.key === option)) throw badRequest('Unbekannte Auswahl');
    const text = String(req.body?.text ?? '').trim();
    if (!option && !text) throw badRequest('Antwort leer');
    const answer = text || ((q.options ?? []).find((o) => o.key === option)?.label ?? '');
    const c = q.task_id ? await db.one(`insert into task_comments (task_id, user_id, body, question_id) values ($1,$2,$3,$4) returning id`, [q.task_id, user.id, answer, q.id]) : null;
    const r = await answerQuestion(db, q, { source: 'task', userId: user.id, text: answer, option, commentId: c?.id ?? null });
    if (!r) throw badRequest('Frage ist nicht mehr offen');
    return { question: mapQuestion(await db.one(`${QUESTION_SELECT} where q.id = $1`, [q.id])) };
  });

  // Bestätigung angehaltener Agentenaktionen (Frage approval): einzelne oder alle Vorschläge bestätigen bzw. ablehnen (Grund Pflicht)
  app.post<{ Params: { id: string }; Body: { approve?: string[] | 'all'; reject?: string[] | 'all'; reason?: string } }>('/questions/:id/decide', async (req) => {
    const user = requireUser(req);
    if (user.kind === 'agent') throw forbidden('Bestätigen dürfen Personen');
    const q = await db.maybeOne<QuestionRow>(`select * from questions where id = $1 and org_id = $2`, [req.params.id, user.orgId]);
    if (!q) throw notFound('Frage nicht gefunden');
    if (q.kind !== 'approval') throw badRequest('Keine Freigabefrage');
    const pending = (await db.query(`select id from ai_proposals where question_id = $1 and status = 'pending' order by seq`, [q.id])).rows.map((r: any) => r.id as string);
    const pick = (v: string[] | 'all' | undefined) => (v === 'all' ? pending : Array.isArray(v) ? v.filter((id) => pending.includes(id)) : []);
    const approve = pick(req.body?.approve); const reject = pick(req.body?.reject).filter((id) => !approve.includes(id));
    if (!approve.length && !reject.length) throw badRequest('Nichts zu entscheiden');
    if (reject.length) await decideProposals(db, app.mail, app.fetchFn, { ids: reject, approve: false, reason: req.body?.reason ?? null, user });
    if (approve.length) await decideProposals(db, app.mail, app.fetchFn, { ids: approve, approve: true, user });
    return { question: mapQuestion(await db.one(`${QUESTION_SELECT} where q.id = $1`, [q.id])) };
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>('/questions/:id/cancel', async (req) => {
    const user = requireUser(req);
    const q = await db.maybeOne<QuestionRow>(`select * from questions where id = $1 and org_id = $2`, [req.params.id, user.orgId]);
    if (!q) throw notFound('Frage nicht gefunden');
    const m = await getMembership(db, q.project_id, user.id);
    if (!(q.asked_by === user.id || q.addressee_id === user.id || m?.role === 'pl')) throw forbidden('Abbrechen darf die fragende Person, der Adressat oder die PL');
    await cancelQuestions(db, { questionId: q.id }, String(req.body?.reason ?? '').trim() || `von ${user.name} erledigt`, user.id);
    return { question: mapQuestion(await db.one(`${QUESTION_SELECT} where q.id = $1`, [q.id])) };
  });
}
