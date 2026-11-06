-- Dateiquellen (Nextcloud-Freigabelink oder WebDAV-Konto), nur lesend: Index je Quelle einmal, Zuordnung zu beliebig vielen Projekten
create table if not exists file_sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  -- nextcloud_share: https://host/s/<token> (WebDAV /public.php/webdav, Basic <token>:<Passwort>); webdav: Konto mit Benutzer + App-Passwort
  kind text not null check (kind in ('nextcloud_share', 'webdav')),
  -- eingegebene Adresse (Freigabelink bzw. WebDAV-Adresse) und daraus abgeleitete WebDAV-Wurzel
  base_url text not null,
  dav_url text not null,
  share_token text,
  username text,
  -- Freigabe-Passwort bzw. App-Passwort, verschlüsselt (seal, enc2)
  secret text,
  -- Ordner innerhalb der WebDAV-Wurzel, ab dem indiziert wird ('/' = alles)
  root_path text not null default '/',
  -- org: Org-Admin legt an und gibt frei, die PL bindet ein; project: PL legt an, nur für ihr Projekt
  scope text not null check (scope in ('project', 'org')),
  owner_project_id uuid references projects(id) on delete cascade,
  -- Freigabe einer Org-Quelle für Projekte (wie LLM-Profile): alle, ausgewählte (file_source_release_projects) oder keine
  project_scope text not null default 'all' check (project_scope in ('all', 'selected', 'none')),
  -- Freigabe für persönliche Projekte: none (Standard), all, users (file_source_personal_users)
  personal_use text not null default 'none' check (personal_use in ('none', 'all', 'users')),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_sync_at timestamptz,
  last_error text,
  last_stats jsonb,
  active boolean not null default true,
  check ((scope = 'project' and owner_project_id is not null) or (scope = 'org' and owner_project_id is null))
);
create index if not exists file_sources_org_idx on file_sources(org_id);

create table if not exists file_source_release_projects (
  source_id uuid not null references file_sources(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  primary key (source_id, project_id)
);
create table if not exists file_source_personal_users (
  source_id uuid not null references file_sources(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  primary key (source_id, user_id)
);

-- Einbindung ins Projekt: Unterordner (relativ zu root_path, null = ganze Quelle) und Anzeigename in der Doku
create table if not exists file_source_projects (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references file_sources(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  sub_path text,
  folder_label text not null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists file_source_projects_uniq on file_source_projects(source_id, project_id, coalesce(sub_path, ''));
create index if not exists file_source_projects_project_idx on file_source_projects(project_id);

-- Index je Quelle: Pfad relativ zu root_path ('/Ordner/Datei.pdf'), Textauszug (gekürzt auf 200 kB), gelöschte Dateien mit deleted_at
create table if not exists files (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references file_sources(id) on delete cascade,
  path text not null,
  name text not null,
  mime text,
  size bigint,
  etag text,
  modified_at timestamptz,
  text_content text,
  text_status text check (text_status in ('ok', 'skipped', 'error')),
  text_note text,
  indexed_at timestamptz,
  -- neu oder geändert (Ereignis für Projektläufe: „Neue Dateien seit letztem Lauf“)
  changed_at timestamptz,
  deleted_at timestamptz,
  unique (source_id, path)
);
create index if not exists files_changed_idx on files(source_id, changed_at);
