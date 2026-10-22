-- Zweiter Faktor: Fehlversuche je Anmelde-Challenge begrenzen, benutzten Zeitschritt merken (kein Wiederverwenden eines Codes)
alter table login_challenges add column if not exists attempts int not null default 0;
alter table users add column if not exists totp_last_step bigint;
