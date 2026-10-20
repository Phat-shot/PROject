-- Ressourcen und Personen im Kalender (Konzept 10, P10): buchbare Ressourcen (Pool des Mandanten oder je Projekt) und Belegungen
-- (Ressource oder interne Person; an Besprechung, AP bzw. Aufgabe oder frei; ohne Projekt Sperrzeit bzw. Abwesenheit); Bestätigungsfrage je Buchung
create table if not exists resources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  kind text not null check (kind in ('room','equipment','scaffold','vehicle','person','other')),
  name text not null,
  description text,
  location text,
  email text,
  phone text,
  organization text,
  trade text,
  approval_group_id uuid references groups(id) on delete set null,
  active boolean not null default true,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists resources_org_idx on resources(org_id, project_id);
create unique index if not exists resources_name_uniq on resources(org_id, coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
create table if not exists resource_bookings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  resource_id uuid references resources(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  meeting_id uuid references meetings(id) on delete cascade,
  task_id uuid references tasks(id) on delete cascade,
  follow_task boolean not null default false,
  title text,
  note text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  all_day boolean not null default false,
  tentative boolean not null default false,
  confirmed_by uuid references users(id) on delete set null,
  confirmed_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((resource_id is null) <> (user_id is null)),
  check (ends_at > starts_at),
  check (project_id is not null or (meeting_id is null and task_id is null))
);
create index if not exists resource_bookings_res_idx on resource_bookings(resource_id, starts_at) where resource_id is not null;
create index if not exists resource_bookings_user_idx on resource_bookings(user_id, starts_at) where user_id is not null;
create index if not exists resource_bookings_project_idx on resource_bookings(project_id, starts_at);
create index if not exists resource_bookings_task_idx on resource_bookings(task_id) where task_id is not null;
create unique index if not exists resource_bookings_meeting_uniq on resource_bookings(meeting_id, resource_id) where meeting_id is not null and resource_id is not null;
alter table questions add column if not exists booking_id uuid references resource_bookings(id) on delete set null;
create index if not exists questions_booking_idx on questions(booking_id) where booking_id is not null;
