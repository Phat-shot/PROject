-- Ursprungsmail: aus dieser Mail ist das Arbeitspaket bzw. die Aufgabe entstanden; die abschließende Antwort geht an sie
alter table mail_task_links add column origin boolean not null default false;
-- Unterschrift je KI-Agent, frei formulierbar (leer = Standard „Name (KI-Agent, Projekt KEY)“)
alter table users add column signature text;
