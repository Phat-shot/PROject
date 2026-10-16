-- Spaltenarten (Geplant/aktiv/Zurückgestellt/Erledigt), Benutzereinstellungen, externe Task-Zuständigkeit
alter table board_columns add column kind text not null default 'active' check (kind in ('backlog','active','parked','done'));
update board_columns set kind = 'done' where is_done;
insert into board_columns (project_id, name, position, is_done, kind)
  select p.id, 'Geplant', -1, false, 'backlog' from projects p
  where not exists (select 1 from board_columns c where c.project_id = p.id and (c.kind = 'backlog' or lower(c.name) = 'geplant'));
insert into board_columns (project_id, name, position, is_done, kind)
  select p.id, 'Zurückgestellt', 998, false, 'parked' from projects p
  where not exists (select 1 from board_columns c where c.project_id = p.id and (c.kind = 'parked' or lower(c.name) = 'zurückgestellt'));
update board_columns set kind = 'backlog' where lower(name) = 'geplant' and kind = 'active';
update board_columns set kind = 'parked' where lower(name) = 'zurückgestellt' and kind = 'active';
update board_columns set position = case kind when 'backlog' then 0 when 'parked' then 998 when 'done' then 1000 + position else position + 1 end;

alter table users add column settings jsonb not null default '{}'::jsonb;
alter table checklist_items add column responsible_email text;
