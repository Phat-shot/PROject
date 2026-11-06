-- Ein Schalter für Doku-Ordner und KI-Agenten: doc_folders.agent_access (write/read/none) ist die einzige Quelle der Wahrheit.
-- Der Schalter aus „Quellen für den Agenten“ (agent_enabled, Migration 079) hatte dieselbe Wirkung wie „kein Zugriff“: übernehmen, dann entfernen.
do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'doc_folders' and column_name = 'agent_enabled') then
    update doc_folders set agent_access = 'none' where agent_enabled = false;
    alter table doc_folders drop column agent_enabled;
  end if;
end $$;
