-- Projektwissen (Konzept 6.6–6.8, P9): Reichweite und Kontextstatistik je Lauf, Kontextgröße je Profil, Beziehungen zwischen APs, Projektüberblick je Sichtbarkeit
alter table agent_runs add column if not exists scope text not null default 'task' check (scope in ('task','project','chat','mail'));
alter table agent_runs add column if not exists context_stats jsonb;
alter table ai_profiles add column if not exists context_tokens int check (context_tokens is null or context_tokens >= 4000);
create table if not exists task_relations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  task_a uuid not null references tasks(id) on delete cascade,
  task_b uuid not null references tasks(id) on delete cascade,
  kind text not null check (kind in ('related','sync','duplicate','dependency')),
  status text not null default 'suggested' check (status in ('suggested','asked','accepted','rejected')),
  signals jsonb not null default '[]'::jsonb,
  note text,
  lead_task_id uuid references tasks(id) on delete set null,
  question_id uuid references questions(id) on delete set null,
  found_by uuid references users(id) on delete set null,
  decided_by uuid references users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  check (task_a < task_b)
);
create unique index if not exists task_relations_uq on task_relations(task_a, task_b, kind);
create index if not exists task_relations_project_idx on task_relations(project_id, status);
create table if not exists project_digests (
  project_id uuid not null references projects(id) on delete cascade,
  visibility_key text not null,
  structure text not null,
  brief text,
  source_hash text not null,
  brief_run_id uuid references agent_runs(id) on delete set null,
  built_at timestamptz not null default now(),
  primary key (project_id, visibility_key)
);
