-- Workflows: definierte Abläufe (Arbeitspaket → Timer → Arbeitspaket → Warten auf Ereignis → Mail …) und ihre Läufe
create table workflow_defs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  description text,
  steps jsonb not null default '[]'::jsonb,
  active boolean not null default true,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index workflow_defs_project_idx on workflow_defs(project_id);
create table workflow_runs (
  id uuid primary key default gen_random_uuid(),
  def_id uuid references workflow_defs(id) on delete set null,
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  def_name text not null,
  steps jsonb not null default '[]'::jsonb,
  state jsonb not null default '[]'::jsonb,
  vars jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active','done','cancelled')),
  current_step int not null default 0,
  standalone boolean not null default false,
  column_id uuid references board_columns(id) on delete set null,
  subproject_id uuid references subprojects(id) on delete set null,
  started_by uuid references users(id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  last_error text
);
create index workflow_runs_project_idx on workflow_runs(project_id, status);
alter table tasks add column workflow_run_id uuid references workflow_runs(id) on delete set null;
create index tasks_workflow_run_idx on tasks(workflow_run_id) where workflow_run_id is not null;
