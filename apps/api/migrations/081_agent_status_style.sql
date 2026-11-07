-- Antwortstil eines Agenten auf Statusfragen: technical, compact, text, management; null = Standard nach Rolle
-- (text beim persönlichen Assistenten, technical beim Projektagenten).
alter table users add column if not exists status_style text check (status_style is null or status_style in ('technical', 'compact', 'text', 'management'));
