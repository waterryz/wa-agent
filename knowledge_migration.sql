-- ============================================================
--  База знаний (факты о компании: брошюра, договор, рассылка)
--  Выполни в Supabase Dashboard → SQL Editor
--  (дополняет supabase_migration.sql, не заменяет его)
-- ============================================================

create extension if not exists vector;

-- Одна строка = один кусок текста из документа-источника.
create table if not exists knowledge (
  id          bigint generated always as identity primary key,
  source      text        not null,        -- имя файла-источника (brochure.md и т.п.)
  content     text        not null,        -- кусок текста
  embedding   vector(1536),                -- эмбеддинг content
  created_at  timestamptz not null default now()
);

create index if not exists knowledge_embedding_idx
  on knowledge using hnsw (embedding vector_cosine_ops);
create index if not exists knowledge_source_idx
  on knowledge (source);

-- Поиск релевантных фактов по эмбеддингу вопроса клиента.
create or replace function match_knowledge(
  query_embedding vector(1536),
  match_threshold  float,
  match_count      int
)
returns table (
  id         bigint,
  source     text,
  content    text,
  similarity float
)
language sql
stable
as $$
  select
    k.id,
    k.source,
    k.content,
    1 - (k.embedding <=> query_embedding) as similarity
  from knowledge k
  where k.embedding is not null
    and 1 - (k.embedding <=> query_embedding) > match_threshold
  order by k.embedding <=> query_embedding
  limit match_count;
$$;
