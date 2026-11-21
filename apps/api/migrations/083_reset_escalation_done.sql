-- Erledigte, archivierte oder gelöschte Elemente behalten keine Eskalationsstufe (Altbestand vor dem Rücksetzen bei Erledigung)
update tasks t set escalation_level = 0, escalated_at = null, escalation_reminded_at = null
  from board_columns c
 where c.id = t.column_id
   and (t.escalation_level > 0 or t.escalation_reminded_at is not null)
   and (c.is_done or t.archived_at is not null or t.deleted_at is not null);
