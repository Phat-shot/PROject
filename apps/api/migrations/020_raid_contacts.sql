-- RAID-Register je Projekt (Risiken, Annahmen, Issues, Entscheidungen) und erweiterte Kontakte
create table raid_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  number int not null,
  kind text not null check (kind in ('risk','assumption','issue','decision')),
  title text not null,
  description text,
  probability int check (probability between 1 and 5),
  impact int check (impact between 1 and 5),
  status text not null default 'open' check (status in ('open','mitigated','closed')),
  owner_user_id uuid references users(id) on delete set null,
  due_date date,
  mitigation text,
  decided_on date,
  task_id uuid references tasks(id) on delete set null,
  page_id uuid references doc_pages(id) on delete set null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, number)
);
create index raid_items_project_idx on raid_items(project_id, kind, status);
alter table project_contacts add column role text;
alter table project_contacts add column organization text;
alter table project_contacts add column phone text;
alter table project_contacts add column notes text;
alter table project_contacts add column created_at timestamptz not null default now();
