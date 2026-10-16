-- Mail ↔ Doku: Mail als Seite abgelegt oder an eine Seite angehängt
create table mail_page_links (
  mail_id uuid not null references mails(id) on delete cascade,
  page_id uuid not null references doc_pages(id) on delete cascade,
  kind text not null check (kind in ('page','section')),
  linked_by uuid references users(id),
  created_at timestamptz not null default now(),
  primary key (mail_id, page_id)
);

-- Aufgaben-Log: Kommentare bekommen eine Herkunft (manuell, Mail, System)
alter table task_comments add column source text not null default 'user' check (source in ('user','mail','system'));
alter table task_comments add column mail_id uuid references mails(id) on delete set null;
