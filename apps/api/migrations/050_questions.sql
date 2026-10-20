-- Offene Fragen (Konzept 5): ein Objekt für Chat-Stelle, Meldungen, Log, Warten und Antwort.
-- Dazu der Projektagent (dritte PL-Rolle) mit Mail-Bearbeitung und die Mail-Rückfrage je Projekt.
create table questions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  task_id uuid references tasks(id) on delete cascade,
  meeting_id uuid references meetings(id) on delete set null,
  kind text not null default 'question'
    check (kind in ('question','decision','confirm','approval','synergy','order_request','external_referral')),
  asked_by uuid not null references users(id),                    -- Agent oder Person
  addressee_id uuid references users(id) on delete set null,      -- null = Projektkanal
  addressee_role text,                                            -- Rolle aus der Kette
  level smallint not null default 0,
  parent_id uuid references questions(id) on delete set null,     -- Vorgänger bei Weitergabe
  body text not null,
  options jsonb,                                                  -- Entscheidung mit Auswahl: [{key, label}]
  channel_id uuid references chat_channels(id) on delete set null,
  message_id uuid references chat_messages(id) on delete set null, -- Frage = Thread-Wurzel
  status text not null default 'open' check (status in ('open','answered','escalated','cancelled')),
  remind_at timestamptz,
  escalate_at timestamptz,
  reminded_at timestamptz,
  answered_by uuid references users(id) on delete set null,
  answered_at timestamptz,
  answer_source text check (answer_source in ('chat','task','meeting','mail','system')),
  answer_text text,
  answer_option text,
  answer_message_id uuid references chat_messages(id) on delete set null,
  answer_comment_id uuid references task_comments(id) on delete set null,
  cancel_reason text,
  created_at timestamptz not null default now()
);
create index questions_task_open_idx on questions (task_id) where status = 'open';
create index questions_msg_idx on questions (message_id);
create index questions_addressee_idx on questions (addressee_id, status);
create index questions_due_idx on questions (least(remind_at, escalate_at)) where status = 'open';
alter table task_comments add column question_id uuid references questions(id) on delete set null;
-- Projektagent: dritte PL-Rolle (Mitglied mit Rolle pl, Stellvertretung); bearbeitet eingehende Mails der Projektkonten,
-- wenn agent_mail es vorsieht (off | triage = Vorschläge | process = direkt)
alter table projects add column agent_user_id uuid references users(id) on delete set null;
alter table projects add column agent_mail text not null default 'off' check (agent_mail in ('off','triage','process'));
-- Mail-Rückfrage: bei neuer Mail mit offenen Punkten fragt die KI die PL (ask_pl), fragt im Projektkanal (ask_project),
-- fragt beim Absender (ask_sender) oder lässt es (off); waitHours = Frist für die Rückfrage im Projekt. Org-Standard in orgs.settings.mailInquiry.
alter table projects add column mail_inquiry jsonb not null default '{}'::jsonb;
