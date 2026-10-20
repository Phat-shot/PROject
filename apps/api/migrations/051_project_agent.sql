-- Projektagent (dritte PL-Rolle) und Mail-Rückfrage: Spalten an projects kamen mit 050.
-- Fragen tragen einen Kontext (Thema, Mail, offene Punkte), damit Folgeaktionen (im Projekt fragen, beim Absender nachfragen) ohne Textanalyse laufen.
alter table questions add column if not exists context jsonb;
-- Offene Punkte aus der Mail-KI am Lauf (für Vorschlagsliste und Audit)
alter table mail_ai_runs add column if not exists open_points jsonb not null default '[]'::jsonb;
