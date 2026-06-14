// Загрузка базы знаний: читает все .md/.txt из папки knowledge/,
// режет на куски, считает эмбеддинги (OpenAI) и заливает в Supabase (таблица knowledge).
//
//   node ingest_docs.js
//
// Идемпотентно: при повторном запуске старые куски каждого файла удаляются.

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';
const MAX_CHARS = 1800; // верхняя граница размера куска

function requireEnv(name) {
  if (!process.env[name]) {
    console.error(`❌ Не задана переменная окружения ${name}. Заполни .env (см. .env.example).`);
    process.exit(1);
  }
}
['OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'].forEach(requireEnv);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge');

// markdown → куски: по секциям ##, длинные секции дробим по абзацам
function chunkMarkdown(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  let cur = [];
  for (const line of lines) {
    if (/^##\s/.test(line) && cur.length) {
      sections.push(cur.join('\n'));
      cur = [line];
    } else {
      cur.push(line);
    }
  }
  if (cur.length) sections.push(cur.join('\n'));

  const chunks = [];
  for (const sec of sections) {
    if (sec.length <= MAX_CHARS) {
      chunks.push(sec.trim());
      continue;
    }
    const heading = (sec.match(/^##\s.*$/m) || [''])[0];
    let buf = '';
    for (const para of sec.split(/\n\s*\n/)) {
      if (buf && (buf + '\n\n' + para).length > MAX_CHARS) {
        chunks.push(buf.trim());
        buf = heading && !para.startsWith(heading) ? heading + '\n' + para : para;
      } else {
        buf = buf ? buf + '\n\n' + para : para;
      }
    }
    if (buf.trim()) chunks.push(buf.trim());
  }
  return chunks.filter((c) => c.trim().length > 20);
}

async function embedBatch(texts) {
  const res = await openai.embeddings.create({ model: EMBED_MODEL, input: texts });
  return res.data.map((d) => d.embedding);
}

function batched(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function ingestFile(file) {
  const source = path.basename(file);
  const text = fs.readFileSync(file, 'utf8');
  const chunks = chunkMarkdown(text);
  if (!chunks.length) {
    console.log(`${source}: пусто, пропускаю`);
    return 0;
  }

  // идемпотентность: удаляем прежние куски этого источника
  const { error: delErr } = await supabase.from('knowledge').delete().eq('source', source);
  if (delErr) console.error(`⚠️  ${source}: не удалось очистить старые куски:`, delErr.message);

  let uploaded = 0;
  for (const batch of batched(chunks, 96)) {
    const embeddings = await embedBatch(batch);
    const rows = batch.map((content, i) => ({ source, content, embedding: embeddings[i] }));
    const { error } = await supabase.from('knowledge').insert(rows);
    if (error) {
      console.error(`❌ ${source}: ошибка вставки:`, error.message);
      process.exit(1);
    }
    uploaded += rows.length;
  }
  console.log(`${source}: ${uploaded} кусков`);
  return uploaded;
}

async function main() {
  if (!fs.existsSync(KNOWLEDGE_DIR)) {
    console.error(`❌ Папка не найдена: ${KNOWLEDGE_DIR}. Положи в неё .md/.txt с информацией.`);
    process.exit(1);
  }
  const files = fs
    .readdirSync(KNOWLEDGE_DIR)
    .filter((f) => /\.(md|txt)$/i.test(f))
    .map((f) => path.join(KNOWLEDGE_DIR, f));

  if (!files.length) {
    console.error(`❌ В ${KNOWLEDGE_DIR} нет .md/.txt файлов.`);
    process.exit(1);
  }

  // проверяем, что таблица knowledge существует (иначе не жжём эмбеддинги зря)
  const probe = await supabase.from('knowledge').select('id').limit(1);
  if (probe.error) {
    console.error(`❌ Таблица knowledge недоступна: ${probe.error.message}`);
    console.error('   Сначала выполни knowledge_migration.sql в Supabase → SQL Editor.');
    process.exit(1);
  }

  console.log(`Файлов к загрузке: ${files.length}`);
  let total = 0;
  for (const f of files) total += await ingestFile(f);
  console.log(`✅ Готово. Всего кусков в базе знаний: ${total}`);
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
