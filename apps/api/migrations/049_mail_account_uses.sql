-- Mail-Konten mit Verwalter und Bindungen (Konzept 17): ein Konto hat einen Verwalter (Person, Projekt oder Org-Admin)
-- und Bindungen, die sagen, wofür es dient (org | project mit Standard je Projekt | personal). type/owner_user_id/project_id
-- bleiben eine Version lang als Spiegel des Verwalters, werden aber nicht mehr als Bindung ausgewertet.
create table mail_account_uses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  account_id uuid not null references mail_accounts(id) on delete cascade,
  use text not null check (use in ('org','project','personal')),
  project_id uuid references projects(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  is_default boolean not null default false,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  check ((use = 'org' and project_id is null and user_id is null) or (use = 'project' and project_id is not null and user_id is null) or (use = 'personal' and user_id is not null and project_id is null))
);
create unique index mail_account_uses_uq on mail_account_uses (account_id, use, project_id, user_id) nulls not distinct;
create unique index mail_account_uses_org_uq on mail_account_uses (org_id) where use = 'org';
create unique index mail_account_uses_default_uq on mail_account_uses (project_id) where use = 'project' and is_default;
alter table mail_accounts add column managed_user_id uuid references users(id) on delete set null;
alter table mail_accounts add column managed_project_id uuid references projects(id) on delete set null;
alter table mail_accounts add constraint mail_accounts_manager_check check (managed_user_id is null or managed_project_id is null);
alter table mail_accounts drop constraint if exists mail_accounts_check;
alter table mail_accounts drop constraint if exists mail_accounts_project_id_fkey;
alter table mail_accounts add constraint mail_accounts_project_id_fkey foreign key (project_id) references projects(id) on delete set null;
alter table mail_views add column use_id uuid references mail_account_uses(id) on delete cascade;
-- Bestand: Verwalter aus dem Typ, eine Bindung je Konto, erstes Projektkonto je Projekt als Standard, Ansichten an die Bindung
update mail_accounts set managed_user_id = case when type = 'personal' then owner_user_id end, managed_project_id = case when type = 'project' then project_id end where managed_user_id is null and managed_project_id is null;
insert into mail_account_uses (org_id, account_id, use, project_id, user_id, is_default)
  select org_id, id, type, case when type = 'project' then project_id end, case when type = 'personal' then owner_user_id end,
         type = 'project' and id = (select x.id from mail_accounts x where x.project_id = mail_accounts.project_id and x.type = 'project' order by x.created_at, x.id limit 1)
  from mail_accounts where not exists (select 1 from mail_account_uses u where u.account_id = mail_accounts.id)
    and not (type = 'project' and exists (select 1 from mail_account_uses u where u.project_id = mail_accounts.project_id and u.use = 'project' and u.is_default) and id = (select x.id from mail_accounts x where x.project_id = mail_accounts.project_id and x.type = 'project' order by x.created_at, x.id limit 1));
update mail_views v set use_id = u.id from mail_account_uses u where u.account_id = v.account_id;
alter table mail_views alter column use_id set not null;
-- Standardkonto als Cache der Projekt-Mailadresse (wie bisher das älteste Projektkonto)
update projects p set mail_address = a.address from mail_account_uses u join mail_accounts a on a.id = u.account_id where u.project_id = p.id and u.use = 'project' and u.is_default;
