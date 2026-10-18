-- Freigabe eines KI-Profils für Projekte: alle, ausgewählte oder keine (dann nur für Agenten des Org-Admins)
alter table ai_profiles add column project_scope text not null default 'all' check (project_scope in ('all','selected','none'));
create table ai_profile_projects (
  profile_id uuid not null references ai_profiles(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  primary key (profile_id, project_id)
);
-- Eigenes LLM eines Projekts (von der PL eingebunden, wenn der Mandant es erlaubt): nur dort nutzbar, vom Org-Admin sperrbar
alter table ai_profiles add column project_id uuid references projects(id) on delete cascade;
alter table ai_profiles add column created_by uuid references users(id) on delete set null;
alter table ai_profiles add column admin_blocked boolean not null default false;
-- Verbrauch je Profil (Metadaten für den Org-Admin)
alter table ai_profiles add column tokens_in bigint not null default 0;
alter table ai_profiles add column tokens_out bigint not null default 0;
alter table ai_profiles add column last_used_at timestamptz;
