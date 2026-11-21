-- Eskalation verfeinert:
-- 1. tasks.started_at: tatsächlicher Arbeitsbeginn. Stillstand („hängt“) zählt erst ab hier, nicht schon in der Anlage-Spalte („Offen“).
--    Gesetzt per Trigger beim ersten Spaltenwechsel in eine Spalte, die nicht Geplant/Zurückgestellt ist (alle Wege: Verschieben,
--    PATCH columnId, Prüfung, Wartet, Automatik, Import, Kopieren).
-- 2. tasks.escalation_reminded_at: einmalige Erinnerung statt Eskalation, wenn die verbleibende Kette nur die zuständige Person ist.
-- 3. Persönliche Projekte: Eskalation aus (die PL kann sie in den Einstellungen wieder einschalten).
alter table tasks add column if not exists started_at timestamptz;
alter table tasks add column if not exists escalation_reminded_at timestamptz;

-- Backfill: begonnen (= created_at), außer die Aufgabe liegt noch in ihrer (vermuteten) Anlage-Spalte – Geplant, Zurückgestellt oder die
-- erste aktive Spalte („Offen“) – und hat außer dem Anlegen keine Aktivität: kein Spaltenwechsel im Audit, kein Log-Eintrag (außer
-- automatischen Eskalationsmeldungen), kein erledigter Checklistenpunkt, keine erledigte Aufgabe darunter.
update tasks t set started_at = t.created_at
 where t.started_at is null
   and not (
     exists (select 1 from board_columns c where c.id = t.column_id and (c.kind in ('backlog', 'parked')
       or c.id = (select f.id from board_columns f where f.project_id = t.project_id and f.kind = 'active' order by f.position limit 1)))
     and not exists (select 1 from audit_log a where a.object_type = 'task' and a.object_id = t.id::text and (a.action = 'task.move' or (a.action = 'task.update' and a.details ? 'columnId')))
     and not exists (select 1 from task_comments x where x.task_id = t.id and not (x.source = 'system' and x.body like 'Eskalation%'))
     and not exists (select 1 from checklist_items i where i.task_id = t.id and i.done)
     and not exists (select 1 from tasks k join board_columns kc on kc.id = k.column_id where k.parent_id = t.id and kc.is_done)
   );

create or replace function tasks_mark_started() returns trigger language plpgsql as $$
begin
  if new.started_at is null and new.column_id is distinct from old.column_id
     and exists (select 1 from board_columns c where c.id = new.column_id and c.kind not in ('backlog', 'parked')) then
    new.started_at := now();
  end if;
  return new;
end
$$;
drop trigger if exists tasks_mark_started on tasks;
create trigger tasks_mark_started before update of column_id on tasks for each row execute function tasks_mark_started();

update projects set escalation = coalesce(escalation, '{}'::jsonb) || '{"enabled": false}'::jsonb where personal;
