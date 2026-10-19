-- Benachrichtigungsregeln mit Vererbung Org › Projekt › AP › Benutzer (Regel N); Bezug und Erledigt-Status von Meldungen; Systemnachrichten im Chat
create table notification_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  task_id uuid references tasks(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  event text not null,                          -- Ereignisklasse oder '*'
  recipients jsonb,                             -- null = erben; geordnete Rollenliste (nur Org/Projekt/AP)
  channels jsonb not null default '{}'::jsonb,  -- nur gesetzte Schlüssel zählen: chat, mail, log, doc
  timing jsonb not null default '{}'::jsonb,    -- remindH, escalateH, expireH, every
  locked text[] not null default '{}',          -- nur Org/Projekt
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (task_id is null or project_id is not null)
);
create unique index notification_rules_uq on notification_rules (org_id, project_id, task_id, user_id, event) nulls not distinct;
alter table notifications add column event text;
alter table notifications add column ref_type text check (ref_type in ('question','chat_channel','chat_thread','task','page','booking'));
alter table notifications add column ref_id uuid;
alter table notifications add column resolved_at timestamptz;
alter table notifications add column mail text not null default 'digest' check (mail in ('off','now','digest'));
-- Lieferung: PDF der Seite (ref_type page) an die Mail hängen, nur an interne Empfänger mit Leserecht
alter table notifications add column attach boolean not null default false;
create index notifications_ref_idx on notifications (ref_type, ref_id) where ref_id is not null;
create index notifications_open_idx on notifications (user_id, resolved_at) where resolved_at is null;
-- Systemnachrichten (nur aus Services, ohne Agentenlauf und Meldung); ohne Auslöser ohne Autor
alter table chat_messages add column kind text not null default 'user' check (kind in ('user','system'));
alter table chat_messages add column meta jsonb;  -- Systemkarte: Ergebnisse, Links, Knöpfe
alter table chat_messages alter column user_id drop not null;
alter table chat_messages add constraint chat_messages_author_check check (kind = 'system' or user_id is not null);
-- Backfill: bisheriger Mail-Modus als Benutzerregel und in offenen Meldungen
insert into notification_rules (org_id, user_id, event, channels)
  select org_id, id, '*', jsonb_build_object('mail', case settings->>'mailNotifications' when 'immediate' then 'now' when 'off' then 'off' else 'digest' end)
  from users where kind = 'person' and settings ? 'mailNotifications';
update notifications n set mail = case u.settings->>'mailNotifications' when 'immediate' then 'now' when 'off' then 'off' else 'digest' end
  from users u where u.id = n.user_id;
update notifications set event = case
  when type in ('task.assigned','plan.shifted') then 'assigned'
  when type = 'escalation' and title like 'Blockiert%' then 'blocked'
  when type = 'escalation' and title like '%braucht eine Entscheidung%' then 'decision'
  when type = 'escalation' then 'escalation'
  when type in ('mail.approval','draft.review','page.review','report.review','ai.proposal','workflow.approval','outbound.review') then 'review'
  when type in ('mention','task.comment') then 'log'
  when type in ('task.due_soon','task.overdue') then 'due'
  when type in ('chat.dm','chat.mention','chat.reply') then 'chat'
  when type = 'external.referral' then 'external_referral'
  else 'info' end;
-- Bezug bestehender Meldungen aus dem Link (Chat-Kanal, Thread, Arbeitspaket, Seite)
update notifications set ref_type = 'chat_thread', ref_id = substring(link from 'thread=([0-9a-f-]{36})')::uuid where event = 'chat' and link ~ 'thread=[0-9a-f-]{36}';
update notifications set ref_type = 'chat_channel', ref_id = substring(link from '^/chat/([0-9a-f-]{36})')::uuid where event = 'chat' and ref_type is null and link ~ '^/chat/[0-9a-f-]{36}';
update notifications set ref_type = 'task', ref_id = substring(link from 'task=([0-9a-f-]{36})')::uuid where ref_type is null and link ~ 'task=[0-9a-f-]{36}';
update notifications set ref_type = 'page', ref_id = substring(link from '/doku/([0-9a-f-]{36})')::uuid where ref_type is null and link ~ '/doku/[0-9a-f-]{36}';
