-- Spalte „Wartet“: Arbeitspakete, die auf eine Rückmeldung mit Frist warten (Agent oder Person). Antwort → zurück in die
-- vorherige Spalte; Frist ohne Lösung → „Zurückgestellt“ mit Meldung. Teilprojekte bekommen eine Beschreibung.
alter table board_columns drop constraint if exists board_columns_kind_check;
alter table board_columns add constraint board_columns_kind_check check (kind in ('backlog','active','waiting','parked','done'));
-- je Projekt ohne Wartet-Spalte: vor „Zurückgestellt“ (sonst vor „Erledigt“) einschieben
create temporary table wait_slot as
  select p.id as project_id, coalesce((select min(position) from board_columns c where c.project_id = p.id and c.kind = 'parked'), (select min(position) from board_columns c where c.project_id = p.id and c.kind = 'done'), 0) as pos
  from projects p where not exists (select 1 from board_columns c where c.project_id = p.id and c.kind = 'waiting');
update board_columns c set position = c.position + 1 from wait_slot s where c.project_id = s.project_id and c.position >= s.pos;
insert into board_columns (project_id, name, position, is_done, kind) select project_id, 'Wartet', pos, false, 'waiting' from wait_slot;
drop table wait_slot;

alter table tasks add column if not exists wait_reason text;
alter table tasks add column if not exists wait_until timestamptz;
alter table tasks add column if not exists wait_by uuid references users(id) on delete set null;
alter table tasks add column if not exists wait_return_column_id uuid references board_columns(id) on delete set null;
alter table tasks add column if not exists wait_expired_at timestamptz;

alter table subprojects add column if not exists description text;
