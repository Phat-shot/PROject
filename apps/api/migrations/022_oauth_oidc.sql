-- OAuth2 für Mail-Konten (Microsoft 365 über Graph oder IMAP-XOAUTH2, Google über IMAP/SMTP-XOAUTH2) und OIDC-Anmeldung
alter table mail_accounts drop constraint if exists mail_accounts_provider_check;
alter table mail_accounts add constraint mail_accounts_provider_check check (provider in ('imap','dev','graph'));
alter table mail_accounts add column oauth_provider text check (oauth_provider in ('microsoft','google'));
alter table mail_accounts add column oauth_refresh_token text;
alter table mail_accounts add column oauth_access_token text;
alter table mail_accounts add column oauth_expires_at timestamptz;
create table oauth_states (
  state text primary key,
  user_id uuid references users(id) on delete cascade,
  purpose jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null
);
alter table users add column oidc_subject text;
create unique index users_oidc_subject_idx on users(oidc_subject) where oidc_subject is not null;
