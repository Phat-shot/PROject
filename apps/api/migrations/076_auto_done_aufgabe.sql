-- Aufgabe automatisch erledigt, wenn alle ihre Checklistenpunkte erledigt sind: Vorgabe je Projekt (Standard an), je Aufgabe über
-- tasks.auto_complete übersteuerbar (null = Projekt). auto_done_at/auto_done_from_column_id: von der Automatik erledigt und aus
-- welcher Spalte, damit ein wieder geöffneter Punkt die Aufgabe dorthin zurückholt; ein manueller Statuswechsel löscht beides.
alter table projects add column if not exists auto_done_aufgabe boolean not null default true;
alter table tasks add column if not exists auto_done_at timestamptz;
alter table tasks add column if not exists auto_done_from_column_id uuid references board_columns(id) on delete set null;
