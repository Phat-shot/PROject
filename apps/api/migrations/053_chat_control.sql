-- Aufträge per Chat (Konzept 7): Auftraggeber und Ursprungsnachricht am Arbeitspaket; Systemkarten mit Bezug zum Lauf
alter table tasks add column if not exists requested_by uuid references users(id) on delete set null;
alter table tasks add column if not exists origin_message_id uuid references chat_messages(id) on delete set null;
alter table chat_messages add column if not exists agent_run_id uuid references agent_runs(id) on delete set null;
create index if not exists tasks_requested_by_idx on tasks(requested_by) where requested_by is not null;
