-- Chat: ein Kanal je Projekt (Threads als Antworten) und Direktnachrichten zwischen Benutzern des Mandanten
create table chat_channels (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  kind text not null check (kind in ('project','dm')),
  project_id uuid references projects(id) on delete cascade,
  created_at timestamptz not null default now()
);
create unique index chat_channels_project_idx on chat_channels(project_id) where project_id is not null;
create table chat_channel_members (
  channel_id uuid not null references chat_channels(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);
create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references chat_channels(id) on delete cascade,
  user_id uuid not null references users(id),
  thread_id uuid references chat_messages(id) on delete cascade,
  body text not null,
  mentions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);
create index chat_messages_channel_idx on chat_messages(channel_id, created_at);
create index chat_messages_thread_idx on chat_messages(thread_id);
