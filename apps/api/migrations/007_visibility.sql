-- Projekt-Sichtbarkeit: members (nur Mitglieder) oder org (alle Benutzer des Mandanten lesend)
alter table projects add column visibility text not null default 'members';
