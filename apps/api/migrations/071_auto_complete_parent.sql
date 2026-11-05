-- Arbeitspaket automatisch erledigt, wenn alle Aufgaben erledigt sind: Vorgabe je Projekt, je Arbeitspaket übersteuerbar (null = Projekt)
alter table projects add column auto_complete_parent boolean not null default true;
alter table tasks add column auto_complete boolean;
