require('dotenv').config();

const fs = require('fs');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';
// Имя владельца/компании в экспортах WhatsApp — по нему отличаем ответы Антона
// (его стиль) от сообщений клиента. В этих чатах владелец = "Prime Fusion Inc".
const CHAT_OWNER = (process.env.CHAT_OWNER_NAME || 'Prime Fusion Inc').toLowerCase();

// ── Проверка переменных окружения ────────────────────────────────────
function requireEnv(name) {
  if (!process.env[name]) {
    console.error(`❌ Не задана переменная окружения ${name}. Заполни .env (см. .env.example).`);
    process.exit(1);
  }
}
['OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'].forEach(requireEnv);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── Аргументы командной строки ───────────────────────────────────────
const [, , filePath, contactName] = process.argv;
if (!filePath || !contactName) {
  console.error('Использование: node parse_and_upload.js "<путь к экспорту .txt>" "<Имя контакта>"');
  console.error('Пример:       node parse_and_upload.js "./WhatsApp Chat with Evgenii Rent.txt" "Evgenii Rent"');
  process.exit(1);
}

// ── Парсер экспорта WhatsApp ─────────────────────────────────────────
// Поддерживает форматы:
//   [06.11.2025, 14:30:15] Имя: текст        (iOS, в квадратных скобках)
//   06.11.2025, 14:30 - Имя: текст           (Android, через тире)
const DATETIME =
  '\\d{1,2}[./]\\d{1,2}[./]\\d{2,4},?\\s+\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s?[APap][Mm])?';
const RE_BRACKET = new RegExp('^\\u200e?\\[' + DATETIME + '\\]\\s*(.*)$');
const RE_DASH = new RegExp('^\\u200e?' + DATETIME + '\\s-\\s(.*)$');

const MEDIA_MARKERS = [
  '<media omitted>',
  '<медиа пропущено>',
  'image omitted',
  'video omitted',
  'audio omitted',
  'sticker omitted',
  'gif omitted',
  'document omitted',
  'изображение отсутствует',
  'медиафайл отсутствует',
  'this message was deleted',
  'сообщение удалено',
  '(file attached)',
  '<attached:',
];

// убрать невидимые направляющие символы (LRM/RTL и т.п.)
function clean(s) {
  return s.replace(/[‎‏‪-‮]/g, '').trim();
}

function isMedia(text) {
  const t = text.toLowerCase();
  return MEDIA_MARKERS.some((m) => t.includes(m));
}

// сырой текст → массив сообщений { sender, body }
function parseMessages(raw) {
  const lines = raw.split(/\r?\n/);
  const messages = [];
  for (const line of lines) {
    const m = line.match(RE_BRACKET) || line.match(RE_DASH);
    if (m) {
      const rest = clean(m[1]);
      const idx = rest.indexOf(': ');
      if (idx === -1) continue; // системное сообщение (шифрование, «создал группу» и т.п.)
      const sender = rest.slice(0, idx).trim();
      const body = rest.slice(idx + 2);
      messages.push({ sender, body });
    } else if (messages.length) {
      // строка без заголовка — продолжение многострочного сообщения
      messages[messages.length - 1].body += '\n' + line;
    }
  }
  return messages;
}

// склеить подряд идущие сообщения одного отправителя в один «ход»
function toTurns(messages) {
  const turns = [];
  for (const { sender, body } of messages) {
    const text = clean(body);
    if (!text || isMedia(text)) continue;
    // владелец (Антон) = "Prime Fusion Inc"; всё остальное = клиент
    const s = sender.toLowerCase();
    const isOwner = s === CHAT_OWNER || s.includes(CHAT_OWNER);
    const speaker = isOwner ? 'owner' : 'customer';
    if (turns.length && turns[turns.length - 1].speaker === speaker) {
      turns[turns.length - 1].text += '\n' + text;
    } else {
      turns.push({ speaker, text });
    }
  }
  return turns;
}

// построить пары «сообщение клиента → ответ владельца»
function toPairs(turns) {
  const pairs = [];
  let lastCustomer = null;
  for (const turn of turns) {
    if (turn.speaker === 'customer') {
      lastCustomer = turn.text;
    } else if (turn.speaker === 'owner' && lastCustomer) {
      pairs.push({ trigger: lastCustomer, reply: turn.text });
      lastCustomer = null;
    }
  }
  return pairs;
}

// ── Эмбеддинги пачками ───────────────────────────────────────────────
async function embedBatch(texts) {
  const res = await openai.embeddings.create({ model: EMBED_MODEL, input: texts });
  return res.data.map((d) => d.embedding);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── main ─────────────────────────────────────────────────────────────
async function main() {
  const raw = fs.readFileSync(filePath, 'utf8');
  const messages = parseMessages(raw);
  const turns = toTurns(messages);
  const pairs = toPairs(turns);

  console.log(`Файл: ${filePath}`);
  console.log(`Сообщений распознано: ${messages.length}`);
  console.log(`Ходов (склеено):      ${turns.length}`);
  console.log(`Пар «клиент → владелец»: ${pairs.length}`);

  if (!pairs.length) {
    console.log('⚠️  Пар не найдено (клиент не писал текстом) — пропускаю.');
    return;
  }

  // чтобы перезаливка не плодила дубли — удаляем прежние строки этого контакта
  const { error: delErr } = await supabase
    .from('conversations')
    .delete()
    .eq('contact', contactName);
  if (delErr) {
    console.error('⚠️  Не удалось очистить прежние строки:', delErr.message);
  } else {
    console.log(`Старые строки контакта «${contactName}» удалены.`);
  }

  // считаем эмбеддинги и заливаем пачками
  let uploaded = 0;
  for (const batch of chunk(pairs, 96)) {
    const embeddings = await embedBatch(batch.map((p) => p.trigger));
    const rows = batch.map((p, i) => ({
      contact: contactName,
      trigger: p.trigger,
      reply: p.reply,
      embedding: embeddings[i],
    }));
    const { error } = await supabase.from('conversations').insert(rows);
    if (error) {
      console.error('❌ Ошибка вставки в Supabase:', error.message);
      process.exit(1);
    }
    uploaded += rows.length;
    console.log(`Загружено ${uploaded}/${pairs.length}...`);
  }

  console.log(`✅ Готово. Загружено пар: ${uploaded}`);
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
