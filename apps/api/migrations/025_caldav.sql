-- Kalender-Schreibzugriff: CalDAV-Zugang je Benutzer (Passwort verschlüsselt); M365/Google laufen über die persönlichen OAuth-Konten
alter table users add column caldav_url text;
alter table users add column caldav_user text;
alter table users add column caldav_password text;
