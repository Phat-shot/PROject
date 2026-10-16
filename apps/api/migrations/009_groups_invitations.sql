-- Org-Postfach für Systemmails (Einladungen), Einladungen, Berechtigungsgruppen, eingeschränkte Teilprojekte
alter table mail_accounts drop constraint mail_accounts_type_check;
alter table mail_accounts add constraint mail_accounts_type_check check (type in ('personal','project','org'));
alter table mail_accounts drop constraint mail_accounts_check;
alter table mail_accounts add constraint mail_accounts_check check ((type = 'personal' and owner_user_id is not null) or (type = 'project' and project_id is not null) or (type = 'org'));

create table invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  email text not null,
  name text not null,
  global_role text not null default 'user' check (global_role in ('org_admin','project_creator','user')),
  token text not null unique,
  invited_by uuid references users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  sent_at timestamptz,
  send_error text,
  accepted_at timestamptz,
  user_id uuid references users(id)
);
create index invitations_org_idx on invitations(org_id);

create table groups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  unique (org_id, name)
);
create table group_members (
  group_id uuid not null references groups(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  primary key (group_id, user_id)
);

alter table subprojects add column restricted boolean not null default false;
create table subproject_access (
  id uuid primary key default gen_random_uuid(),
  subproject_id uuid not null references subprojects(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  group_id uuid references groups(id) on delete cascade,
  check ((user_id is not null) <> (group_id is not null))
);
create index subproject_access_sp_idx on subproject_access(subproject_id);

alter table mail_view_rights drop constraint mail_view_rights_check;
alter table mail_view_rights add column group_id uuid references groups(id) on delete cascade;
alter table mail_view_rights add constraint mail_view_rights_check check (((user_id is not null)::int + (role is not null)::int + (group_id is not null)::int) = 1);
