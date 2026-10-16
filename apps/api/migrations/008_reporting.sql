-- Reporting: Vorlage im Rhythmus an einen Empfängerkreis (Regelwerk im Worker, keine KI)
alter table projects add column reporting jsonb not null default '{}'::jsonb;
