-- Eskalation: Regelwerk je Projekt, Zustand je Aufgabe
alter table projects add column escalation jsonb not null default '{}'::jsonb;
alter table tasks add column blocked boolean not null default false;
alter table tasks add column blocked_reason text;
alter table tasks add column blocked_at timestamptz;
alter table tasks add column escalation_level int not null default 0;
alter table tasks add column escalated_at timestamptz;
alter table tasks add column last_activity_at timestamptz not null default now();

-- Mandanten-Einstellungen (PDF-Stil u. a.)
alter table orgs add column settings jsonb not null default '{}'::jsonb;
