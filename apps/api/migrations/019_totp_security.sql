-- Zwei-Faktor-Anmeldung (TOTP) je Benutzer; Anmelde-Challenge zwischen Passwort und Code
alter table users add column totp_secret text;
alter table users add column totp_enabled boolean not null default false;
create table login_challenges (
  token text primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
