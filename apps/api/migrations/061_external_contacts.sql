-- Eine Kontaktliste je Projekt (Konzept Einstellungen 5): die Ansprechpartner für Externe aus dem externen Profil werden
-- Projektkontakte mit Kennzeichen external; das Profil behält Name, Adresse und Zufahrt.
alter table project_contacts add column if not exists external boolean not null default false;
insert into project_contacts (project_id, email, name, role, external)
select p.id, lower(trim(c->>'email')), nullif(trim(c->>'name'), ''), nullif(trim(c->>'role'), ''), true
from projects p, jsonb_array_elements(case when jsonb_typeof(p.external_profile->'contacts') = 'array' then p.external_profile->'contacts' else '[]'::jsonb end) c
where coalesce(trim(c->>'email'), '') <> ''
on conflict (project_id, email) do update set external = true, name = coalesce(project_contacts.name, excluded.name), role = coalesce(project_contacts.role, excluded.role);
update projects set external_profile = external_profile - 'contacts' where external_profile ? 'contacts';
