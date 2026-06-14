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
const KIMI_MAX_TOKENS = parseInt(process.env.KIMI_MAX_TOKENS || '4096', 10);
const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';
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

// ── RAG: факты (knowledge) + стиль (conversations) одним эмбеддингом ──
async function retrieveContext(text) {
  let examples = [];
  let facts = [];
  let embedTokens = 0;
  try {
    const { embedding, tokens } = await embed(text);
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
    else facts = know.data || [];
  } catch (e) {
    console.error('⚠️  Ошибка RAG:', e.message);
  }
  return { examples, facts, embedTokens };
}

// ── Подсказка для Kimi ───────────────────────────────────────────────
function buildSystemPrompt({ examples, facts, firstTurn }) {
  const factsBlock = facts.length
    ? `ФАКТЫ О КОМПАНИИ Prime Fusion (опирайся только на них, не выдумывай):\n\n` +
      facts.map((f) => `• ${f.content}`).join('\n\n')
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
    `КАК ОТВЕЧАТЬ:`,
    `- Коротко и по-человечески, как в мессенджере, без официально-роботного стиля.`,
    `- По фактам (цены, условия, сервис, инспекции, договор) опирайся на блок ФАКТЫ ниже.`,
    `- Если ответ ЕСТЬ в блоке ФАКТЫ — дай его сразу, уверенно и конкретно (с числами и деталями). НЕ говори «уточню», «не знаю точно», «у всех по-разному» и НЕ передавай ${OWNER_NAME} то, что уже есть в ФАКТАХ.`,
    `- Если в ФАКТАХ есть конкретные цены, тарифы или цифры — ОБЯЗАТЕЛЬНО назови их, даже если рядом есть оговорка, что цена «согласуется индивидуально» или «не фиксируется в договоре». Эта оговорка значит лишь, что итог можно скорректировать. Никогда не говори, что у компании «нет тарифов/планов/фиксированных цен» — базовые тарифы есть всегда, назови их, а не отправляй к ${OWNER_NAME}.`,
    `- НЕ выдумывай условия, скидки, исключения, цифры или обещания, которых нет в блоке ФАКТЫ.`,
    `- Из блока ПРИМЕРЫ бери ТОЛЬКО тон и манеру речи ${OWNER_NAME}. НЕ переноси из примеров конкретные факты, цифры, условия и обещания — вся фактическая информация только из блока ФАКТЫ. Если чего-то нет в ФАКТЫ — не утверждай это, даже если похожее встречается в ПРИМЕРАХ. Говори от себя как ${AGENT_NAME}, не выдавая себя за ${OWNER_NAME}.`,
    `- Выдавай только текст сообщения, без кавычек и префиксов.`,
    ``,
    `КОГДА ПЕРЕДАВАТЬ ЧЕЛОВЕКУ (${OWNER_NAME}):`,
    `- Если нужного факта нет в блоке ФАКТЫ; или клиент недоволен ответом; или просит живого человека/${OWNER_NAME}; или вопрос требует индивидуального решения (особые условия, торг по цене, жалоба, спор, проблема с конкретной машиной/оплатой/документами) — НЕ выдумывай.`,
    `- Тогда: напиши клиенту короткое сообщение, что передашь вопрос ${OWNER_NAME} и он свяжется, И ОТДЕЛЬНОЙ ПОСЛЕДНЕЙ СТРОКОЙ добавь служебный маркер:`,
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
