-- Ordner sind selbst eine Seite: beschreibbar, mit Status, Versionen und PDF; wird beim ersten Öffnen angelegt
alter table doc_folders add column page_id uuid references doc_pages(id) on delete set null;
