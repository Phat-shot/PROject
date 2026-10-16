-- Labels je Projekt
create table labels (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  color text not null default 'gray',
  position int not null default 0
);
create table task_labels (
  task_id uuid not null references tasks(id) on delete cascade,
  label_id uuid not null references labels(id) on delete cascade,
  primary key (task_id, label_id)
);

-- Board: WIP-Limit, Archiv, Wiederholung
alter table board_columns add column wip_limit int;
alter table tasks add column archived_at timestamptz;
alter table tasks add column recurrence jsonb;
alter table tasks add column recurrence_parent_id uuid references tasks(id) on delete set null;
alter table tasks add column recurrence_next_created boolean not null default false;
create index tasks_archived_idx on tasks(project_id, archived_at);

-- Doku-Freigabe per Link (Seite + Unterseiten, lesend oder schreibend, an eine Mail-Adresse)
create table doc_shares (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references doc_pages(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  token text not null unique,
  email text not null,
  mode text not null check (mode in ('read','write')),
  include_children boolean not null default true,
  expires_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_access_at timestamptz,
  access_count int not null default 0
);
alter table doc_page_versions add column external_editor text;
alter table doc_pages add column updated_by_external text;

-- In-App-Benachrichtigungen (regelbasiert, vom Worker/der API erzeugt)
create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  link text,
  dedupe_key text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index notifications_dedupe_idx on notifications(user_id, dedupe_key) where dedupe_key is not null;
create index notifications_user_idx on notifications(user_id, read_at, created_at desc);
