-- Meilensteine: Status „erreicht“ (wann, wer), Vorschlag an die PL, wenn alle verknüpften Arbeitspakete erledigt sind,
-- Bezug zu Arbeitspaketen (n:m). Projekteinstellung: Meilenstein automatisch erreichen statt nur vorschlagen.
alter table milestones add column if not exists reached_at timestamptz;
alter table milestones add column if not exists reached_by uuid references users(id) on delete set null;
alter table milestones add column if not exists reach_suggested_at timestamptz;
create table if not exists milestone_tasks (
  milestone_id uuid not null references milestones(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  primary key (milestone_id, task_id)
);
create index if not exists milestone_tasks_task_idx on milestone_tasks(task_id);
alter table projects add column if not exists milestone_auto_reach boolean not null default false;

-- Benannte prüfende Person: Spaltenart „In Prüfung“ (review), Prüfer am Arbeitspaket und an der Doku-Seite,
-- Rückkehrspalte bei „zurückweisen“. Projekteinstellung: Prüfer beim Wechsel in „In Prüfung“ Pflicht.
alter table board_columns drop constraint if exists board_columns_kind_check;
alter table board_columns add constraint board_columns_kind_check check (kind in ('backlog','active','review','waiting','parked','done'));
update board_columns set kind = 'review' where kind = 'active' and lower(trim(name)) in ('in prüfung', 'prüfung', 'review', 'in review');
alter table tasks add column if not exists reviewer_user_id uuid references users(id) on delete set null;
alter table tasks add column if not exists review_return_column_id uuid references board_columns(id) on delete set null;
alter table doc_pages add column if not exists reviewer_user_id uuid references users(id) on delete set null;
alter table projects add column if not exists review_required boolean not null default false;
