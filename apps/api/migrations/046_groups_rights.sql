-- Gruppen als Projektmitglied (Regel M), Herkunft der Mitgliedschaft, Gruppenverwalter
alter table group_members add column is_manager boolean not null default false;
create table project_groups (
  project_id uuid not null references projects(id) on delete cascade,
  group_id uuid not null references groups(id) on delete cascade,
  role text not null check (role in ('member','reader')),               -- PL und Stellvertretung sind immer einzelne Personen
  can_edit_plan boolean not null default false,
  can_approve boolean not null default false,
  can_finalize boolean not null default false,
  can_use_ai boolean not null default false,
  added_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (project_id, group_id)
);
create index project_groups_group_idx on project_groups(group_id);
-- Bestand: alle bisherigen Mitgliedschaften sind Direkteinträge; Gruppenzeilen pflegt nur syncProjectGroups()
alter table project_members add column origin text not null default 'direct' check (origin in ('direct','group'));
