-- Persönliches Projekt: nur der Ersteller (PL) und KI-Agenten; Sichtbarkeit nur Mitglieder, Org-Admin ohne Inhaltsdetails
alter table projects add column personal boolean not null default false;
-- Agent, den eine PL für ihr Projekt angelegt hat: nur in diesem Projekt einsetzbar, eigenes Tagesbudget (höchstens Mandantenwert)
alter table users add column agent_project_id uuid references projects(id) on delete set null;
alter table users add column agent_daily_budget int check (agent_daily_budget is null or agent_daily_budget >= 0);
alter table users add column agent_created_by uuid references users(id) on delete set null;
