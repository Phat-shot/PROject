-- KI-Freigaben des Org-Admins und Org-Rechte; Notaus liegt in orgs.settings.ai.enabled
alter table users add column org_rights text[] not null default '{}'
  check (org_rights <@ array['ai_admin','groups_admin','resources_admin']::text[]);
create table ai_policies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,      -- null = alle Projekte
  user_id uuid references users(id) on delete cascade,            -- Person oder Agent; null = alle
  group_id uuid references groups(id) on delete cascade,
  feature text not null check (feature ~ '^(\*|assist|mail|agent|pl)(\.[a-z_]+)?$'),
  effect text not null check (effect in ('allow','deny')),
  note text,
  set_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (user_id is null or group_id is null)
);
create unique index ai_policies_uq on ai_policies (org_id, project_id, user_id, group_id, feature) nulls not distinct;
create index ai_policies_org_idx on ai_policies (org_id);
-- Bestand: Schalter „Eigene Agenten der PL“ als Org-Regel
insert into ai_policies (org_id, feature, effect, note)
  select id, 'pl.agents',
         case when coalesce((settings->'ai'->'plAgents'->>'enabled')::boolean, false) then 'allow' else 'deny' end,
         'übernommen aus „Eigene Agenten der PL“' from orgs;
-- Audit der Übernahme; war der Schalter aus, stehen die Agenten der PL darin, die damit stoppen (gewollt)
insert into audit_log (org_id, action, object_type, object_id, details)
  select r.org_id, 'ai.policy.migrated', 'ai_policy', r.id::text,
         jsonb_build_object('feature', r.feature, 'effect', r.effect, 'note', r.note,
           'stoppedAgents', case when r.effect = 'deny' then coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name, 'projectId', u.agent_project_id) order by u.name)
             from users u where u.org_id = r.org_id and u.kind = 'agent' and u.active and u.agent_project_id is not null), '[]'::jsonb) else '[]'::jsonb end)
  from ai_policies r;
-- Bestandsschutz: wer Mail-KI eingeschaltet hat, behält „KI nutzen“
update project_members pm set can_use_ai = true from mail_views v
  where v.ai_process and v.ai_process_by = pm.user_id and v.project_id = pm.project_id;
