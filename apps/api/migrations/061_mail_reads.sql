-- Gelesen-Stand je Person und Mail (geteilte Postfächer: jede Person hat ihren eigenen); Öffnen einer Mail trägt ein.
create table if not exists mail_reads (
  mail_id uuid not null references mails(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (mail_id, user_id)
);
