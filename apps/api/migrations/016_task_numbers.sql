-- Lesbare Kennung je Arbeitspaket: Projektkürzel-Nummer (WEB-12), fortlaufend je Projekt, vergeben per Trigger beim Anlegen
alter table tasks add column number int;
update tasks t set number = s.rn from (select id, row_number() over (partition by project_id order by created_at, id) as rn from tasks) s where s.id = t.id;
alter table tasks alter column number set not null;
create unique index tasks_project_number_idx on tasks(project_id, number);
create or replace function tasks_assign_number() returns trigger language plpgsql as $$
begin
  if new.number is null then
    select coalesce(max(number), 0) + 1 into new.number from tasks where project_id = new.project_id;
  end if;
  return new;
end
$$;
create trigger tasks_assign_number before insert on tasks for each row execute function tasks_assign_number();
