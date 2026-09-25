// kb_collector.js — автосбор фактов из ТГ-группы рассылки в базу знаний.
//
// Вариант B (staging + ручная модерация):
//   сообщение группы
//     → грубый фильтр (длина, команды, болтовня)
//     → LLM-классификатор: «это устойчивый факт о компании?» + нормализация
//     → эмбеддинг + дедуп (match_knowledge): похоже на существующее → UPDATE, иначе ADD
//     → ЧЕРНОВИК в knowledge_staging (status=pending). Прод-таблица knowledge НЕ трогается.
//   Владелец в админке жмёт Принять/Отклонить. Approve применяет add/update
//   через те же примитивы, что и ручной ИИ-редактор (admin_assistant.js).
//
// Читает группу отдельным ботом-сборщиком (TG_KB_BOT_TOKEN), НЕ конфликтуя с
// основным Telegram-ботом (другой токен, свой long-poll getUpdates).
//
// Всё инертно, пока не заданы TG_KB_BOT_TOKEN и TG_KB_CHAT_ID — можно спокойно
// деплоить: без env-переменных воркер просто не стартует.

require('dotenv').config();

const OpenAI = require('openai');
const { supabase } = require('./assistant_store');
const { embed, toolAdd, toolUpdate } = require('./admin_assistant');
const { shortAnswerOptions } = require('./model_options');
const { createDraftNotifier } = require('./draft_notifications');
const draftNotifier = createDraftNotifier({ db: supabase });

// ── Конфиг ───────────────────────────────────────────────────────────
const TG_KB_BOT_TOKEN = (process.env.TG_KB_BOT_TOKEN || '').trim();
// id группы-источника (для супергрупп/каналов вида -100…). Пока пусто — воркер
// работает в «режиме обнаружения»: логирует chat_id всех групп, где он состоит,
// но ничего не стейджит. Пропиши найденный id в TG_KB_CHAT_ID и перезапусти.
const TG_KB_CHAT_ID = (process.env.TG_KB_CHAT_ID || '').trim();

const KIMI_MODEL = process.env.KIMI_MODEL || 'kimi-k2.6';
const KIMI_BASE_URL = process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1';
const kimi = new OpenAI({ apiKey: process.env.MOONSHOT_API_KEY, baseURL: KIMI_BASE_URL, maxRetries: 0, timeout: 15000 });

// Порог, выше которого считаем, что факт уже есть в базе → предлагаем UPDATE.
const DEDUP_SIMILARITY = parseFloat(process.env.KB_DEDUP_SIMILARITY || '0.86');
// 'trusted' — в группе пишут только владелец/менеджеры (мягкий фильтр);
// 'mixed'   — пишут и водители (строгий фильтр).
const GROUP_TRUST = (process.env.KB_GROUP_TRUST || 'trusted').toLowerCase();
const POLL_TIMEOUT = parseInt(process.env.KB_POLL_TIMEOUT || '50', 10); // long-poll, сек
const POLL_TAG = 'kb_collector'; // ключ курсора в tg_poll_state

const TG_API = (m) => `https://api.telegram.org/bot${TG_KB_BOT_TOKEN}/${m}`;

// ── Грубый фильтр: отсекаем очевидный мусор ДО обращения к модели ─────
// Отсеиваем только сообщение, которое ЦЕЛИКОМ является приветствием/подтверждением
// (не префикс!) — иначе потеряем факты вроде «Да, депозит теперь 500». Точный
// набор, а не regex с \b: в JS \b завязан на ASCII \w и с кириллицей не работает.
const CHATTER_SET = new Set([
  'спасибо', 'спасибо большое', 'благодарю', 'ок', 'окей', 'ага', 'угу', 'да', 'нет',
  'хорошо', 'принял', 'принято', 'понял', 'поняла', 'понятно', 'договорились',
  'привет', 'здравствуйте', 'доброе утро', 'добрый день', 'добрый вечер', 'доброй ночи',
  'hi', 'hello', 'thanks', 'thank you', 'ok', 'okay',
]);

function isChatter(text) {
  // снимаем хвостовую пунктуацию/эмодзи и сравниваем всё сообщение целиком
  const s = (text || '')
    .trim()
    .toLowerCase()
    .replace(/[\s!.?,…)(👍🙏❤️😊🤝✅]+$/u, '')
    .trim();
  return CHATTER_SET.has(s);
}

function grobPass(text) {
  const t = (text || '').trim();
  if (t.length < 12) return false; // слишком коротко для факта
  if (/^[/!]/.test(t)) return false; // команды бота
  if (isChatter(t)) return false; // сообщение целиком — приветствие/подтверждение
  const letters = (t.match(/\p{L}/gu) || []).length;
  if (letters < 8) return false; // одни эмодзи/ссылки/цифры без текста
  return true;
}

// Достаём JSON, даже если модель обернула его в ```json … ``` или добавила текст.
function extractJson(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(s);
  } catch {
    /* пробуем вырезать первый сбалансированный объект */
  }
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try {
      return JSON.parse(s.slice(i, j + 1));
    } catch {
      /* не вышло */
    }
  }
  return null;
}

// ── Классификатор + нормализация факта ───────────────────────────────
// Возвращает {is_fact:boolean, fact:string, reason:string}.
async function classify(text, publishedAt = null) {
  const strict = GROUP_TRUST === 'mixed';
  const sys = [
    'Ты — фильтр базы знаний компании Prime Fusion Inc (аренда авто под такси TLC в Нью-Йорке).',
    'На вход — одно сообщение из рабочей группы компании. Реши, содержит ли оно полезное клиентам правило или объявление,',
    'который полезен клиентскому ИИ-помощнику: условия аренды, тарифы и депозиты, правила эксплуатации,',
    'документы и требования, процедуры (выдача/возврат/ДТП/ТО), сроки, контакты, характеристики автомобилей, акции.',
    '',
    'Временные объявления компании (например, закрытие сервиса в определённый день) тоже нужны. Сохраняй даты действия; не превращай их в постоянное правило.',
    publishedAt ? `Дата исходного сообщения: ${publishedAt}. Относительные даты относятся к этому сообщению, а не к будущему вопросу клиента.` : 'Если дата действия неизвестна, не придумывай её.',
    'НЕ факт (is_fact=false): приветствия и благодарности, эмоции, личная разовая логистика («привезу завтра», «буду через час»),',
    'вопросы без ответа, обсуждения и переписка между людьми, личные сообщения, пересланные мемы, статусы оплаты конкретного человека.',
    strict
      ? 'В группе пишут в том числе водители — будь СТРОГИМ: бери только явные фактические утверждения о правилах/условиях компании.'
      : 'В группе пишут только владелец и менеджеры — источник доверенный: бери любое конкретное утверждение об условиях/правилах/процедурах/тарифах, отсекай лишь болтовню и разовую логистику.',
    '',
    'Если это факт — перепиши его как ЧИСТУЮ самостоятельную справочную запись для ИИ:',
    '- без обращений и контекста чата, в настоящем времени, по сути;',
    '- сохрани все конкретные числа, суммы, сроки, названия;',
    '- один факт = один смысл (если в сообщении несколько разных фактов, объедини в один связный абзац).',
    '',
    'Ответь СТРОГО одним JSON-объектом без пояснений: {"is_fact": true|false, "fact": "нормализованный текст или пусто", "reason": "кратко почему"}.',
  ].join('\n');

  const resp = await kimi.chat.completions.create({
    model: KIMI_MODEL,
    ...shortAnswerOptions(KIMI_MODEL),
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: String(text || '') },
    ],
    // kimi-k2.6 — reasoning-модель: токены уходят и на «размышление», и на ответ.
    // Мало → finish_reason:length и пустой content (факт потерян). Детальный промпт
    // раздувает reasoning, поэтому держим большой запас.
    max_tokens: shortAnswerOptions(KIMI_MODEL).thinking ? 1200 : 4096,
    response_format: { type: 'json_object' },
  });

  const raw = (resp.choices[0].message.content || '').trim();
  const parsed = extractJson(raw);
  if (!parsed) {
    // Совсем не разобрали — безопаснее не стейджить, чем занести мусор.
    return { is_fact: false, fact: '', reason: 'классификатор вернул не-JSON' };
  }
  const fact = String(parsed.fact || '').trim();
  const is_fact = parsed.is_fact === true && fact.length >= 12;
  return { is_fact, fact, reason: String(parsed.reason || '').slice(0, 300) };
}

// ── Дедуп + постановка в очередь черновиков ──────────────────────────
async function stageMessage({ chatId, messageId, author, text, publishedAt = null }) {
  const previous = await supabase.from('knowledge_staging').select('*')
    .eq('tg_chat_id', String(chatId)).eq('tg_message_id', messageId).maybeSingle();
  if (previous.error) throw Error('staging read failed');
  if (previous.data?.raw_text === text) return { skipped: 'duplicate_message' };
  if (!previous.data && !grobPass(text)) return { skipped: 'grob' };

  const c = grobPass(text) ? await classify(text, publishedAt) : { is_fact: false, reason: 'short_edit' };
  if (!c.is_fact && !previous.data) return { skipped: 'not_fact', reason: c.reason };

  const fact = c.is_fact ? c.fact : `Изменённая публикация: ${String(text).trim()}`;
  const e = await embed(fact);
  const { data, error } = await supabase.rpc('match_knowledge', {
    query_embedding: e,
    match_threshold: 0.5,
    match_count: 1,
  });
  if (error) throw new Error('match_knowledge: ' + error.message);

  const top = data && data.length ? data[0] : null;
  let action = 'add';
  let target_id = null;
  let target_before = null;
  const similarity = top ? Number(top.similarity) : null;
  if (top && similarity >= DEDUP_SIMILARITY) {
    action = 'update';
    target_id = top.id;
    target_before = top.content;
  }
  if (previous.data?.applied_knowledge_id) {
    // An edit to an approved post proposes replacing that exact fact, not a fuzzy neighbour.
    const existing = await supabase.from('knowledge').select('id,content')
      .eq('id', previous.data.applied_knowledge_id).maybeSingle();
    if (existing.error) throw Error('staging target read failed');
    if (existing.data) { action = 'update'; target_id = existing.data.id; target_before = existing.data.content; }
  }

  // upsert с ignoreDuplicates: повторная обработка того же сообщения не плодит дубли.
  const { data: ins, error: insErr } = await supabase
    .from('knowledge_staging')
    .upsert(
      {
        tg_chat_id: String(chatId),
        tg_message_id: messageId,
        author: author || null,
        raw_text: text,
        proposed_action: action,
        proposed_content: fact,
        target_id,
        target_before,
        similarity,
        status: 'pending',
        reviewed_at: null,
      },
      { onConflict: 'tg_chat_id,tg_message_id' },
    )
    .select('id')
    .maybeSingle();
  if (insErr) throw new Error('staging insert: ' + insErr.message);

  return ins ? { staged: action, id: ins.id, similarity } : { skipped: 'duplicate_message' };
}

// ── Модерация (зовётся из assistant_routes.js) ───────────────────────
async function listStaging({ status = 'pending', limit = 100 } = {}) {
  const { data, error } = await supabase
    .from('knowledge_staging')
    .select('*')
    .eq('status', status)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}

async function countPending() {
  const { count, error } = await supabase
    .from('knowledge_staging')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');
  if (error) throw new Error(error.message);
  return count || 0;
}

// Принять черновик: применить add/update в knowledge (с пересчётом эмбеддинга),
// пометить approved. Возвращает {applied_knowledge_id, action}.
async function approveStaging(id, override) {
  const { data: row, error } = await supabase
    .from('knowledge_staging')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw new Error('черновик не найден: ' + error.message);
  if (row.status !== 'pending') throw new Error('черновик уже обработан: ' + row.status);

  // Админ мог отредактировать текст перед принятием.
  const content = (override && String(override).trim()) || row.proposed_content;

  let appliedId;
  if (row.proposed_action === 'update' && row.target_id) {
    // Целевой факт мог быть удалён вручную — тогда добавляем как новый.
    const { data: exists } = await supabase
      .from('knowledge')
      .select('id')
      .eq('id', row.target_id)
      .maybeSingle();
    if (exists) {
      await toolUpdate(row.target_id, content);
      appliedId = row.target_id;
    } else {
      const added = await toolAdd(content, 'rassylka');
      appliedId = added.id;
    }
  } else {
    const added = await toolAdd(content, 'rassylka');
    appliedId = added.id;
  }

  const { error: updErr } = await supabase
    .from('knowledge_staging')
    .update({ status: 'approved', applied_knowledge_id: appliedId, reviewed_at: new Date().toISOString() })
    .eq('id', id);
  if (updErr) throw new Error(updErr.message);

  return { applied_knowledge_id: appliedId, action: row.proposed_action };
}

async function rejectStaging(id) {
  const { data: row, error } = await supabase
    .from('knowledge_staging')
    .select('status')
    .eq('id', id)
    .single();
  if (error) throw new Error('черновик не найден: ' + error.message);
  if (row.status !== 'pending') throw new Error('черновик уже обработан: ' + row.status);
  const { error: updErr } = await supabase
    .from('knowledge_staging')
    .update({ status: 'rejected', reviewed_at: new Date().toISOString() })
    .eq('id', id);
  if (updErr) throw new Error(updErr.message);
  return { ok: true };
}

// ── Курсор long-poll ─────────────────────────────────────────────────
async function getOffset() {
  const { data } = await supabase
    .from('tg_poll_state')
    .select('last_update_id')
    .eq('bot', POLL_TAG)
    .maybeSingle();
  return data ? Number(data.last_update_id) : 0;
}

async function setOffset(id) {
  const { error } = await supabase
    .from('tg_poll_state')
    .upsert({ bot: POLL_TAG, last_update_id: id, updated_at: new Date().toISOString() }, { onConflict: 'bot' });
  if (error) throw Error('collector offset save failed');
}

async function tgGetUpdates(offset) {
  const r = await fetch(TG_API('getUpdates'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      offset,
      timeout: POLL_TIMEOUT,
      allowed_updates: ['message', 'channel_post', 'edited_message', 'edited_channel_post'],
    }),
  });
  const data = await r.json();
  if (!data.ok) throw new Error('getUpdates: ' + (data.description || r.status));
  return data.result || [];
}

// ── Основной цикл ────────────────────────────────────────────────────
let running = false;

async function pollLoop() {
  let offset = (await getOffset()) + 0;
  let nextOffset = offset ? offset + 1 : 0; // getUpdates: подтверждаем прошлые
  console.log(`📥 kb_collector: старт long-poll (offset=${nextOffset}, trust=${GROUP_TRUST})`);
  if (!TG_KB_CHAT_ID) {
    console.log('ℹ️  TG_KB_CHAT_ID не задан — режим обнаружения: логирую chat_id групп, ничего не стейджу.');
  }

  while (running) {
    try { await draftNotifier.flush(); }
    catch { console.error('⚠️ Черновик сохранён; уведомление в админ-канал будет повторено.'); }
    let updates;
    try {
      updates = await tgGetUpdates(nextOffset);
    } catch (e) {
      console.error('⚠️  getUpdates:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    for (const u of updates) {
      nextOffset = u.update_id + 1;
      const m = u.message || u.channel_post || u.edited_message || u.edited_channel_post;
      if (!m || !m.chat) continue;

      const chatId = m.chat.id;
      const text = m.text || m.caption || '';

      // Режим обнаружения: помогаем найти нужный chat_id. Кроме лога — пишем в БД
      // (tg_poll_state, ключ discovered:<id>, id в last_update_id), чтобы chat_id
      // можно было прочитать без доступа к логам Railway.
      if (!TG_KB_CHAT_ID) {
        const title = m.chat.title || m.chat.username || '—';
        console.log(`🔎 сообщение из chat_id=${chatId} title="${title}"`);
        try {
          await supabase.from('tg_poll_state').upsert(
            { bot: `discovered:${chatId}`, last_update_id: chatId, updated_at: new Date().toISOString() },
            { onConflict: 'bot' },
          );
        } catch (e) {
          console.error('⚠️  не удалось записать discovered chat:', e.message);
        }
        continue;
      }
      if (String(chatId) !== String(TG_KB_CHAT_ID)) continue;
      if (!text.trim()) continue;

      const author =
        (m.from && [m.from.first_name, m.from.last_name].filter(Boolean).join(' ')) ||
        (m.author_signature || m.sender_chat?.title) ||
        null;

      try {
        const publishedAt = m.date ? new Date(m.date * 1000).toLocaleString('en-CA', { timeZone: 'America/New_York' }) + ' America/New_York' : null;
        const res = await stageMessage({ chatId, messageId: m.message_id, author, text, publishedAt });
        if (res.staged) {
          console.log(`✅ черновик #${res.id} (${res.staged}, sim=${res.similarity ?? '—'}): ${text.slice(0, 70)}`);
        } else {
          console.log(`   ⏭️  пропуск (${res.skipped}${res.reason ? ': ' + res.reason : ''})`);
        }
      } catch (e) {
        console.error('⚠️  обработка сообщения:', e.message);
        // Do not acknowledge a post that was not saved. The next poll retries
        // this update; earlier successful posts are deduplicated before any AI call.
        nextOffset = u.update_id;
        break;
      }
    }

    // Сохраняем курсор ПОСЛЕ обработки пачки, чтобы при падении переобработать её.
    if (updates.length) {
      try {
        await setOffset(nextOffset - 1);
      } catch (e) {
        console.error('⚠️  setOffset:', e.message);
      }
    }
  }
}

// Запуск воркера. Безопасно вызывать всегда: без TG_KB_BOT_TOKEN — no-op.
function startCollector() {
  if (!TG_KB_BOT_TOKEN) {
    console.log('ℹ️  kb_collector выключен (TG_KB_BOT_TOKEN не задан).');
    return false;
  }
  if (running) return true;
  running = true;
  pollLoop().catch((e) => {
    running = false;
    console.error('❌ kb_collector остановлен:', e.message);
  });
  return true;
}

function stopCollector() {
  running = false;
}

module.exports = {
  startCollector,
  stopCollector,
  stageMessage,
  classify,
  grobPass,
  listStaging,
  countPending,
  approveStaging,
  rejectStaging,
};

// Автономный запуск: `node kb_collector.js`
if (require.main === module) {
  if (!startCollector()) process.exit(0);
}
