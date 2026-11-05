-- Gespräch archivieren (je Person): ausgeblendet, bis danach eine neue Nachricht kommt
create table chat_archive (
  channel_id uuid not null references chat_channels(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  archived_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);
