-- ============================================================
--  WhatsApp AI агент — схема для хранения переписок (RAG)
--  Выполни это в Supabase Dashboard → SQL Editor
-- ============================================================

-- pgvector — расширение для векторного поиска
create extension if not exists vector;

-- Одна строка = одна пара "сообщение клиента → ответ Антона".
-- Эмбеддинг считается по тексту клиента (trigger), потому что именно
-- по входящему сообщению мы потом ищем похожие прошлые ситуации.
create table if not exists conversations (
  id          bigint generated always as identity primary key,
  contact     text        not null,          -- имя контакта/клиента
  trigger     text        not null,          -- сообщение(я) клиента
  reply       text        not null,          -- как ответил Антон
  embedding   vector(1536),                  -- эмбеддинг поля trigger
  created_at  timestamptz not null default now()
);

-- Индекс для быстрого поиска ближайших соседей по косинусной близости.
-- HNSW не требует предварительного обучения и хорошо работает на любом объёме.
create index if not exists conversations_embedding_idx
  on conversations
  using hnsw (embedding vector_cosine_ops);

-- Фильтр по контакту пригодится при переусыпке/чистке данных
create index if not exists conversations_contact_idx
  on conversations (contact);

-- Функция поиска похожих прошлых ответов.
-- similarity = 1 - cosine_distance (1.0 — идеальное совпадение, 0 — нет связи)
create or replace function match_conversations(
  query_embedding vector(1536),
  match_threshold  float,
  match_count      int
)
returns table (
  id         bigint,
  contact    text,
  trigger    text,
  reply      text,
  similarity float
)
language sql
stable
as $$
  select
    c.id,
    c.contact,
    c.trigger,
    c.reply,
    1 - (c.embedding <=> query_embedding) as similarity
  from conversations c
  where c.embedding is not null
    and 1 - (c.embedding <=> query_embedding) > match_threshold
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
