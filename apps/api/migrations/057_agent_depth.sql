-- Denktiefe (Konzept KI-Agent 3): Kosten je Lauf (gründlich = 2), das Tagesbudget summiert cost statt Zeilen
alter table agent_runs add column if not exists cost int not null default 1;
