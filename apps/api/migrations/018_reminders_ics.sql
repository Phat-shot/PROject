-- Erinnerungen an Externe (Regel je Projekt) und Kalender-Abo (ICS) je Benutzer
alter table projects add column reminders jsonb not null default '{}'::jsonb;
create table task_reminders (
  task_id uuid not null references tasks(id) on delete cascade,
  kind text not null,
  sent_on date not null,
  primary key (task_id, kind, sent_on)
);
alter table users add column ics_token text unique;
