-- KI-Agenten als Benutzer: Kennzeichen, Mail-Erlaubnis je Mitgliedschaft, Läufe, Pause je Arbeitspaket
alter table users add column kind text not null default 'person' check (kind in ('person','agent'));
alter table project_members add column agent_can_mail boolean not null default true;
alter table tasks add column agent_paused boolean not null default false;
create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  agent_user_id uuid not null references users(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  task_id uuid references tasks(id) on delete cascade,
  trigger text not null,
  status text not null default 'ok' check (status in ('ok','error','skipped')),
  reasoning text,
  actions jsonb not null default '[]'::jsonb,
  fingerprint text,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  error text,
  created_at timestamptz not null default now()
);
create index agent_runs_task_idx on agent_runs(task_id, created_at desc);
create index agent_runs_agent_idx on agent_runs(agent_user_id, created_at desc);
