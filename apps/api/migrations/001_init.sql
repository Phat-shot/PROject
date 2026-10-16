-- Mandant, Benutzer, Sitzungen
create table orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  email text not null unique,
  name text not null,
  password_hash text not null,
  global_role text not null default 'user' check (global_role in ('org_admin','project_creator','user')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table sessions (
  token text primary key,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Projekte und Mitgliedschaft
create table projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  key text not null,
  name text not null,
  description text,
  status text not null default 'active' check (status in ('active','archived')),
  mail_address text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (org_id, key)
);

create table project_members (
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('pl','member','reader')),
  is_deputy boolean not null default false,
  can_edit_plan boolean not null default false,
  can_approve boolean not null default false,
  can_finalize boolean not null default false,
  can_use_ai boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create table project_contacts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  email text not null,
  name text,
  unique (project_id, email)
);

-- Board, Teilprojekte, Aufgaben
create table board_columns (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  position int not null default 0,
  is_done boolean not null default false
);

create table subprojects (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  responsible_user_id uuid references users(id),
  start_date date,
  end_date date,
  position int not null default 0,
  created_at timestamptz not null default now()
);

create table milestones (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  subproject_id uuid references subprojects(id) on delete set null,
  name text not null,
  date date not null
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  subproject_id uuid references subprojects(id) on delete set null,
  column_id uuid not null references board_columns(id),
  title text not null,
  description text,
  priority text not null default 'normal' check (priority in ('low','normal','high','critical')),
  start_date date,
  due_date date,
  responsible_user_id uuid references users(id),
  responsible_email text,
  position int not null default 0,
  mail_code text not null unique,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tasks_project_idx on tasks(project_id);
create index tasks_responsible_idx on tasks(responsible_user_id);

create table checklist_items (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  title text not null,
  done boolean not null default false,
  responsible_user_id uuid references users(id),
  position int not null default 0
);

create table task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid not null references users(id),
  body text not null,
  created_at timestamptz not null default now()
);

create table task_dependencies (
  predecessor_id uuid not null references tasks(id) on delete cascade,
  successor_id uuid not null references tasks(id) on delete cascade,
  primary key (predecessor_id, successor_id)
);

-- Mail
create table mail_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  type text not null check (type in ('personal','project')),
  owner_user_id uuid references users(id),
  project_id uuid references projects(id) on delete cascade,
  name text not null,
  address text not null,
  provider text not null default 'imap' check (provider in ('imap','dev')),
  imap_host text, imap_port int, imap_user text, imap_password text, imap_secure boolean default true,
  smtp_host text, smtp_port int, smtp_user text, smtp_password text, smtp_secure boolean default false,
  sync_cursor jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz,
  sync_error text,
  created_at timestamptz not null default now(),
  check ((type = 'personal' and owner_user_id is not null) or (type = 'project' and project_id is not null))
);

create table mail_views (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references mail_accounts(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  filter jsonb not null default '{}'::jsonb,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table mail_view_rights (
  id uuid primary key default gen_random_uuid(),
  view_id uuid not null references mail_views(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  role text check (role in ('pl','member','reader')),
  can_read boolean not null default true,
  can_draft boolean not null default false,
  can_send boolean not null default false,
  can_ai boolean not null default false,
  can_create_task boolean not null default false,
  check ((user_id is not null) <> (role is not null))
);
create unique index mail_view_rights_user_idx on mail_view_rights(view_id, user_id) where user_id is not null;
create unique index mail_view_rights_role_idx on mail_view_rights(view_id, role) where role is not null;

create table mails (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references mail_accounts(id) on delete cascade,
  folder text not null default 'INBOX',
  uid text,
  message_id text,
  in_reply_to text,
  references_header text,
  from_addr text not null,
  from_name text,
  to_json jsonb not null default '[]'::jsonb,
  cc_json jsonb not null default '[]'::jsonb,
  subject text not null default '',
  date timestamptz not null default now(),
  text_body text,
  html_body text,
  snippet text not null default '',
  has_attachments boolean not null default false,
  outgoing boolean not null default false,
  created_at timestamptz not null default now(),
  unique (account_id, folder, uid)
);
create index mails_account_date_idx on mails(account_id, date desc);

create table mail_view_matches (
  mail_id uuid not null references mails(id) on delete cascade,
  view_id uuid not null references mail_views(id) on delete cascade,
  primary key (mail_id, view_id)
);

create table mail_task_links (
  mail_id uuid not null references mails(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  copied boolean not null default false,
  linked_by uuid references users(id),
  created_at timestamptz not null default now(),
  primary key (mail_id, task_id)
);

create table mail_drafts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references mail_accounts(id) on delete cascade,
  view_id uuid references mail_views(id) on delete set null,
  task_id uuid references tasks(id) on delete set null,
  project_id uuid references projects(id) on delete cascade,
  user_id uuid not null references users(id),
  to_addrs jsonb not null default '[]'::jsonb,
  cc_addrs jsonb not null default '[]'::jsonb,
  subject text not null default '',
  body text not null default '',
  in_reply_to text,
  status text not null default 'draft' check (status in ('draft','pending_approval','sent','failed')),
  error text,
  sent_at timestamptz,
  sent_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Doku
create table doc_folders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  parent_id uuid references doc_folders(id) on delete cascade,
  name text not null,
  position int not null default 0,
  distribution_list jsonb not null default '[]'::jsonb
);

create table doc_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references orgs(id),
  key text not null,
  name text not null,
  content_md text not null,
  unique (org_id, key)
);

create table doc_pages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  folder_id uuid references doc_folders(id) on delete set null,
  parent_page_id uuid references doc_pages(id) on delete set null,
  title text not null,
  content_md text not null default '',
  status text not null default 'draft' check (status in ('draft','review','final')),
  version int not null default 1,
  template_key text,
  created_by uuid references users(id),
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finalized_at timestamptz
);
create index doc_pages_project_idx on doc_pages(project_id);

create table doc_page_versions (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references doc_pages(id) on delete cascade,
  version int not null,
  title text not null,
  content_md text not null,
  status text not null,
  saved_by uuid references users(id),
  saved_at timestamptz not null default now(),
  unique (page_id, version)
);

create table attachments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  task_id uuid references tasks(id) on delete cascade,
  page_id uuid references doc_pages(id) on delete cascade,
  filename text not null,
  mime text not null,
  size int not null,
  storage_path text not null,
  uploaded_by uuid references users(id),
  created_at timestamptz not null default now()
);

-- Audit
create table audit_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  project_id uuid references projects(id) on delete set null,
  user_id uuid references users(id) on delete set null,
  action text not null,
  object_type text not null,
  object_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_project_idx on audit_log(project_id, created_at desc);
