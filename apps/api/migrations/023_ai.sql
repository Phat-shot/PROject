-- KI-Modul: Schlüssel je Mandant, Zusammenfassungen, Vorschläge mit Freigabe
alter table orgs add column ai_api_key text;
alter table mails add column ai_summary text;
alter table task_comments drop constraint if exists task_comments_source_check;
alter table task_comments add constraint task_comments_source_check check (source in ('user','mail','system','ai'));
create table ai_proposals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  kind text not null check (kind in ('task_update','page_append')),
  mail_id uuid references mails(id) on delete set null,
  task_id uuid references tasks(id) on delete cascade,
  page_id uuid references doc_pages(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_by uuid references users(id) on delete set null,
  decided_by uuid references users(id) on delete set null,
  decided_at timestamptz,
  note text,
  created_at timestamptz not null default now()
);
create index ai_proposals_project_idx on ai_proposals(project_id, status);
