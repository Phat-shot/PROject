import type { FastifyInstance } from 'fastify';
import type { AiPolicyRule, User } from '@projekttool/shared';
import { AI_CATEGORIES, AI_FEATURES } from '@projekttool/shared';
import { requireUser } from '../auth.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { hasOrgRight, requireProject } from '../rights.js';
import { orgAiSettings } from '../ai/client.js';
import { aiAllowed, aiCapabilities, featureLabel, resolveRules, setAiPolicy } from '../ai/policy.js';
import { PROJECT_LABEL_SQL } from '../projectPolicy.js';

const mapRule = (r: any): AiPolicyRule => ({
  id: r.id, projectId: r.project_id, userId: r.user_id, groupId: r.group_id, feature: r.feature, effect: r.effect, note: r.note ?? null, setBy: r.set_by ?? null, setByName: r.set_by_name ?? null,
  updatedAt: r.updated_at, projectLabel: r.project_label ?? null, userName: r.user_name ?? null, userKind: r.user_kind ?? null, groupName: r.group_name ?? null
});

/**
 * KI-Freigaben: Regeln des Org-Admins bzw. der KI-Verwaltung (Ort × Wer × Funktion × erlauben/sperren), Notaus über
 * PUT /ai/settings, Vorschau der Wirkung für eine Person oder einen Agenten in einem Projekt mit Spur, und die Fähigkeiten
 * der angemeldeten Person im Projekt (für Knöpfe mit Begründung). Sperren selbst stehen nicht im Audit, nur Regeländerungen.
 */
export async function aiPolicyRoutes(app: FastifyInstance) {
  const db = app.db;
  const requireAiAdmin = (req: any): User => { const user = requireUser(req); if (!hasOrgRight(user, 'ai_admin')) throw forbidden('Nur Org-Admin oder KI-Verwaltung'); return user; };

  /** Regeln mit Namen; dazu Agenten der PL, die gerade an pl.agents scheitern (mit Knopf „erlauben“ in der Verwaltung). */
  async function listing(orgId: string) {
    const rows = await db.query(
      `select r.*, sb.name as set_by_name, ${PROJECT_LABEL_SQL} as project_label, u.name as user_name, u.kind as user_kind, g.name as group_name
       from ai_policies r left join users sb on sb.id = r.set_by left join projects p on p.id = r.project_id left join users ow on ow.id = p.created_by
         left join users u on u.id = r.user_id left join groups g on g.id = r.group_id
       where r.org_id = $1 order by r.project_id nulls first, r.group_id nulls first, r.user_id nulls first, r.feature`, [orgId]);
    const agents = await db.query(
      `select a.id, a.name, a.agent_project_id, a.agent_created_by, c.name as created_by_name, ${PROJECT_LABEL_SQL} as project_label
       from users a join projects p on p.id = a.agent_project_id left join users ow on ow.id = p.created_by left join users c on c.id = a.agent_created_by
       where a.org_id = $1 and a.kind = 'agent' and a.active order by a.name`, [orgId]);
    const stoppedAgents = [];
    for (const a of agents.rows) {
      const k = await resolveRules(db, { orgId, userId: a.agent_created_by, projectId: a.agent_project_id, feature: 'pl.agents' });
      if (k.effect === 'deny') stoppedAgents.push({ id: a.id, name: a.name, projectId: a.agent_project_id, projectLabel: a.project_label, createdById: a.agent_created_by ?? null, createdByName: a.created_by_name ?? null, reason: k.text });
    }
    return { rules: rows.rows.map(mapRule), killswitch: !(await orgAiSettings(db, orgId)).enabled, stoppedAgents };
  }

  app.get('/ai/policies', async (req) => listing(requireAiAdmin(req).orgId));

  // Regel setzen oder entfernen (effect null = erben); Funktion, Kategorie oder „*“; Wer: alle, Person/Agent oder Gruppe
  app.put<{ Body: { projectId?: string | null; userId?: string | null; groupId?: string | null; feature: string; effect: 'allow' | 'deny' | null; note?: string | null } }>('/ai/policies', async (req) => {
    const user = requireAiAdmin(req);
    const b = req.body ?? ({} as any);
    const feature = String(b.feature ?? '');
    const known = feature === '*' || AI_CATEGORIES.some((c) => c.key === feature) || AI_FEATURES.some((f) => f.key === feature && !('later' in f && f.later));
    if (!known) throw badRequest('Unbekannte KI-Funktion');
    if (b.effect !== 'allow' && b.effect !== 'deny' && b.effect !== null) throw badRequest('Wirkung: allow, deny oder null (erben)');
    const projectId = b.projectId || null; const userId = b.userId || null; const groupId = b.groupId || null;
    if (userId && groupId) throw badRequest('Entweder Person/Agent oder Gruppe');
    if (projectId && !(await db.maybeOne(`select 1 from projects where id = $1 and org_id = $2`, [projectId, user.orgId]))) throw notFound('Projekt nicht gefunden');
    if (userId && !(await db.maybeOne(`select 1 from users where id = $1 and org_id = $2`, [userId, user.orgId]))) throw notFound('Person oder Agent nicht gefunden');
    if (groupId && !(await db.maybeOne(`select 1 from groups where id = $1 and org_id = $2`, [groupId, user.orgId]))) throw notFound('Gruppe nicht gefunden');
    const note = String(b.note ?? '').trim().slice(0, 300) || null;
    await setAiPolicy(db, user, { projectId, userId, groupId, feature, effect: b.effect, note });
    return listing(user.orgId);
  });

  // Vorschau: Wirkung für eine Person oder einen Agenten (optional in einem Projekt), je Funktion mit Begründung und Spur
  app.get<{ Querystring: { userId?: string; projectId?: string } }>('/ai/policies/effective', async (req) => {
    const user = requireAiAdmin(req);
    const subj = await db.maybeOne(`select id, name, kind from users where id = $1 and org_id = $2`, [req.query.userId ?? null, user.orgId]);
    if (!subj) throw badRequest('Person oder Agent wählen');
    const project = req.query.projectId ? await db.maybeOne(`select p.id, ${PROJECT_LABEL_SQL} as label from projects p left join users ow on ow.id = p.created_by where p.id = $1 and p.org_id = $2`, [req.query.projectId, user.orgId]) : null;
    if (req.query.projectId && !project) throw notFound('Projekt nicht gefunden');
    const kind = subj.kind === 'agent' ? 'agent' : 'person';
    const features = [];
    for (const f of AI_FEATURES) {
      if (('later' in f && f.later) || (f.who !== 'both' && f.who !== kind)) continue;
      features.push({ feature: f.key, label: featureLabel(f.key), category: f.category, decision: await aiAllowed(db, { userId: subj.id, projectId: project?.id ?? null, feature: f.key }) });
    }
    return { subject: { id: subj.id, name: subj.name, kind }, project: project ? { id: project.id, label: project.label } : null, killswitch: !(await orgAiSettings(db, user.orgId)).enabled, features };
  });

  // Ziele für Regeln: Projekte (persönliche nur als „persönlich (Eigentümer)“), Personen, Agenten, Gruppen
  app.get<{ Querystring: { q?: string } }>('/ai/policy-targets', async (req) => {
    const user = requireAiAdmin(req);
    const like = `%${String(req.query.q ?? '').trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const projects = await db.query(`select p.id, ${PROJECT_LABEL_SQL} as label from projects p left join users ow on ow.id = p.created_by where p.org_id = $1 and p.status = 'active' and p.kind = 'project' and (${PROJECT_LABEL_SQL}) ilike $2 order by p.personal, p.key limit 100`, [user.orgId, like]);
    const people = await db.query(`select id, name, email, kind from users where org_id = $1 and active and (name ilike $2 or email ilike $2) order by kind, name limit 200`, [user.orgId, like]);
    const groups = await db.query(`select id, name from groups where org_id = $1 and name ilike $2 order by name limit 100`, [user.orgId, like]);
    return {
      projects: projects.rows.map((r: any) => ({ id: r.id, label: r.label })),
      users: people.rows.filter((r: any) => r.kind !== 'agent').map((r: any) => ({ id: r.id, name: r.name, email: r.email })),
      agents: people.rows.filter((r: any) => r.kind === 'agent').map((r: any) => ({ id: r.id, name: r.name })),
      groups: groups.rows.map((r: any) => ({ id: r.id, name: r.name }))
    };
  });

  // Fähigkeiten der angemeldeten Person im Projekt: je KI-Funktion erlaubt oder Begründung; Agenten des Projekts (Läufe, Chat)
  app.get<{ Params: { id: string } }>('/projects/:id/ai/capabilities', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id);
    return aiCapabilities(db, user, req.params.id);
  });
}
