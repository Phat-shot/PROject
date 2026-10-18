-- Persönliche Projekte sehen nur eigene Postfächer (persönliche Konten des Eigentümers, Projektkonto des Projekts):
-- fremde Ansichten (Organisationspostfach) und Verknüpfungen fremder Mails mit Arbeitspaketen und Seiten entfernen
delete from mail_views v using mail_accounts a, projects p
 where a.id = v.account_id and p.id = v.project_id and p.personal
   and not ((a.type = 'personal' and a.owner_user_id = p.created_by) or (a.type = 'project' and a.project_id = p.id));
delete from mail_task_links l using tasks t, projects p, mails m, mail_accounts a
 where t.id = l.task_id and p.id = t.project_id and p.personal and m.id = l.mail_id and a.id = m.account_id
   and not ((a.type = 'personal' and a.owner_user_id = p.created_by) or (a.type = 'project' and a.project_id = p.id));
delete from mail_page_links l using doc_pages d, projects p, mails m, mail_accounts a
 where d.id = l.page_id and p.id = d.project_id and p.personal and m.id = l.mail_id and a.id = m.account_id
   and not ((a.type = 'personal' and a.owner_user_id = p.created_by) or (a.type = 'project' and a.project_id = p.id));
