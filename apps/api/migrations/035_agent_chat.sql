-- KI-Agenten im Chat: Läufe aus Direktnachrichten haben kein Projekt, sondern einen Kanal
alter table agent_runs alter column project_id drop not null;
alter table agent_runs add column channel_id uuid references chat_channels(id) on delete set null;
