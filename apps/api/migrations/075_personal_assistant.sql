-- Persönlicher Assistent („Jarvis“) je Benutzer
-- Freigabe je Person: null = Mandantenschalter „Persönliche Projekte“ gilt, true = darf (auch ohne Schalter), false = gesperrt (KI im persönlichen Projekt aus)
alter table users add column if not exists personal_project_allowed boolean null;
-- Agentenrolle: project = Projektagent (einladbar), assistant = Assistent einer Person (nur im persönlichen Projekt, nur Direktnachrichten)
alter table users add column if not exists agent_role text not null default 'project' check (agent_role in ('project', 'assistant'));
-- Einladung ohne Projekt: persönliches Projekt bei Annahme anlegen (Opt-out-Haken, Standard an)
alter table invitations add column if not exists personal_project boolean not null default false;
-- Freigabe eines Mandanten-LLM für persönliche Projekte: none (Standard), all, users (nur ai_profile_personal_users); ersetzt personal_scope (true → all)
alter table ai_profiles add column if not exists personal_use text not null default 'none' check (personal_use in ('none', 'all', 'users'));
update ai_profiles set personal_use = 'all' where personal_scope;
alter table ai_profiles drop column if exists personal_scope;
create table if not exists ai_profile_personal_users (
  profile_id uuid not null references ai_profiles(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  primary key (profile_id, user_id)
);
-- Schlanke Oberfläche des persönlichen Projekts: Reiter Plan, Risiken, Zeiten, Auswertung ausgeblendet, bis die Person alle Reiter einschaltet
alter table projects add column if not exists show_all_tabs boolean not null default false;
