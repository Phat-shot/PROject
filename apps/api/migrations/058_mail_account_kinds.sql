-- Postfach-Arten: Org-Postfach nur für Systemmails (keine Projekt- oder persönlichen Bindungen), zentrale Postfächer der Organisation
-- für mehrere Projekte (offered_to_all = jede PL darf es in ihr Projekt holen), Projektpostfächer der PL, persönliche Konten
alter table mail_accounts add column if not exists offered_to_all boolean not null default false;
-- Bestand: Projekt- und persönliche Bindungen des Org-Postfachs lösen (Ansichten darüber fallen per Cascade)
delete from mail_account_uses where use <> 'org' and account_id in (select account_id from mail_account_uses where use = 'org');
-- Fehlender Standard: die älteste eigene Bindung (Verwalter = Projekt oder eine Person) rückt nach
update mail_account_uses u set is_default = true
  from (select distinct on (x.project_id) x.id from mail_account_uses x join mail_accounts a on a.id = x.account_id
        where x.use = 'project' and (a.managed_project_id = x.project_id or a.managed_user_id is not null)
          and not exists (select 1 from mail_account_uses d where d.project_id = x.project_id and d.use = 'project' and d.is_default)
        order by x.project_id, x.created_at) n
  where u.id = n.id;
update projects p set mail_address = (select a.address from mail_account_uses u join mail_accounts a on a.id = u.account_id where u.project_id = p.id and u.use = 'project' and u.is_default);
