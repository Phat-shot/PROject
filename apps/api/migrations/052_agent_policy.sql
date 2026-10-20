-- Agenten-Policy (Konzept 6): Selbstständigkeit und Bestätigungen je Org → Projekt → Agent im Projekt → Arbeitspaket,
-- angehaltene Aktionen als Vorschläge an einer Frage approval, Agentenzugriff auf Doku-Ordner.
alter table projects add column if not exists agent_policy jsonb not null default '{}'::jsonb;
alter table project_members add column if not exists agent_policy jsonb;   -- nur Agenten; null = erben
alter table tasks add column if not exists agent_policy jsonb;             -- gilt für das AP und seine Aufgaben
alter table ai_proposals drop constraint if exists ai_proposals_kind_check;
alter table ai_proposals add constraint ai_proposals_kind_check check (kind in ('task_update','page_append','agent_action'));
alter table ai_proposals drop constraint if exists ai_proposals_status_check;
alter table ai_proposals add constraint ai_proposals_status_check
  check (status in ('pending','approved','rejected','stale','failed','expired','withdrawn'));
alter table ai_proposals add column if not exists agent_run_id uuid references agent_runs(id) on delete set null;
alter table ai_proposals add column if not exists question_id uuid references questions(id) on delete set null;
alter table ai_proposals add column if not exists action_class text;
alter table ai_proposals add column if not exists seq smallint not null default 0;
alter table ai_proposals add column if not exists depends_on uuid references ai_proposals(id) on delete set null;
alter table ai_proposals add column if not exists mail_draft_id uuid references mail_drafts(id) on delete set null;
alter table ai_proposals add column if not exists fingerprint text;
alter table ai_proposals add column if not exists result text;
create index if not exists ai_proposals_question_idx on ai_proposals(question_id);
create index if not exists ai_proposals_task_pending_idx on ai_proposals(task_id) where status = 'pending';
create index if not exists ai_proposals_rejected_fp_idx on ai_proposals(project_id, fingerprint) where status = 'rejected';
alter table doc_folders add column if not exists agent_access text not null default 'write' check (agent_access in ('write','read','none'));
-- Bestand nach Entscheidung 6: bestehende Projekte behalten das heutige Verhalten (selbstständig); neue Projekte starten mit Rückfrage bei wichtigen Schritten
update projects set agent_policy = '{"mode":"auto"}'::jsonb where agent_policy = '{}'::jsonb;
