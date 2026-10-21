-- KI neu geordnet: Im Projekt arbeiten nur Agenten. Ein Agent gehört zu genau einem LLM; wer das LLM verwaltet (Org-LLM:
-- KI-Verwaltung, eigenes LLM eines Projekts: dessen PL), legt den Agenten an und berechtigt ihn. Die PL schränkt im Projekt
-- nur weiter ein (project_members.agent_policy.deny, strengere Selbstständigkeit). Die Regelmatrix ai_policies entfällt.
alter table users add column if not exists agent_rights text[];
-- Obergrenze des Verwalters für die Selbstständigkeit (mode, confirm, maxMode, lockedConfirm, workflows, depth, maxDepth)
alter table users add column if not exists agent_policy jsonb;

-- Jeder Agent hat ein LLM: bisher ohne eigenes LLM = Standard-LLM des Mandanten (solange es existiert)
update users u set ai_profile_id = a.id
from orgs o join ai_profiles a on a.org_id = o.id
where u.kind = 'agent' and u.ai_profile_id is null and o.id = u.org_id and a.id::text = o.settings->'ai'->>'defaultProfileId';

-- Rechte des Agenten aus den bisherigen Regeln, ohne etwas zu öffnen: Regel für den Agenten, sonst für den Mandanten, sonst Standard
with feats(f, cat, def_allow) as (values
  ('assist.summarize', 'assist', true), ('assist.essence', 'assist', true), ('assist.report', 'assist', true), ('assist.ask', 'assist', true), ('assist.final_reply', 'assist', true),
  ('mail.triage', 'mail', true), ('agent.mail', 'mail', true),
  ('agent.run', 'agent', true), ('agent.chat', 'agent', true), ('agent.order', 'agent', true), ('agent.web', 'agent', false),
  ('agent.finalize', 'agent', true), ('agent.distribute', 'agent', true), ('agent.send_external', 'agent', true), ('agent.close', 'agent', true),
  ('agent.restructure', 'agent', true), ('agent.plan', 'agent', true), ('agent.assign', 'agent', true), ('agent.schedule', 'agent', true),
  ('agent.foreign', 'agent', true), ('agent.workflow', 'agent', true)
), cand as (
  select u.id as agent_id, x.f, x.def_allow,
    (select r.effect from ai_policies r where r.org_id = u.org_id and r.project_id is null and r.group_id is null and r.user_id = u.id and r.feature in ('*', x.cat, x.f)
      order by case when r.feature = x.f then 0 when r.feature = '*' then 2 else 1 end limit 1) as agent_eff,
    (select r.effect from ai_policies r where r.org_id = u.org_id and r.project_id is null and r.group_id is null and r.user_id is null and r.feature in ('*', x.cat, x.f)
      order by case when r.feature = x.f then 0 when r.feature = '*' then 2 else 1 end limit 1) as org_eff
  from users u cross join feats x where u.kind = 'agent'
)
update users u set agent_rights = coalesce((select array_agg(c.f order by c.f) from cand c where c.agent_id = u.id and coalesce(c.agent_eff, c.org_eff, case when c.def_allow then 'allow' else 'deny' end) = 'allow'), '{}')
where u.kind = 'agent' and u.agent_rights is null;

-- Sperren je Projekt (für den Agenten oder das ganze Projekt) werden Einschränkungen der PL am Agenten im Projekt
with feats(f, cat) as (values
  ('assist.summarize', 'assist'), ('assist.essence', 'assist'), ('assist.report', 'assist'), ('assist.ask', 'assist'), ('assist.final_reply', 'assist'),
  ('mail.triage', 'mail'), ('agent.mail', 'mail'), ('agent.run', 'agent'), ('agent.chat', 'agent'), ('agent.order', 'agent'), ('agent.web', 'agent'),
  ('agent.finalize', 'agent'), ('agent.distribute', 'agent'), ('agent.send_external', 'agent'), ('agent.close', 'agent'), ('agent.restructure', 'agent'),
  ('agent.plan', 'agent'), ('agent.assign', 'agent'), ('agent.schedule', 'agent'), ('agent.foreign', 'agent'), ('agent.workflow', 'agent')
), den as (
  select m.project_id, m.user_id, jsonb_agg(distinct x.f) as deny
  from project_members m join users u on u.id = m.user_id and u.kind = 'agent' cross join feats x
  where exists (select 1 from ai_policies r where r.project_id = m.project_id and r.group_id is null and (r.user_id = m.user_id or r.user_id is null) and r.effect = 'deny' and r.feature in ('*', x.cat, x.f))
  group by m.project_id, m.user_id
)
update project_members m set agent_policy = coalesce(m.agent_policy, '{}'::jsonb) || jsonb_build_object('deny', den.deny)
from den where den.project_id = m.project_id and den.user_id = m.user_id;

-- Agenten-Policy des Mandanten wird Obergrenze jedes Agenten (der Verwalter des LLM pflegt sie künftig am Agenten)
update users u set agent_policy = o.settings->'ai'->'agentPolicy'
from orgs o where o.id = u.org_id and u.kind = 'agent' and u.agent_policy is null and jsonb_typeof(o.settings->'ai'->'agentPolicy') = 'object';
