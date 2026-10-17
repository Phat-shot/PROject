-- Workflows als eigener Bereich: Vorlagen gelten mandantenweit (project_id null); isolierte Läufe bekommen ein eigenes Mini-Projekt (projects.kind = 'workflow')
alter table workflow_defs alter column project_id drop not null;
alter table projects add column kind text not null default 'project' check (kind in ('project','workflow'));
create index projects_kind_idx on projects(org_id, kind);
