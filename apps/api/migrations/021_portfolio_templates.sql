-- Projektampel (manueller Status) und Projektvorlagen je Mandant
alter table projects add column health jsonb not null default '{}'::jsonb;
create table project_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  description text,
  spec jsonb not null default '{}'::jsonb,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
