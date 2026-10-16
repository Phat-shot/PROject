-- Zeiterfassung (optionales Modul, pro Projekt zuschaltbar)
alter table projects add column time_tracking_enabled boolean not null default false;
alter table projects add column budget_hours numeric(10,2);
alter table tasks add column estimate_minutes int;

create table time_entries (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  task_id uuid references tasks(id) on delete set null,
  user_id uuid not null references users(id),
  date date not null,
  minutes int not null check (minutes > 0 and minutes <= 1440),
  note text,
  created_at timestamptz not null default now()
);
create index time_entries_project_idx on time_entries(project_id, date desc);
create index time_entries_user_idx on time_entries(user_id, date desc);

-- @-Erwähnungen in Kommentaren
alter table task_comments add column mentions jsonb not null default '[]'::jsonb;
