-- Einsatz eines Org-Agenten (Konzept LLM/Agenten 2.2): alle Projekte oder ausgewählte; Projekt-Agenten (agent_project_id) nur das eigene.
alter table users add column if not exists agent_scope text not null default 'all' check (agent_scope in ('all','selected'));
create table if not exists agent_projects (
  agent_user_id uuid not null references users(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  primary key (agent_user_id, project_id)
);
