-- Informationsgrenze: Sichtbarkeit von Log-Einträgen, Außenbeschreibung, externes Profil, Prüfprotokoll
alter table task_comments add column visibility text not null default 'internal' check (visibility in ('internal','external'));
alter table tasks add column external_brief text;
alter table projects add column external_profile jsonb not null default '{}'::jsonb;  -- {name, address, access, contacts:[{name,email,role}]}
create table outbound_checks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  task_id uuid references tasks(id) on delete set null,
  run_id uuid references agent_runs(id) on delete set null,
  channel text not null check (channel in ('mail','reply_origin','pdf','draft','chat')),
  recipients jsonb not null,
  audience text not null check (audience in ('internal','outside','task_external','unknown_external')),
  result text not null check (result in ('pass','held','blocked')),
  findings jsonb not null default '[]'::jsonb,
  withheld jsonb not null default '[]'::jsonb,
  mail_draft_id uuid references mail_drafts(id) on delete set null,
  decided_by uuid references users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index outbound_checks_held_idx on outbound_checks(project_id) where result = 'held';
create index outbound_checks_draft_idx on outbound_checks(mail_draft_id) where mail_draft_id is not null;
-- Angehaltener PDF-Versand eines Agenten: der Entwurf merkt sich die Seite, deren PDF beim Senden angehängt wird
alter table mail_drafts add column page_id uuid references doc_pages(id) on delete set null;
