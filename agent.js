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
const KNOW_TOP_K = parseInt(process.env.KNOW_TOP_K || '6', 10);
const KNOW_MIN_SIM = parseFloat(process.env.KNOW_MIN_SIMILARITY || '0.25');

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
  return res.data[0].embedding;
}

// ── RAG: факты (knowledge) + стиль (conversations) одним эмбеддингом ──
async function retrieveContext(text) {
  let examples = [];
  let facts = [];
  try {
    const embedding = await embed(text);
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
  return { examples, facts };
}

// ── Подсказка для Kimi ───────────────────────────────────────────────
function buildSystemPrompt({ examples, facts }) {
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
    `- В начале нового диалога коротко представься (например: «Здравствуйте! Я ${AGENT_NAME}, ИИ-помощник Prime Fusion. Чем могу помочь?»), если это уместно.`,
    ``,
    `КАК ОТВЕЧАТЬ:`,
    `- Коротко и по-человечески, как в мессенджере, без официально-роботного стиля.`,
    `- По фактам (цены, условия, сервис, инспекции, договор) опирайся на блок ФАКТЫ ниже.`,
    `- Тон и формулировки бери из блока ПРИМЕРЫ — это реальные ответы ${OWNER_NAME} (владельца). Перенимай манеру, но говори от себя как ${AGENT_NAME}, не выдавая себя за ${OWNER_NAME}.`,
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
  return (res.choices[0]?.message?.content || '').trim();
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
};
