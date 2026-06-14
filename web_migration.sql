-- ============================================================
--  Веб-панель исключений: кому бот НЕ отвечает.
--  Выполни в Supabase Dashboard → SQL Editor.
-- ============================================================

-- Контакты, которых видел бот (для удобного выбора в панели)
create table if not exists seen_contacts (
  number     text primary key,        -- цифры номера (chat id без @c.us)
  name       text,
  last_seen  timestamptz not null default now()
);

-- Исключения: кому бот НЕ отвечает автоматически
create table if not exists blocked_contacts (
  id         bigint generated always as identity primary key,
  number     text not null unique,    -- цифры номера
  name       text,                    -- метка для себя (Жена, Дочь...)
  created_at timestamptz not null default now()
);

-- Переданные вопросы: на что ИИ не ответил / клиент попросил человека
create table if not exists escalations (
  id         bigint generated always as identity primary key,
  number     text,                    -- номер клиента
  name       text,                    -- имя/контакт клиента
  question   text,                    -- сообщение клиента
  reason     text,                    -- почему передано (от модели)
  resolved   boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists escalations_open_idx on escalations (resolved, created_at desc);
