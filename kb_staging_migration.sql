-- ============================================================
--  СТЕЙДЖИНГ БАЗЫ ЗНАНИЙ — предложения из ТГ-группы рассылки.
--  Вариант B: группа → фильтр/классификатор/дедуп → ЧЕРНОВИК →
--  ручная модерация в админке → применение в таблицу knowledge.
--  Прод-таблица knowledge напрямую НЕ трогается автоматически.
--  Выполни в Supabase Dashboard → SQL Editor. Дополняет
--  knowledge_migration.sql / assistant_migration.sql, не заменяет.
-- ============================================================

-- ── Черновик факта, предложенный из рассылки ─────────────────────────
create table if not exists knowledge_staging (
  id               bigint generated always as identity primary key,
  tg_chat_id       text,                       -- id группы-источника
  tg_message_id    bigint,                     -- id сообщения в группе (для идемпотентности)
  author           text,                       -- кто написал в группе (для контекста в админке)
  raw_text         text        not null,       -- исходное сообщение как есть
  proposed_action  text        not null check (proposed_action in ('add','update')),
  proposed_content text        not null,       -- нормализованный факт (что ляжет в knowledge)
  target_id        bigint,                     -- knowledge.id, который заменяем (для update)
  target_before    text,                       -- прежний текст факта (показать в админке diff)
  similarity       float,                      -- близость к ближайшему существующему факту
  status           text        not null default 'pending'
                     check (status in ('pending','approved','rejected')),
  applied_knowledge_id bigint,                 -- id в knowledge после применения (approve)
  reviewed_at      timestamptz,                -- когда админ принял/отклонил
  created_at       timestamptz not null default now(),
  -- одно сообщение группы = максимум один черновик (защита от повторной обработки)
  unique (tg_chat_id, tg_message_id)
);

create index if not exists kb_staging_status_idx
  on knowledge_staging (status, created_at desc);

-- ── Курсор long-poll getUpdates, чтобы переживать рестарты воркера ────
create table if not exists tg_poll_state (
  bot            text        primary key,       -- логический тег воркера, напр. 'kb_collector'
  last_update_id bigint      not null default 0,
  updated_at     timestamptz not null default now()
);
