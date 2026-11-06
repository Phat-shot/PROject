import type { FastifyInstance } from 'fastify';
import type { AssistantState } from '@projekttool/shared';
import { DEFAULT_AGENT_RIGHTS } from '@projekttool/shared';
import { randomBytes } from 'node:crypto';
import { requireUser } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { requireProject } from '../rights.js';
import { orgAiSettings, projectProfiles } from '../ai/client.js';
import { KILLSWITCH_TEXT, personalAiReason } from '../ai/policy.js';
import { dmChannel } from '../notify.js';
import { projectPolicy, TEXT } from '../projectPolicy.js';

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'assistent';
const PERSONA_MAX = 300;

/**
 * Persönlicher Assistent (C): ein Agent vom Typ Assistent (users.kind = 'agent', agent_role = 'assistant'), den die Person in
 * ihrem persönlichen Projekt selbst anlegt, sobald ein LLM für sie frei ist (freigegebenes Mandanten-Profil oder eigenes LLM
 * des Projekts). Gebunden an das persönliche Projekt (agent_project_id), dort stellvertretende PL und Projektagent, Rechte =
 * DEFAULT_AGENT_RIGHTS, Tagesbudget aus dem Mandanten. Höchstens einer je persönlichem Projekt; nur der Eigentümer.
 */
export async function assistantRoutes(app: FastifyInstance) {
  const db = app.db;

  /** Persönliches Projekt des Aufrufers oder Fehler (nur der Eigentümer). */
  const ownPersonalProject = async (user: { id: string; orgId: string }, projectId: string) => {
    const p = await db.maybeOne(`select id, org_id, key, name, personal, created_by, status from projects where id = $1 and org_id = $2`, [projectId, user.orgId]);
    if (!p) throw notFound('Projekt nicht gefunden');
    if (!projectPolicy(p).assistant || p.created_by !== user.id) throw forbidden(TEXT.assistantOwnerOnly);
    return p;
  };
  const assistantOf = async (projectId: string) => db.maybeOne(`select u.*, a.name as profile_name from users u left join ai_profiles a on a.id = u.ai_profile_id where u.kind = 'agent' and u.agent_role = 'assistant' and u.agent_project_id = $1 order by u.active desc, u.created_at limit 1`, [projectId]);
  const mapAssistant = async (r: any, userId: string, orgId: string): Promise<NonNullable<AssistantState['assistant']>> => ({ id: r.id, name: r.name, persona: r.persona ?? null, active: Boolean(r.active), aiProfileId: r.ai_profile_id ?? null, profileName: r.profile_name ?? null, dailyBudget: r.agent_daily_budget ?? null, channelId: await dmChannel(db, orgId, r.id, userId) });
  /** Sperrgründe: Freigabe der Person, Notaus, kein wählbares LLM. */
  const state = async (user: { id: string; orgId: string }, p: any): Promise<AssistantState> => {
    const blocked: string[] = [];
    const personal = await personalAiReason(db, p);
    if (personal) blocked.push(personal);
    if (!(await orgAiSettings(db, user.orgId)).enabled) blocked.push(KILLSWITCH_TEXT);
    const profiles = await projectProfiles(db, p.id);
    if (!profiles.length) blocked.push(TEXT.assistantNoProfile);
    const a = await assistantOf(p.id);
    return { assistant: a ? await mapAssistant(a, user.id, user.orgId) : null, profiles, blocked, canCreate: !a && !blocked.length };
  };

  app.get<{ Params: { id: string } }>('/projects/:id/assistant', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id);
    return state(user, await ownPersonalProject(user, req.params.id));
  });

  app.post<{ Params: { id: string }; Body: { name?: string; profileId: string; persona?: string | null } }>('/projects/:id/assistant', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id, 'pl');
    const p = await ownPersonalProject(user, req.params.id);
    const b = req.body ?? ({} as any);
    const st = await state(user, p);
    if (st.assistant) throw conflict(TEXT.assistantExists);
    const hard = st.blocked.find((x) => x !== TEXT.assistantNoProfile);
    if (hard) throw forbidden(hard);
    if (!b.profileId) throw badRequest('LLM wählen (profileId)');
    const profile = st.profiles.find((x) => x.id === b.profileId);
    if (!profile) throw badRequest(st.profiles.length ? TEXT.assistantProfileNotReleased : TEXT.assistantNoProfile);
    const name = String(b.name ?? '').trim().slice(0, 80) || 'Assistent';
    const persona = b.persona === null || b.persona === undefined ? null : String(b.persona).replace(/\s+/g, ' ').trim().slice(0, PERSONA_MAX) || null;
    const email = `${slug(name)}-${randomBytes(3).toString('hex')}@agent.local`;
    const r = await db.one(
      `insert into users (org_id, email, name, password_hash, global_role, kind, agent_role, ai_profile_id, persona, agent_scope, agent_project_id, agent_created_by, agent_daily_budget, agent_rights, agent_policy)
       values ($1,$2,$3,'','user','agent','assistant',$4,$5,'all',$6,$7,null,$8,'{}'::jsonb) returning *`,
      [user.orgId, email, name, profile.id, persona, p.id, user.id, DEFAULT_AGENT_RIGHTS]
    );
    // Mitglied im persönlichen Projekt als stellvertretende PL und Projektagent (Aufträge, Mails der eigenen Konten, Kalender)
    await db.query(
      `insert into project_members (project_id, user_id, role, is_deputy, can_edit_plan, can_approve, can_finalize, can_use_ai, agent_can_mail, origin) values ($1,$2,'pl',true,true,false,false,true,true,'direct')
       on conflict (project_id, user_id) do update set role = 'pl', is_deputy = true, can_edit_plan = true, can_use_ai = true, origin = 'direct'`, [p.id, r.id]);
    await db.query(`update projects set agent_user_id = $2 where id = $1 and agent_user_id is null`, [p.id, r.id]);
    await audit(db, { orgId: user.orgId, projectId: p.id, userId: user.id, action: 'assistant.create', objectType: 'user', objectId: r.id, details: { name, profile: profile.name } });
    return state(user, p);
  });
}
