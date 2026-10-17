-- Papierkorb: Arbeitspakete und Doku-Seiten werden zuerst nur markiert; Wiederherstellen möglich, endgültig gelöscht nach 30 Tagen (Worker) oder von Hand
alter table tasks add column deleted_at timestamptz;
alter table tasks add column deleted_was_archived boolean not null default false;
alter table doc_pages add column deleted_at timestamptz;
create index tasks_deleted_idx on tasks(project_id) where deleted_at is not null;
create index doc_pages_deleted_idx on doc_pages(project_id) where deleted_at is not null;
