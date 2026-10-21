-- KI-Feedback (Einfachheit, Kontrolle, laufende Verbesserung): jede Rückmeldung zu einem Agenten wird gesichert, ausdrücklich
-- (Daumen mit Kommentar an Chat-Antworten und Läufen) und automatisch (Ablehnungen mit Grund, bearbeitete Vorschläge und Entwürfe,
-- ersetzte Behauptungen, nicht ausgeführte Befehle, Fehler im Lauf). Lesen und exportieren nur die KI-Verwaltung.
create table if not exists ai_feedback (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  agent_user_id uuid references users(id) on delete set null,
  user_id uuid references users(id) on delete set null,
  kind text not null,
  rating smallint,
  comment text,
  source_type text not null,
  source_id text not null,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ai_feedback_org_idx on ai_feedback (org_id, created_at desc);
create index if not exists ai_feedback_source_idx on ai_feedback (source_type, source_id);
