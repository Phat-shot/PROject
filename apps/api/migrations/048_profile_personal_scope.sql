-- KI-Profile in persönlichen Projekten: „alle Projekte“ gilt dort nur mit „auch in persönlichen Projekten“ oder ausdrücklicher Auswahl (Konzept 19)
alter table ai_profiles add column if not exists personal_scope boolean not null default false;
-- Bestand: persönliche Projekte, die heute ein „alle“-Profil als Projekt-KI nutzen oder in denen ein Agent darauf läuft, behalten es als Auswahl
insert into ai_profile_projects (profile_id, project_id)
  select distinct a.id, p.id from projects p join orgs o on o.id = p.org_id
    join ai_profiles a on a.org_id = p.org_id and a.project_id is null and a.project_scope = 'all'
   where p.personal and (a.id = p.ai_profile_id or exists (
     select 1 from project_members m join users u on u.id = m.user_id
      where m.project_id = p.id and u.kind = 'agent' and coalesce(u.ai_profile_id, nullif(o.settings->'ai'->>'defaultProfileId', '')::uuid) = a.id))
     and not exists (select 1 from ai_profile_projects x where x.profile_id = a.id and x.project_id = p.id);
insert into audit_log (org_id, action, object_type, details)
  select o.id, 'ai.profile.personal_scope.migrated', 'org',
         jsonb_build_object('projects', coalesce((select jsonb_agg(distinct p.id) from ai_profile_projects x join projects p on p.id = x.project_id where p.org_id = o.id and p.personal), '[]'::jsonb))
    from orgs o where exists (select 1 from projects p where p.org_id = o.id and p.personal)
     and not exists (select 1 from audit_log l where l.org_id = o.id and l.action = 'ai.profile.personal_scope.migrated');
