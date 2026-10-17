-- Passwort zurücksetzen per Mail-Link (Self-Service); Token einmalig, 2 Stunden gültig
create table password_resets (
  token text primary key,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index password_resets_user on password_resets(user_id);
