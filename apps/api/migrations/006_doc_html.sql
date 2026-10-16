-- Doku: HTML als Speicherformat des WYSIWYG-Editors, Markdown bleibt abgeleitet (Suche, Mail-Aktionen)
alter table doc_pages add column content_html text;
alter table doc_pages add column settings jsonb not null default '{}'::jsonb;
alter table doc_page_versions add column content_html text;
alter table doc_templates add column content_html text;
