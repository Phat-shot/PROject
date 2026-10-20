-- Online-Recherche (Konzept 8): Profilfreigabe, Zähler, Quellen; Arbeitszeitfenster für Mails nach außen (geplanter Versand)
alter table ai_profiles add column if not exists web_search boolean not null default false;
alter table agent_runs add column if not exists web_searches int not null default 0;
create table if not exists agent_web_sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  run_id uuid references agent_runs(id) on delete cascade,
  task_id uuid references tasks(id) on delete cascade,
  page_id uuid references doc_pages(id) on delete set null,
  query text,
  url text not null,
  title text,
  cited_text text,
  retrieved_at timestamptz not null default now()
);
create index if not exists agent_web_sources_task_idx on agent_web_sources(task_id);
alter table mail_drafts drop constraint if exists mail_drafts_status_check;
alter table mail_drafts add constraint mail_drafts_status_check check (status in ('draft','pending_approval','scheduled','sent','failed'));
alter table mail_drafts add column if not exists send_at timestamptz;
alter table mail_drafts add column if not exists in_reply_references text;
create index if not exists mail_drafts_scheduled_idx on mail_drafts(send_at) where status = 'scheduled';
