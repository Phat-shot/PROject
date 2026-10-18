-- Aufgabe: Zwischenebene zwischen Arbeitspaket und Task (Checkliste). Eine Aufgabe ist ein Arbeitspaket mit parent_id
-- (eine Ebene tief) und hat damit Zuständigkeit, Status, Termine, Log, Mail-Antwortadresse und Anhänge wie ein Arbeitspaket.
alter table tasks add column parent_id uuid references tasks(id) on delete cascade;
create index tasks_parent_idx on tasks(parent_id);
