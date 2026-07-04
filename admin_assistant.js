// admin_assistant.js
// Админский ИИ-редактор базы знаний. С ним общается ВЛАДЕЛЕЦ через админку.
// Он на естественном языке просит «поменяй/добавь/убери факт», модель через
// инструменты ищет нужный факт в таблице knowledge и правит его (с пересчётом
// эмбеддинга), затем отчитывается, что изменено.
//
// ВАЖНО по безопасности: этот модуль работает ТОЛЬКО с текстом, который админ
// сам вводит в чат админки (эндпоинт под ADMIN_API_KEY). Сообщения клиентов и
// «переданные вопросы» сюда НЕ попадают — поэтому клиент не может через эскалацию
// заставить ИИ что-либо изменить в базе.

require('dotenv').config();

const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

const KIMI_MODEL = process.env.KIMI_MODEL || 'kimi-k2.6';
const KIMI_BASE_URL = process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1';
const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';

const kimi = new OpenAI({ apiKey: process.env.MOONSHOT_API_KEY, baseURL: KIMI_BASE_URL });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function embed(text) {
  const res = await openai.embeddings.create({ model: EMBED_MODEL, input: text });
  return res.data[0].embedding;
}

// ── Инструменты для модели (OpenAI/Moonshot function calling) ──
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description:
        'Найти факты в базе знаний по смыслу. ОБЯЗАТЕЛЬНО вызывай перед изменением или удалением, чтобы получить точный id нужного факта. Возвращает массив {id, source, content, similarity}.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Что ищем, своими словами' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_knowledge',
      description: 'Добавить новый факт в базу знаний.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Полный текст нового факта' },
          source: {
            type: 'string',
            description: 'Источник/категория, напр. brochure.md. Если не указан — admin.',
          },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_knowledge',
      description: 'Изменить существующий факт по id (id брать из search_knowledge).',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'id факта из search_knowledge' },
          content: { type: 'string', description: 'Новый ПОЛНЫЙ текст факта (не добавка)' },
        },
        required: ['id', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_knowledge',
      description:
        'Удалить факт по id (id брать из search_knowledge). Только когда администратор явно просит удалить.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'integer', description: 'id факта из search_knowledge' } },
        required: ['id'],
      },
    },
  },
];

async function toolSearch(query) {
  const e = await embed(String(query || ''));
  const { data, error } = await supabase.rpc('match_knowledge', {
    query_embedding: e,
    match_threshold: 0.15,
    match_count: 10,
  });
  if (error) throw new Error(error.message);
  return (data || []).map((r) => ({
    id: r.id,
    source: r.source,
    content: r.content,
    similarity: r.similarity != null ? Number(Number(r.similarity).toFixed(3)) : null,
  }));
}

async function toolAdd(content, source) {
  const text = String(content || '').trim();
  if (!text) throw new Error('content пустой');
  const e = await embed(text);
  const { data, error } = await supabase
    .from('knowledge')
    .insert({ content: text, source: source || 'admin', embedding: e })
    .select('id, content, source')
    .single();
  if (error) throw new Error(error.message);
  return { id: data.id, content: data.content, source: data.source };
}

async function toolUpdate(id, content) {
  const text = String(content || '').trim();
  if (!id) throw new Error('id не указан');
  if (!text) throw new Error('content пустой');
  const { data: prev } = await supabase.from('knowledge').select('content').eq('id', id).single();
  const e = await embed(text);
  const { error } = await supabase.from('knowledge').update({ content: text, embedding: e }).eq('id', id);
  if (error) throw new Error(error.message);
  return { id, before: prev ? prev.content : null, after: text };
}

async function toolDelete(id) {
  if (!id) throw new Error('id не указан');
  const { data: prev } = await supabase.from('knowledge').select('content').eq('id', id).single();
  const { error } = await supabase.from('knowledge').delete().eq('id', id);
  if (error) throw new Error(error.message);
  return { id, deleted: prev ? prev.content : true };
}

const SYSTEM_PROMPT = [
  'Ты — внутренний ассистент-редактор базы знаний компании Prime Fusion. С тобой общается АДМИНИСТРАТОР (владелец), а не клиент.',
  'Твоя задача — по просьбе администратора находить и изменять факты в базе знаний с помощью инструментов. База знаний — это факты, на которые опирается клиентский ИИ-помощник, когда отвечает людям.',
  '',
  'ПРАВИЛА:',
  '- Прежде чем изменить или удалить факт, ОБЯЗАТЕЛЬНО вызови search_knowledge, чтобы найти нужный факт и его id. Никогда не выдумывай id.',
  '- Для изменения используй update_knowledge и передавай ПОЛНЫЙ новый текст факта, а не «добавку».',
  '- Для нового факта — add_knowledge. Удаляй (delete_knowledge) только по явной просьбе удалить.',
  '- Если по запросу ничего не нашлось или неясно, какой именно факт править — не гадай: переспроси у администратора или предложи добавить новый факт.',
  '- Меняй только то, о чём просят. За один запрос — только запрошенное действие.',
  '- Формулируй факты чётко и лаконично, как справочные записи для ИИ-помощника, отвечающего клиентам.',
  '- После внесения изменений кратко отчитайся на русском: что именно добавлено/изменено/удалено (укажи id и суть). Не выводи размышления — только результат и, при необходимости, уточняющий вопрос.',
].join('\n');

/**
 * Прогон одного сообщения администратора через агентский цикл.
 * @param {string} userMessage
 * @param {Array<{role:'user'|'assistant', content:string}>} history — прошлые реплики этого чата
 * @returns {Promise<{reply:string, changes:Array}>}
 */
async function adminChat(userMessage, history = []) {
  const cleanHistory = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-16)
    .map((m) => ({ role: m.role, content: m.content }));

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...cleanHistory,
    { role: 'user', content: String(userMessage || '') },
  ];

  const changes = [];

  // До 15 кругов «модель ↔ инструменты» — хватает на списки из нескольких пунктов.
  for (let step = 0; step < 15; step++) {
    const resp = await kimi.chat.completions.create({
      model: KIMI_MODEL,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      max_tokens: 4096,
    });
    const msg = resp.choices[0].message;

    // Кладём ответ ассистента обратно чистым объектом (без служебных полей SDK).
    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls });

    const calls = msg.tool_calls || [];
    if (calls.length === 0) {
      return { reply: (msg.content || '').trim(), changes };
    }

    for (const tc of calls) {
      const name = tc.function && tc.function.name;
      let args = {};
      try {
        args = JSON.parse((tc.function && tc.function.arguments) || '{}');
      } catch (e) {
        args = {};
      }
      let result;
      try {
        if (name === 'search_knowledge') {
          result = await toolSearch(args.query);
        } else if (name === 'add_knowledge') {
          result = await toolAdd(args.content, args.source);
          changes.push({ action: 'add', id: result.id, content: result.content });
        } else if (name === 'update_knowledge') {
          result = await toolUpdate(args.id, args.content);
          changes.push({ action: 'update', id: result.id, content: result.after });
        } else if (name === 'delete_knowledge') {
          result = await toolDelete(args.id);
          changes.push({ action: 'delete', id: result.id });
        } else {
          result = { error: 'unknown tool ' + name };
        }
      } catch (e) {
        result = { error: e.message };
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }

  // Круги кончились — просим модель дать финальный текстовый ответ БЕЗ инструментов,
  // чтобы вместо «—» пришёл нормальный отчёт о том, что уже сделано.
  try {
    messages.push({
      role: 'user',
      content:
        'Заверши: кратко на русском отчитайся, что уже сделано (какие факты добавлены/изменены/удалены), ' +
        'и если что-то осталось незавершённым — скажи, что попросить отдельным сообщением. Без вызова инструментов.',
    });
    const final = await kimi.chat.completions.create({
      model: KIMI_MODEL,
      messages,
      tool_choice: 'none',
      max_tokens: 1024,
    });
    const text = (final.choices[0].message.content || '').trim();
    return { reply: text || 'Готово. Проверь список изменений ниже.', changes };
  } catch (e) {
    return {
      reply:
        changes.length > 0
          ? 'Часть изменений внесена (см. список ниже). Если что-то осталось — пришли отдельным сообщением.'
          : 'Не удалось завершить за отведённое число шагов — попробуй переформулировать или разбить на части.',
      changes,
    };
  }
}

module.exports = { adminChat };