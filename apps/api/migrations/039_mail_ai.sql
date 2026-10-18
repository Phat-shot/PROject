-- KI an Mail-Ansichten: Projekt-KI bearbeitet neue Mails direkt (Ordner „KI Bearbeiten“) im Auftrag einer Person;
-- ein Agent betreut eine Ansicht und schlägt für neue Mails Aktionen vor (Freigabe mit einem Klick)
alter table mail_views add column ai_process boolean not null default false;
alter table mail_views add column ai_process_by uuid references users(id) on delete set null;
alter table mail_views add column agent_user_id uuid references users(id) on delete set null;

create table mail_ai_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  view_id uuid references mail_views(id) on delete set null,
  mail_id uuid not null references mails(id) on delete cascade,
  mode text not null check (mode in ('process','triage')),
  actor_user_id uuid references users(id) on delete set null,
  agent_user_id uuid references users(id) on delete set null,
  status text not null default 'queued' check (status in ('queued','running','ok','error','skipped')),
  summary text,
  actions jsonb not null default '[]'::jsonb,
  error text,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create unique index mail_ai_runs_once on mail_ai_runs(mail_id, project_id, mode);
create index mail_ai_runs_project on mail_ai_runs(project_id, created_at desc);
create index mail_ai_runs_queued on mail_ai_runs(status) where status in ('queued','running');
