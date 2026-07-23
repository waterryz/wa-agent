// «Мозг» бота: клиенты, RAG (факты + стиль) и генерация ответа через Kimi.
// Используется и ботом (bot.js), и тестовым скриптом (test_reply.js).
require('dotenv').config();
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

// ── Конфиг ───────────────────────────────────────────────────────────
const AGENT_NAME = process.env.AGENT_NAME || 'Alex'; // имя ИИ-ассистента
const OWNER_NAME = process.env.OWNER_NAME || 'Антон'; // владелец, чей стиль перенимаем

const KIMI_MODEL = process.env.KIMI_MODEL || 'kimi-k2.6';
const KIMI_BASE_URL = process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1';
// kimi-k2.6 — «думающая» модель: reasoning тоже тратит выходные токены,
// поэтому лимит с запасом (это потолок, а не цель — короткие ответы не дорожают).
// Зашито в код (env игнорим): kimi-k2.6 тратит токены на reasoning,
// при 4096 сложные ответы обрывались в пустоту — даём запас.
const KIMI_MAX_TOKENS = 8192;

const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';
// Модель для перевода иноязычных запросов на русский ПЕРЕД поиском по базе
// (факты хранятся на русском). По умолчанию та же Kimi, что и для ответов —
// чтобы не тянуть отдельную модель. Можно переопределить через env.
const TRANSLATE_MODEL = process.env.TRANSLATE_MODEL || KIMI_MODEL;

const STYLE_TOP_K = parseInt(process.env.RAG_TOP_K || '6', 10);
const STYLE_MIN_SIM = parseFloat(process.env.RAG_MIN_SIMILARITY || '0.3');
// Фиксировано в коде (НЕ из env), чтобы не зависеть от устаревших переменных на хостинге
const KNOW_TOP_K = 10;
const KNOW_MIN_SIM = 0.2;

// Тарифы для подсчёта стоимости, $ за 1 млн токенов. Поставь свои из консоли Moonshot/OpenAI.
const PRICE_IN = parseFloat(process.env.KIMI_PRICE_IN || '0.60'); // вход Kimi
const PRICE_OUT = parseFloat(process.env.KIMI_PRICE_OUT || '2.50'); // выход Kimi (вкл. reasoning)
const PRICE_EMBED = parseFloat(process.env.EMBED_PRICE || '0.02'); // эмбеддинги OpenAI

function requireEnv(name) {
  if (!process.env[name]) {
    console.error(`❌ Не задана переменная окружения ${name}. Заполни .env (см. .env.example).`);
    process.exit(1);
  }
}
['MOONSHOT_API_KEY', 'OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'].forEach(requireEnv);

// ── Клиенты ──────────────────────────────────────────────────────────
const kimi = new OpenAI({ apiKey: process.env.MOONSHOT_API_KEY, baseURL: KIMI_BASE_URL });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── Эмбеддинг ────────────────────────────────────────────────────────
async function embed(text) {
  const res = await openai.embeddings.create({ model: EMBED_MODEL, input: text });
  return { embedding: res.data[0].embedding, tokens: res.usage?.total_tokens || 0 };
}

// Грубая проверка на русский: есть ли кириллица. Русский (и близкие кириллические)
// запросы ищем как есть; всё остальное сперва переводим на русский.
function hasCyrillic(s) {
  return /[а-яёА-ЯЁ]/.test(s || '');
}

// Переводит иноязычный запрос на русский ТОЛЬКО для поиска по базе (факты на
// русском; кросс-язычная похожесть эмбеддингов слабее и факты проваливаются
// мимо порога). Ответ клиенту всё равно формируется на его языке.
// При любой ошибке возвращаем исходный текст — поиск деградирует, но не падает.
async function translateForRetrieval(text) {
  try {
    // Та же Kimi, что и для ответов. ВАЖНО: kimi-k2.6 принимает только
    // temperature=1 (иначе HTTP 400) — параметр не передаём вообще.
    const res = await kimi.chat.completions.create({
      model: TRANSLATE_MODEL,
      max_tokens: 1024,
      messages: [
        {
          role: 'system',
          content:
            'Переведи сообщение пользователя на русский язык. Выведи ТОЛЬКО перевод, без кавычек и пояснений.',
        },
        { role: 'user', content: text },
      ],
    });
    return (res.choices[0]?.message?.content || '').trim() || text;
  } catch (e) {
    console.error('⚠️  Перевод запроса для поиска не удался:', e.message);
    return text;
  }
}

// ── Admin-факты: приоритетный источник ───────────────────────────────
// Всегда тянем строки с source = 'admin' НАПРЯМУЮ (без вектора). Их вносят
// руками в Supabase и часто БЕЗ эмбеддинга — поэтому match_knowledge их не
// находит и бот отвечает «нет в базе», хотя строка есть. Прямая выборка чинит
// это и одновременно делает admin-факты приоритетными: они всегда в контексте,
// независимо от векторной похожести к запросу.
async function fetchAdminFacts(limit = 100) {
  try {
    const { data, error } = await supabase
      .from('knowledge')
      .select('content')
      .eq('source', 'admin')
      .order('id', { ascending: true })
      .limit(limit);
    if (error) {
      console.error('⚠️  Загрузка admin-фактов:', error.message);
      return [];
    }
    return data || [];
  } catch (e) {
    console.error('⚠️  Загрузка admin-фактов:', e.message);
    return [];
  }
}

// ── RAG: факты (knowledge) + стиль (conversations) одним эмбеддингом ──
async function retrieveContext(text) {
  let examples = [];
  let vectorFacts = [];
  let adminFacts = [];
  let embedTokens = 0;
  try {
    // Иноязычный запрос переводим на русский, чтобы находить русские факты/примеры.
    const queryForEmbed = hasCyrillic(text) ? text : await translateForRetrieval(text);
    const { embedding, tokens } = await embed(queryForEmbed);
    embedTokens = tokens;
    const [conv, know, admin] = await Promise.all([
      supabase.rpc('match_conversations', {
        query_embedding: embedding,
        match_threshold: STYLE_MIN_SIM,
        match_count: STYLE_TOP_K,
      }),
      supabase.rpc('match_knowledge', {
        query_embedding: embedding,
        match_threshold: KNOW_MIN_SIM,
        match_count: KNOW_TOP_K,
      }),
      fetchAdminFacts(), // admin — всегда, минуя вектор
    ]);
    if (conv.error) console.error('⚠️  match_conversations:', conv.error.message);
    else examples = conv.data || [];
    if (know.error) console.error('⚠️  match_knowledge:', know.error.message);
    else vectorFacts = know.data || [];
    adminFacts = admin || [];
  } catch (e) {
    console.error('⚠️  Ошибка RAG:', e.message);
  }

  // Приоритет admin: сначала admin-факты (priority: true), затем векторные факты
  // без дублей по содержимому и без повторного admin (если RPC его всё же вернул).
  const adminSet = new Set(adminFacts.map((f) => (f.content || '').trim()));
  const facts = [
    ...adminFacts.map((f) => ({ content: f.content, priority: true })),
    ...vectorFacts
      .filter((f) => f.source !== 'admin')
      .filter((f) => !adminSet.has((f.content || '').trim()))
      .map((f) => ({ content: f.content, priority: false })),
  ];

  return { examples, facts, embedTokens };
}

// ── Подсказка для Kimi ───────────────────────────────────────────────
function buildSystemPrompt({ examples, facts, firstTurn }) {
  const adminFacts = facts.filter((f) => f.priority);
  const otherFacts = facts.filter((f) => !f.priority);

  const factsBlock = facts.length
    ? [
        `ФАКТЫ О КОМПАНИИ Prime Fusion (опирайся только на них, не выдумывай):`,
        adminFacts.length
          ? `⭐ ПРИОРИТЕТНЫЕ ФАКТЫ ОТ АДМИНИСТРАТОРА (высший приоритет — при любом ` +
            `противоречии с остальными фактами, брошюрой, договором или примерами ` +
            `верь ИМЕННО ЭТИМ строкам):\n\n` +
            adminFacts.map((f) => `• ${f.content}`).join('\n\n')
          : '',
        otherFacts.length
          ? `ОСТАЛЬНЫЕ ФАКТЫ:\n\n` + otherFacts.map((f) => `• ${f.content}`).join('\n\n')
          : '',
      ]
        .filter(Boolean)
        .join('\n\n')
    : '';

  const examplesBlock = examples.length
    ? `ПРИМЕРЫ реальных ответов ${OWNER_NAME} на похожие сообщения ` +
      `(перенимай тон, формулировки и длину):\n\n` +
      examples
        .map((e, i) => `[${i + 1}]\nКлиент: ${e.trigger}\n${OWNER_NAME}: ${e.reply}`)
        .join('\n\n')
    : `Похожих примеров не нашлось — отвечай в обычном деловом, но живом и дружелюбном стиле.`;

  const head = [
    `Ты — ${AGENT_NAME}, ИИ-ассистент компании Prime Fusion Inc (аренда TLC-автомобилей в Нью-Йорке для работы в Uber/Lyft). Ты общаешься с клиентами в WhatsApp от лица компании.`,
    ``,
    `ЧЕСТНОСТЬ:`,
    `- Ты ИИ-ассистент, а не человек. Не выдавай себя за ${OWNER_NAME} или другого сотрудника. Если спрашивают, кто ты или бот ли ты — честно скажи, что ты ИИ-помощник ${AGENT_NAME} компании Prime Fusion.`,
    firstTurn
      ? `- ЭТО ПЕРВОЕ твоё сообщение в этом диалоге: ОБЯЗАТЕЛЬНО начни ответ с короткого представления — что ты ${AGENT_NAME}, ИИ-помощник Prime Fusion — ДАЖЕ ЕСЛИ клиент не поздоровался и сразу задал вопрос. Сначала представься одной фразой, потом ответь по сути.`
      : `- Диалог уже идёт — представляться заново не нужно.`,
    ``,
    `ЯЗЫК ОТВЕТА:`,
    `- Отвечай на ТОМ ЖЕ языке, на котором написал клиент: русский → по-русски, английский → по-английски, испанский → по-испански, и так для любого языка. Определяй язык по последнему сообщению клиента.`,
    `- Представление в первом сообщении, приветствия и весь текст — тоже на языке клиента.`,
    `- Блок ФАКТЫ ниже может быть на русском: используй его СОДЕРЖАНИЕ, но формулируй ответ на языке клиента (при необходимости переведи факты). Собственные имена и названия тарифов оставляй как в фактах.`,
    `- Если клиент смешивает языки или язык неясен — отвечай по-русски.`,
    `- ИСКЛЮЧЕНИЕ: служебный маркер эскалации [[ESCALATE]] и причину в нём ВСЕГДА пиши по-русски (их видит только владелец, клиент их не видит).`,
    ``,
    `КАК ОТВЕЧАТЬ:`,
    `- Коротко и по-человечески, как в мессенджере, без официально-роботного стиля.`,
    `- По фактам (цены, условия, сервис, инспекции, договор) опирайся на блок ФАКТЫ ниже.`,
    `- Если ответ ЕСТЬ в блоке ФАКТЫ — дай его сразу, уверенно и конкретно (с числами и деталями). НЕ говори «уточню», «не знаю точно», «у всех по-разному» и НЕ передавай ${OWNER_NAME} то, что уже есть в ФАКТАХ.`,
    `- Если в ФАКТАХ есть конкретные цены, тарифы или цифры — ОБЯЗАТЕЛЬНО назови их, даже если рядом есть оговорка, что цена «согласуется индивидуально» или «не фиксируется в договоре». Эта оговорка значит лишь, что итог можно скорректировать. Никогда не говори, что у компании «нет тарифов/планов/фиксированных цен» — базовые тарифы есть всегда, назови их, а не отправляй к ${OWNER_NAME}.`,
    `- Не выдумывай условий, скидок, цифр или обещаний, которых нет в блоке ФАКТЫ. Если в ФАКТАХ есть бонус (например, бесплатная неделя за 6 месяцев аренды) — о нём сказать можно; скидок и акций, которых в ФАКТАХ нет, не предлагай, даже если они встречаются в ПРИМЕРАХ (старые переписки).`,
    `- НЕ раскрывай клиенту внутреннюю/служебную информацию компании: названия и стоимость страховых компаний и брокеров (например ATIK, Hereford, Transit General, проценты, $/год, $/мес), закупочные цены машин, стоимость WAV-конверсии, маржу, экономику бизнеса. На вопрос «сколько стоит страховка» отвечай: full coverage входит в аренду, отдельно платить не нужно; при своей вине — deductible $1000. Без сумм страховых взносов, названий страховых и закупочных/конверсионных затрат.`,
    `- При расхождении данных приоритет у ПРИОРИТЕТНЫХ ФАКТОВ ОТ АДМИНИСТРАТОРА, затем у договора и официальной рассылки; сведения, помеченные как из старых переписок, могут быть устаревшими.`,
    `- Из блока ПРИМЕРЫ бери ТОЛЬКО тон и манеру речи ${OWNER_NAME}. НЕ переноси из примеров конкретные факты, цифры, условия и обещания — вся фактическая информация только из блока ФАКТЫ. Если чего-то нет в ФАКТЫ — не утверждай это, даже если похожее встречается в ПРИМЕРАХ. Говори от себя как ${AGENT_NAME}, не выдавая себя за ${OWNER_NAME}.`,
    `- Выдавай только текст сообщения, без кавычек и префиксов.`,
    ``,
    `КОГДА ПЕРЕДАВАТЬ ЧЕЛОВЕКУ (${OWNER_NAME}):`,
    `- Если нужного факта нет в блоке ФАКТЫ; или клиент недоволен ответом; или просит живого человека/${OWNER_NAME}; или вопрос требует индивидуального решения (особые условия, торг по цене, жалоба, спор, проблема с конкретной машиной/оплатой/документами) — НЕ выдумывай.`,
    `- Тогда: напиши клиенту короткое сообщение (на языке клиента), что передашь вопрос ${OWNER_NAME} и он свяжется, И ОТДЕЛЬНОЙ ПОСЛЕДНЕЙ СТРОКОЙ добавь служебный маркер:`,
    `  [[ESCALATE]] краткая причина на русском`,
    `  Клиент маркер не увидит — его обрабатывает система. Без маркера передача не сработает.`,
  ].join('\n');

  return [head, factsBlock, examplesBlock].filter(Boolean).join('\n\n');
}

// ── Генерация ответа (Kimi) ──────────────────────────────────────────
async function generateReply(systemPrompt, history) {
  const messages = [{ role: 'system', content: systemPrompt }, ...history];
  const res = await kimi.chat.completions.create({
    model: KIMI_MODEL,
    messages,
    max_tokens: KIMI_MAX_TOKENS,
  });
  return { text: (res.choices[0]?.message?.content || '').trim(), usage: res.usage || {} };
}

// Стоимость одного ответа в токенах и долларах
function costOf({ promptTokens = 0, completionTokens = 0, embedTokens = 0 }) {
  const usd =
    (promptTokens * PRICE_IN + completionTokens * PRICE_OUT + embedTokens * PRICE_EMBED) / 1e6;
  return {
    in: promptTokens,
    out: completionTokens,
    embed: embedTokens,
    tokens: promptTokens + completionTokens + embedTokens,
    usd,
  };
}

// Выделяет служебный маркер эскалации [[ESCALATE]] из ответа модели.
function parseEscalation(reply) {
  const raw = reply || '';
  const m = raw.match(/\[\[ESCALATE\]\]\s*(.*)\s*$/m);
  if (!m) return { text: raw.trim(), escalate: false, reason: '' };
  return {
    text: raw.replace(/\[\[ESCALATE\]\].*$/m, '').trim(),
    escalate: true,
    reason: (m[1] || '').trim(),
  };
}

module.exports = {
  AGENT_NAME,
  OWNER_NAME,
  KIMI_MODEL,
  embed,
  retrieveContext,
  buildSystemPrompt,
  generateReply,
  parseEscalation,
  costOf,
};
