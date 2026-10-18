-- Vorläufige Termine (von KI eingetragen): verbindlich erst nach Bestätigung durch eine Person
alter table meetings add column tentative boolean not null default false;
alter table meetings add column confirmed_by uuid references users(id) on delete set null;
alter table meetings add column confirmed_at timestamptz;
-- Rückmeldungen aus dem Chat im Log des Arbeitspakets
alter table task_comments drop constraint if exists task_comments_source_check;
alter table task_comments add constraint task_comments_source_check check (source in ('user','mail','system','ai','chat'));
