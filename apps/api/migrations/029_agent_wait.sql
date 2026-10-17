-- Agent-Wartezustände: Wiedervorlage, Nachfassen und Eskalation nach Frist
alter table tasks add column agent_next_check_at timestamptz;
alter table tasks add column agent_wait jsonb;
create index tasks_agent_check_idx on tasks(agent_next_check_at) where agent_next_check_at is not null;
