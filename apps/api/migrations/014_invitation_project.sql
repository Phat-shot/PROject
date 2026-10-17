-- Einladung durch einen PL direkt in ein Projekt: Annahme macht die Person zum Mitglied mit dieser Rolle
alter table invitations add column project_id uuid references projects(id) on delete set null;
alter table invitations add column project_role text check (project_role in ('member','reader'));
