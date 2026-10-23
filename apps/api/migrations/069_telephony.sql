-- Telefonie (sipgate Flow und sipgate.io): Rufnummern mit Projekt, Agent und KI-Profil; Anrufe mit Verlauf; Telefonnummer am Benutzer
create table telephony_config (
  org_id uuid primary key references orgs(id) on delete cascade,
  enabled boolean not null default false,
  -- Token bzw. HMAC-Schlüssel für Flow-Ereignisse (verschlüsselt), Pfad-Token für sipgate.io-Webhooks (verschlüsselt)
  flow_secret text,
  io_token text,
  updated_at timestamptz not null default now()
);

create table phone_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  -- nur Ziffern mit Ländervorwahl, z. B. 4921112345678
  number text not null,
  label text not null default '',
  project_id uuid references projects(id) on delete set null,
  agent_user_id uuid references users(id) on delete set null,
  ai_profile_id uuid references ai_profiles(id) on delete set null,
  greeting text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (org_id, number)
);

create table calls (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  line_id uuid references phone_lines(id) on delete set null,
  provider text not null check (provider in ('flow', 'sipgate_io')),
  external_id text not null,
  direction text not null default 'in' check (direction in ('in', 'out')),
  from_number text,
  to_number text,
  caller_user_id uuid references users(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  task_id uuid references tasks(id) on delete set null,
  meeting_id uuid references meetings(id) on delete set null,
  agent_user_id uuid references users(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'ended')),
  transcript jsonb not null default '[]',
  notes jsonb not null default '{}',
  summary text,
  error text,
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  unique (provider, external_id)
);
create index calls_org_idx on calls(org_id, started_at desc);

alter table users add column if not exists phone text;
