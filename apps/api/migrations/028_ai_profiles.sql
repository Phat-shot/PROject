-- Mehrere KI-Profile je Mandant: Agenten und Projekte bekommen je eines zugewiesen; bisherige Einzelkonfiguration wird übernommen
create table ai_profiles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  provider text not null check (provider in ('anthropic','local')),
  base_url text,
  model text not null,
  api_key text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index ai_profiles_org_idx on ai_profiles(org_id);
alter table users add column ai_profile_id uuid references ai_profiles(id) on delete set null;
alter table projects add column ai_profile_id uuid references ai_profiles(id) on delete set null;
do $$
declare o record; pid uuid;
begin
  for o in select id, settings, ai_api_key from orgs loop
    if (o.settings->'ai'->>'model') is not null or o.ai_api_key is not null then
      insert into ai_profiles (org_id, name, provider, base_url, model, api_key)
        values (o.id, case when coalesce(o.settings->'ai'->>'provider','anthropic') = 'local' then 'Lokales LLM' else 'Anthropic' end,
          case when coalesce(o.settings->'ai'->>'provider','anthropic') = 'local' then 'local' else 'anthropic' end,
          o.settings->'ai'->>'baseUrl', coalesce(o.settings->'ai'->>'model', 'claude-opus-5-5'), o.ai_api_key)
        returning id into pid;
      update orgs set settings = settings || jsonb_build_object('ai', coalesce(settings->'ai', '{}'::jsonb) || jsonb_build_object('defaultProfileId', pid)) where id = o.id;
      update projects set ai_profile_id = pid where org_id = o.id and ai_profile_id is null;
      update users set ai_profile_id = pid where org_id = o.id and kind = 'agent' and ai_profile_id is null;
    end if;
  end loop;
end $$;
