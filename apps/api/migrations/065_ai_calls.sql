-- Zentrales KI-Log: jede Anfrage an ein LLM (Agentenlauf, Chat, Mail-KI, Assistenz) mit Dauer, Status und Token, unabhängig
-- vom Projekt. Nur Metadaten und technische Fehler, keine Prompts oder Antworten (Projektinhalte bleiben im Projekt).
-- Zeitlimit je LLM (lokale Modelle mit Denkmodus brauchen länger).
alter table ai_profiles add column if not exists timeout_s int;
create table if not exists ai_calls (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  profile_id uuid references ai_profiles(id) on delete set null,
  profile_name text,
  model text,
  agent_user_id uuid references users(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  task_id uuid references tasks(id) on delete set null,
  feature text not null default 'ki',
  thinking boolean,
  status text not null default 'running',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms int,
  input_tokens int,
  output_tokens int,
  reasoning_chars int,
  retried boolean not null default false,
  error text
);
create index if not exists ai_calls_org_idx on ai_calls (org_id, started_at desc);
