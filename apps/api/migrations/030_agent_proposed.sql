-- Rohantwort des Modells je Agentenlauf (zur Nachvollziehbarkeit verworfener Aktionen)
alter table agent_runs add column proposed jsonb;
