-- Quellen für KI-Agenten je Projekt: Doku-Ordner, Dateiquellen-Einbindungen und Mails einzeln ausschließbar (Standard: an).
-- Ausgeschlossenes sieht der Agent weder in Suche/Prompt noch über read_page/read_file/read_mail; Menschen sehen alles wie bisher.
alter table doc_folders add column if not exists agent_enabled boolean not null default true;
alter table file_source_projects add column if not exists agent_enabled boolean not null default true;
alter table projects add column if not exists agent_mail_search boolean not null default true;

-- Aufgabe → Checklistenpunkt umkehrbar: die Aufgabe liegt im Papierkorb; gemerkt werden der erzeugte Punkt, die Ziel-Aufgabe und
-- die mitgewanderten Checklistenpunkte/Anhänge, damit „Wiederherstellen“ alles zurückholt.
alter table tasks add column if not exists demoted jsonb;
