// «Мозг» бота: клиенты, RAG (факты + стиль), разбор фото и генерация ответа через Kimi.
// Используется сервером (server.js), общим ядром (assistant_core.js) и тестовыми скриптами.
require('dotenv').config();
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

// ── Конфиг ───────────────────────────────────────────────────────────
// Числа из env читаем только через это: мусор в переменной (пустая строка, "abc",
// "4 " с пробелом) даёт NaN, а NaN дальше тихо ломает Math.min/slice/счётчики.
function intEnv(name, def, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = parseInt(process.env[name], 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

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

// Vision: kimi-k2.6 умеет изображения, отдельная модель не нужна.
// Можно переопределить, если захочется гонять фото на другой модели.
const VISION_MODEL = process.env.VISION_MODEL || KIMI_MODEL;
// Само описание короткое, НО kimi-k2.6 тратит выходные токены ещё и на reasoning.
// При 1024 JSON обрывался на середине и каждое фото становилось 'unclear' — даём запас.
const VISION_MAX_TOKENS = intEnv('VISION_MAX_TOKENS', 4096, 512, 16384);
// Защита от абьюза: сколько картинок максимум уходит в один vision-вызов.
const VISION_MAX_IMAGES = intEnv('VISION_MAX_IMAGES', 4, 1, 16);
// Таймауты на вызовы модели: без них vision-запрос с 4 картинками может висеть
// минутами и держать весь ответ клиенту.
const KIMI_TIMEOUT_MS = intEnv('KIMI_TIMEOUT_MS', 90000, 5000);
const VISION_TIMEOUT_MS = intEnv('VISION_TIMEOUT_MS', 120000, 5000);
const TRANSLATE_TIMEOUT_MS = intEnv('TRANSLATE_TIMEOUT_MS', 30000, 5000);

const STYLE_TOP_K = intEnv('RAG_TOP_K', 6);
const STYLE_MIN_SIM = parseFloat(process.env.RAG_MIN_SIMILARITY || '0.3');
// Фиксировано в коде (НЕ из env), чтобы не зависеть от устаревших переменных на хостинге
const KNOW_TOP_K = 10;
const KNOW_MIN_SIM = 0.2;

// Сколько admin-фактов тянем разом. Когда их станет заметно больше — тянуть все
// станет дорого (каждый факт = входные токены в КАЖДОМ запросе); тогда правильный
// шаг — отдельный векторный поиск по source='admin' с низким порогом.
const ADMIN_FACTS_LIMIT = intEnv('ADMIN_FACTS_LIMIT', 200, 1);

// Тарифы для подсчёта стоимости, $ за 1 млн токенов. Актуальные цены — в консоли
// Moonshot/OpenAI, они меняются; дефолты ниже соответствуют kimi-k2.6 на момент правки.
const PRICE_IN = parseFloat(process.env.KIMI_PRICE_IN || '0.95'); // вход Kimi
const PRICE_OUT = parseFloat(process.env.KIMI_PRICE_OUT || '4.00'); // выход Kimi (вкл. reasoning)
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
    const res = await kimi.chat.completions.create(
      {
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
      },
      { timeout: TRANSLATE_TIMEOUT_MS },
    );
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
async function fetchAdminFacts(limit = ADMIN_FACTS_LIMIT) {
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
    const rows = data || [];
    if (rows.length === limit) {
      console.warn(
        `⚠️  Admin-фактов ровно ${limit} — возможно, часть не попала в контекст. Подними ADMIN_FACTS_LIMIT.`,
      );
    }
    return rows;
  } catch (e) {
    console.error('⚠️  Загрузка admin-фактов:', e.message);
    return [];
  }
}

// ── RAG: факты (knowledge) + стиль (conversations) одним эмбеддингом ──
async function retrieveContext(text) {
  let examples = [];
  let vectorFacts = [];
  let embedTokens = 0;

  // admin — независимо от вектора: запрос стартует ДО общего try и ждётся ПОСЛЕ,
  // чтобы (а) сбой эмбеддинга не убивал приоритетные факты, (б) не платить лишним
  // round-trip'ом к Supabase. fetchAdminFacts никогда не бросает — unhandled rejection
  // невозможен.
  const adminPromise = fetchAdminFacts();

  const query = (text || '').trim();
  if (!query) {
    // Пустой запрос: embed('') отвергается OpenAI, а translateForRetrieval('')
    // ушёл бы лишним вызовом в Kimi. Отдаём только admin-факты.
    const only = await adminPromise;
    return {
      examples: [],
      facts: only.map((f) => ({ content: f.content, priority: true })),
      embedTokens: 0,
    };
  }

  try {
    // Иноязычный запрос переводим на русский, чтобы находить русские факты/примеры.
    const queryForEmbed = hasCyrillic(query) ? query : await translateForRetrieval(query);
    const { embedding, tokens } = await embed(queryForEmbed);
    embedTokens = tokens;
    const [conv, know] = await Promise.all([
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
    ]);
    if (conv.error) console.error('⚠️  match_conversations:', conv.error.message);
    else examples = conv.data || [];
    if (know.error) console.error('⚠️  match_knowledge:', know.error.message);
    else vectorFacts = know.data || [];
  } catch (e) {
    console.error('⚠️  Ошибка RAG:', e.message);
  }

  const adminFacts = await adminPromise;

  // Приоритет admin: сначала admin-факты (priority: true), затем векторные факты
  // без дублей по содержимому и без повторного admin (если RPC его всё же вернул).
  // Примечание: фильтр по f.source работает, только если SQL-функция match_knowledge
  // возвращает колонку source; если нет — дубли всё равно снимает adminSet.
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

// ── Разбор фото («глаза» ассистента) ─────────────────────────────────
// Возвращает структурированное описание НА РУССКОМ (факты в базе на русском —
// описание сразу пригодно как поисковый запрос для RAG).
// images: [{ b64, mime }]. caption: подпись клиента к фото ('' если нет).
// НИКОГДА не бросает исключение: при любом сбое вернёт category:'unclear',
// и бот просто попросит клиента описать проблему словами.
async function describeImages(images, caption = '') {
  const fallback = {
    category: 'unclear',
    description: '',
    text_on_image: '',
    question: '',
    usage: {},
  };

  const list = (Array.isArray(images) ? images : [])
    .filter((img) => img && img.b64 && img.mime)
    .slice(0, VISION_MAX_IMAGES);
  if (!list.length) return fallback;

  const sys = [
    'Ты — «глаза» ИИ-ассистента компании Prime Fusion (аренда TLC-автомобилей в Нью-Йорке для Uber/Lyft).',
    'Клиент прислал фото в WhatsApp. Опиши ТОЛЬКО то, что реально видно, конкретно и по делу, на русском языке.',
    'Не придумывай деталей, которых не видно. Не давай советов и не отвечай клиенту — твоя задача только описать.',
    '',
    'Верни СТРОГО JSON без markdown-обёртки:',
    '{',
    '  "category": одна из: "damage" (повреждение авто/ДТП), "document" (права, TLC-лицензия, страховка, регистрация, договор),',
    '              "dashboard" (панель приборов, индикатор, ошибка), "payment" (чек, скриншот оплаты/банка/задолженности),',
    '              "app" (скриншот Uber/Lyft/приложения), "car" (авто целиком, салон, без повреждений),',
    '              "other", "unclear" (не разобрать),',
    '  "description": 1-3 предложения — что на фото, максимально конкретно,',
    '  "text_on_image": весь значимый текст/цифры с фото ("" если нет),',
    '  "question": какой вопрос клиента наиболее вероятен по этому фото ("" если непонятно)',
    '}',
  ].join('\n');

  const content = list.map((img) => ({
    type: 'image_url',
    image_url: { url: `data:${img.mime};base64,${img.b64}` },
  }));
  content.push({
    type: 'text',
    text: caption ? `Подпись клиента к фото: ${caption}` : 'Подписи к фото нет.',
  });

  try {
    // ВАЖНО: kimi-k2.6 принимает только temperature=1 — параметр не передаём.
    const res = await kimi.chat.completions.create(
      {
        model: VISION_MODEL,
        max_tokens: VISION_MAX_TOKENS,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content },
        ],
      },
      { timeout: VISION_TIMEOUT_MS },
    );

    const finish = res.choices[0]?.finish_reason;
    if (finish === 'length') {
      console.warn(
        `⚠️  Vision-ответ обрезан по лимиту (VISION_MAX_TOKENS=${VISION_MAX_TOKENS}) — подними лимит.`,
      );
    }

    const raw = (res.choices[0]?.message?.content || '').trim();
    // Модель нередко дописывает «Вот результат:» и оборачивает в ```json.
    // Забираем самый внешний JSON-объект, а не полагаемся на позицию фенсов.
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : raw);

    // Нормализация: модель может вернуть null/число/массив вместо строки —
    // без этого в промпт уедет «Категория: null».
    const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
    const CATEGORIES = [
      'damage',
      'document',
      'dashboard',
      'payment',
      'app',
      'car',
      'other',
      'unclear',
    ];
    const category = str(parsed.category).toLowerCase();
    const description = str(parsed.description);

    return {
      // Неизвестная категория: если описание есть — 'other', если нет — честно 'unclear'.
      category: CATEGORIES.includes(category) ? category : description ? 'other' : 'unclear',
      description,
      text_on_image: str(parsed.text_on_image),
      question: str(parsed.question),
      usage: res.usage || {},
    };
  } catch (e) {
    console.error('⚠️  Разбор фото не удался:', e.message);
    return fallback;
  }
}

// Что отдаём в retrieveContext, когда пришло фото.
// Подпись клиента идёт первой — она важнее машинного описания.
function buildPhotoQuery(photo, caption = '') {
  return [caption, photo && photo.description, photo && photo.text_on_image, photo && photo.question]
    .filter(Boolean)
    .join('. ')
    .slice(0, 1000);
}

// Текстовый след фото для history. КРИТИЧНО: в историю диалога НИКОГДА не должен
// попадать base64 — иначе через пару фото промпт распухнет на мегабайты.
function photoHistoryText(photo, caption = '') {
  const desc = (photo && photo.description) || 'изображение не удалось разобрать';
  return caption ? `[Фото] ${desc} | Подпись клиента: ${caption}` : `[Фото] ${desc}`;
}

// Блок системного промпта про присланное фото.
function buildPhotoBlock(photo, caption = '') {
  if (!photo) return '';
  const lines = [
    `КЛИЕНТ ПРИСЛАЛ ФОТО. Вот что на нём (результат автоматического разбора изображения):`,
    `- Категория: ${photo.category}`,
    photo.description ? `- Описание: ${photo.description}` : '',
    photo.text_on_image ? `- Текст на изображении: ${photo.text_on_image}` : '',
    ``,
    `ПРАВИЛА ПРО ФОТО:`,
    `- Дай понять клиенту, что ты действительно посмотрел фото: коротко назови, что видишь, своими словами. Не пересказывай описание целиком и не пиши «категория: damage» — говори по-человечески.`,
    caption
      ? `- К фото есть вопрос клиента — ответь именно на него, опираясь на блок ФАКТЫ.`
      : `- Подписи к фото НЕТ: назови, что видишь, и ОДНИМ коротким вопросом уточни, что нужно сделать (оформить обращение / вопрос по ремонту / проверить документ и т.п.). Не гадай и не выдавай длинную инструкцию на все случаи.`,
    `- Фото — это ситуация клиента, а НЕ источник фактов о компании. Цены, сроки, условия страховки и ремонта бери ТОЛЬКО из блока ФАКТЫ.`,
    `- Не оценивай по фото стоимость ремонта, размер ущерба, покроет ли страховка и кто виноват — этого в ФАКТАХ нет. Такие вопросы передавай ${OWNER_NAME}.`,
    `- Если на фото документ с личными данными (номер прав, TLC-лицензии, паспорта, банковской карты) — НЕ повторяй эти номера в ответе.`,
    photo.category === 'unclear'
      ? `- Фото не удалось разобрать: честно скажи, что изображение не открылось/не разобрать, и попроси описать проблему словами или прислать фото поярче.`
      : '',
    `- Фото повреждений и ДТП (category = damage), споры по оплате (payment), а также любые случаи, где нужно решение по конкретной машине или деньгам — почти всегда повод передать ${OWNER_NAME} через [[ESCALATE]].`,
  ];
  return lines.filter(Boolean).join('\n');
}

// ── Подсказка для Kimi ───────────────────────────────────────────────
function buildSystemPrompt({ examples, facts, firstTurn, photo = null, photoCaption = '' }) {
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

  const photoBlock = buildPhotoBlock(photo, photoCaption);

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
    `- Описание присланного фото (если оно есть ниже) — служебное и всегда на русском. Оно НЕ определяет язык ответа: язык бери по тексту клиента, а при отсутствии текста — по языку предыдущих сообщений диалога, по умолчанию русский.`,
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
    `- В истории диалога могут встречаться служебные пометки о вложениях: [Фото], [Голосовое сообщение], [Видео], [Документ], [Стикер], [Вложение]. Это НЕ текст клиента, а отметка, что он прислал файл. Ты не слышишь аудио и не смотришь видео: если клиент прислал голосовое или видео и вопрос из текста непонятен — вежливо попроси написать текстом или прислать фото. Документы и файлы передавай ${OWNER_NAME}.`,
    ``,
    `КОГДА ПЕРЕДАВАТЬ ЧЕЛОВЕКУ (${OWNER_NAME}):`,
    `- Если нужного факта нет в блоке ФАКТЫ; или клиент недоволен ответом; или просит живого человека/${OWNER_NAME}; или вопрос требует индивидуального решения (особые условия, торг по цене, жалоба, спор, проблема с конкретной машиной/оплатой/документами) — НЕ выдумывай.`,
    `- Тогда: напиши клиенту короткое сообщение (на языке клиента), что передашь вопрос ${OWNER_NAME} и он свяжется, И ОТДЕЛЬНОЙ ПОСЛЕДНЕЙ СТРОКОЙ добавь служебный маркер:`,
    `  [[ESCALATE]] краткая причина на русском`,
    `  Клиент маркер не увидит — его обрабатывает система. Без маркера передача не сработает.`,
  ].join('\n');

  return [head, photoBlock, factsBlock, examplesBlock].filter(Boolean).join('\n\n');
}

// ── Генерация ответа (Kimi) ──────────────────────────────────────────
async function generateReply(systemPrompt, history) {
  const messages = [{ role: 'system', content: systemPrompt }, ...history];
  const res = await kimi.chat.completions.create(
    {
      model: KIMI_MODEL,
      messages,
      max_tokens: KIMI_MAX_TOKENS,
    },
    { timeout: KIMI_TIMEOUT_MS },
  );
  return { text: (res.choices[0]?.message?.content || '').trim(), usage: res.usage || {} };
}

// Стоимость одного ответа в токенах и долларах.
// Vision-вызов тарифицируется по тем же ценам, что и обычный: изображение —
// это входные токены. Без их учёта costOf занижает расходы.
function costOf({
  promptTokens = 0,
  completionTokens = 0,
  embedTokens = 0,
  visionPromptTokens = 0,
  visionCompletionTokens = 0,
}) {
  const inTok = promptTokens + visionPromptTokens;
  const outTok = completionTokens + visionCompletionTokens;
  const usd = (inTok * PRICE_IN + outTok * PRICE_OUT + embedTokens * PRICE_EMBED) / 1e6;
  return {
    in: inTok,
    out: outTok,
    embed: embedTokens,
    tokens: inTok + outTok + embedTokens,
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
  VISION_MODEL,
  VISION_MAX_IMAGES,
  embed,
  retrieveContext,
  describeImages,
  buildPhotoQuery,
  buildPhotoBlock,
  photoHistoryText,
  buildSystemPrompt,
  generateReply,
  parseEscalation,
  costOf,
};