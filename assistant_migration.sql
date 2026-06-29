-- ============================================================
--  ОБЩЕЕ ЯДРО ИИ-АССИСТЕНТА — единое хранилище переписок
--  по всем каналам: сайт (web), Telegram (telegram), WhatsApp (whatsapp).
--  Выполни в Supabase Dashboard → SQL Editor.
--  Дополняет supabase_migration.sql / knowledge_migration.sql / web_migration.sql,
--  ничего из них не заменяет.
-- ============================================================

-- ── Диалог: одна строка = один собеседник в одном канале ─────────────
create table if not exists assistant_conversations (
  id              bigint generated always as identity primary key,
  channel         text not null check (channel in ('web','telegram','whatsapp')),
  -- external_id: web → uuid сессии в браузере; telegram → chat_id; whatsapp → номер (цифры)
  external_id     text not null,
  contact_name    text,
  contact_email   text,
  contact_phone   text,
  is_driver       boolean     not null default false,  -- существующий водитель?
  driver_id       text,                                -- id из drivers.json, если водитель
  operator_mode   boolean     not null default false,  -- true → ИИ молчит, отвечает человек из админки
  status          text        not null default 'active'
                    check (status in ('active','escalated','closed')),
  admin_last_read_at timestamptz,                      -- для счётчика непрочитанных
  created_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  unique (channel, external_id)
);

create index if not exists assistant_conv_last_idx
  on assistant_conversations (last_message_at desc);
create index if not exists assistant_conv_status_idx
  on assistant_conversations (status, last_message_at desc);

-- ── Сообщения внутри диалога ─────────────────────────────────────────
--   role: user      — собеседник
--         assistant — ответ ИИ (Alex)
--         operator  — ответ живого оператора из админки
--         system     — служебные пометки (необяз.)
create table if not exists assistant_messages (
  id              bigint generated always as identity primary key,
  conversation_id bigint      not null references assistant_conversations(id) on delete cascade,
  role            text        not null check (role in ('user','assistant','operator','system')),
  content         text        not null,
  meta            jsonb,                              -- {escalate, reason, facts, examples, usage...}
  created_at      timestamptz not null default now()
);

create index if not exists assistant_msg_conv_idx
  on assistant_messages (conversation_id, created_at);
create index if not exists assistant_msg_id_idx
  on assistant_messages (conversation_id, id);

-- ── Удобное представление для списка диалогов в админке ──────────────
--   тянет последнее сообщение + число непрочитанных (новые user-сообщения
--   после admin_last_read_at) одним запросом, без N+1.
create or replace view assistant_conversation_list as
select
  c.id, c.channel, c.external_id,
  c.contact_name, c.contact_email, c.contact_phone,
  c.is_driver, c.driver_id, c.operator_mode, c.status,
  c.created_at, c.last_message_at,
  lm.content   as last_message,
  lm.role      as last_role,
  lm.created_at as last_message_time,
  (
    select count(*) from assistant_messages m
    where m.conversation_id = c.id
      and m.role = 'user'
      and m.created_at > coalesce(c.admin_last_read_at, 'epoch'::timestamptz)
  ) as unread
from assistant_conversations c
left join lateral (
  select content, role, created_at
  from assistant_messages m
  where m.conversation_id = c.id
  order by created_at desc
  limit 1
) lm on true;