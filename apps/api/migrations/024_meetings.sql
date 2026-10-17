-- Besprechung als Objekt: Termin ↔ Protokollseite ↔ Arbeitspakete, Teilnehmer, Einladung per ICS
create table meetings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  location text,
  description text,
  series_page_id uuid references doc_pages(id) on delete set null,
  page_id uuid references doc_pages(id) on delete set null,
  attendees jsonb not null default '[]'::jsonb,
  invite_sent_at timestamptz,
  external jsonb not null default '{}'::jsonb,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index meetings_project_idx on meetings(project_id, starts_at);
create table meeting_tasks (
  meeting_id uuid not null references meetings(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  primary key (meeting_id, task_id)
);
