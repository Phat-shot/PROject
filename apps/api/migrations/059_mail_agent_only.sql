-- Mail-Bearbeitung nur noch durch Agenten: die „Projekt-KI“ im Auftrag einer Person entfällt.
-- Ordner-Ansichten ohne Agent bekommen den Projektagenten; die Freigabe mail.process gibt es nicht mehr.
update mail_views v set agent_user_id = p.agent_user_id from projects p
  where p.id = v.project_id and v.ai_process and v.agent_user_id is null and p.agent_user_id is not null;
delete from ai_policies where feature = 'mail.process';
alter table mail_views drop column if exists ai_process_by;
