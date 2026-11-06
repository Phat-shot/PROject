-- Spaltengruppen: Spalten mit gleichem Gruppennamen erscheinen im Board als eine Spalte mit Abschnitten
-- (z. B. Geplant, Wartet und Zurückgestellt als „Offen“). Bestehende Projekte bleiben ungruppiert; der Knopf
-- in Einstellungen › Planung und Board fasst sie auf Wunsch zusammen.
alter table board_columns add column if not exists group_name text null;
