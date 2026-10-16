-- Mails einem Task (Checklistenpunkt) zuordnen: Nachfrage und Antwort erscheinen unter dem Task
alter table mail_task_links add column checklist_item_id uuid references checklist_items(id) on delete set null;
alter table mail_drafts add column checklist_item_id uuid references checklist_items(id) on delete set null;
