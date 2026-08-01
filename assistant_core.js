// assistant_core.js — единый пайплайн обработки входящего сообщения,
// общий для всех каналов (сайт, Telegram, WhatsApp).
//
// Логика одна на всех:
//   1. найти/создать диалог
//   2. если пришли изображения — «прочитать» их vision-вызовом и превратить в текст
//   3. сохранить сообщение пользователя (для фото — текстовый след, НЕ base64)
//   4. если включён режим оператора → ИИ молчит (отвечает человек)
//   5. иначе: RAG (факты + стиль) → генерация (Kimi) → разбор эскалации
//   6. сохранить ответ ИИ, при эскалации пометить статус
//
// Никакого HTTP/Telegram/WhatsApp здесь нет — только логика. Отправку
// ответа в нужный канал делает вызывающая сторона.

const agent = require('./agent');
const astore = require('./assistant_store');

const { OWNER_NAME } = agent;

// ── Квота на разбор фото ─────────────────────────────────────────────
// WhatsApp-поток считает лимит у себя (там есть доступ к номеру до вызова ядра),
// а Telegram и сайт ходят прямо сюда — без этой защиты один человек с альбомом
// на 30 кадров заметно ударит по счёту. Счётчик в памяти процесса: при рестарте
// обнуляется, но для защиты от спама этого достаточно.
const PHOTO_RATE_PER_HOUR = parseInt(process.env.PHOTO_RATE_PER_HOUR || '20', 10) || 20;
const photoRate = new Map(); // `${channel}:${external_id}` -> { count, resetAt }

function takePhotoQuota(key, want) {
  const now = Date.now();
  const rec = photoRate.get(key);
  if (!rec || now >= rec.resetAt) {
    const take = Math.min(want, PHOTO_RATE_PER_HOUR);
    photoRate.set(key, { count: take, resetAt: now + 3600000 });
    return take;
  }
  const take = Math.min(want, Math.max(0, PHOTO_RATE_PER_HOUR - rec.count));
  rec.count += take;
  return take;
}

// Чистим протухшие счётчики, чтобы Map не рос бесконечно.
setInterval(() => {
  const now = Date.now();
  for (const [k, rec] of photoRate) if (now >= rec.resetAt) photoRate.delete(k);
}, 3600000).unref?.();

/**
 * @param {object} p
 * @param {'web'|'telegram'|'whatsapp'} p.channel
 * @param {string|number} p.external_id   уникальный id собеседника в канале
 * @param {string} p.message              текст последнего сообщения пользователя
 *                                        (для фото — подпись клиента, может быть пустой)
 * @param {object} [p.contact]            {name, email, phone}
 * @param {boolean} [p.is_driver]
 * @param {string}  [p.driver_id]
 * @param {Array}   [p.historyOverride]   готовая история [{role,content}] (для WhatsApp);
 *                                        если не передана — берётся из БД.
 *                                        ВАЖНО: сообщения-фото в неё включать НЕ нужно —
 *                                        текстовый след добавится сюда автоматически.
 * @param {Array}   [p.images]            сырые изображения [{b64, mime}] — ядро само
 *                                        сделает vision-вызов и превратит их в текст
 * @param {object}  [p.photo]             уже разобранное фото (если vision-вызов сделал
 *                                        вызывающий); имеет приоритет над images
 * @param {string}  [p.photoCaption]      подпись к фото; по умолчанию = message
 * @param {string}  [p.replySuffix]       текст, который дописывается в конец ответа
 *                                        ДО сохранения в БД (например «посмотрел не все фото»)
 * @returns {Promise<{conversation_id:number, reply:string|null, escalate:boolean,
 *                    reason:string, operator_mode:boolean, facts:number, examples:number,
 *                    contact_name:string|null, is_driver:boolean,
 *                    photo:object|null, user_text:string, cost:object}>}
 */
async function processMessage({
  channel,
  external_id,
  message,
  contact = {},
  is_driver = null,
  driver_id = null,
  historyOverride = null,
  images = null,
  photo = null,
  photoCaption = null,
  replySuffix = '',
}) {
  const text = (message || '').trim();
  const imageList = Array.isArray(images) ? images.filter((i) => i && i.b64 && i.mime) : [];
  const hasPhoto = Boolean(photo) || imageList.length > 0;

  if (!text && !hasPhoto) throw new Error('Пустое сообщение');

  const caption = (photoCaption === null ? text : String(photoCaption || '')).trim();

  const conv = await astore.getOrCreateConversation({
    channel,
    external_id,
    name: contact.name || null,
    email: contact.email || null,
    phone: contact.phone || null,
    is_driver,
    driver_id,
  });

  // ── Шаг «глаза»: превращаем картинку в текст.
  // В режиме оператора vision НЕ вызываем: отвечает человек, он и так видит фото
  // в мессенджере, а платить за разбор каждого кадра при спаме незачем.
  let photoData = photo || null;
  let quotaDropped = 0;

  if (!photoData && imageList.length && !conv.operator_mode) {
    const allowed = takePhotoQuota(`${channel}:${external_id}`, imageList.length);
    quotaDropped = imageList.length - allowed;
    if (allowed > 0) {
      photoData = await agent.describeImages(imageList.slice(0, allowed), caption);
    } else {
      console.warn(`⚠️  Лимит фото исчерпан для ${channel}:${external_id} (${PHOTO_RATE_PER_HOUR}/час)`);
    }
  }
  const visionUsage = (photoData && photoData.usage) || {};

  // Текст, который уходит в БД и в историю. КРИТИЧНО: никакого base64 —
  // иначе через пару фото промпт распухнет на мегабайты.
  const userText = photoData
    ? agent.photoHistoryText(photoData, caption)
    : imageList.length
      ? `[Фото${imageList.length > 1 ? ` · ${imageList.length} шт.` : ''}]${caption ? ` ${caption}` : ''}`
      : text;

  // Сообщение пользователя сохраняем всегда — даже в режиме оператора,
  // чтобы человек в админке видел, что написал (или прислал) клиент.
  await astore.saveMessage(conv.id, 'user', userText);

  const emptyResult = (extra = {}) => ({
    conversation_id: conv.id,
    reply: null,
    escalate: false,
    reason: '',
    operator_mode: false,
    facts: 0,
    examples: 0,
    contact_name: conv.contact_name,
    is_driver: conv.is_driver,
    photo: photoData,
    user_text: userText,
    cost: agent.costOf({
      visionPromptTokens: visionUsage.prompt_tokens,
      visionCompletionTokens: visionUsage.completion_tokens,
    }),
    ...extra,
  });

  // Оператор забрал чат на себя → ИИ не отвечает.
  if (conv.operator_mode) return emptyResult({ operator_mode: true });

  // История для модели: WhatsApp отдаёт свою (из самого мессенджера),
  // остальные каналы строятся из БД (там наше сообщение уже сохранено выше).
  const history = historyOverride ? historyOverride.slice() : await astore.getHistory(conv.id);

  // При historyOverride сообщения-фото в неё не попадают (у них пустой body),
  // поэтому текстовый след добавляем сами — иначе модель «не увидит» фото.
  // Условие по hasPhoto, а не по photoData: при исчерпанной квоте описания нет,
  // но пометка «[Фото]» в истории всё равно нужна.
  if (hasPhoto && historyOverride) {
    const last = history[history.length - 1];
    if (last && last.role === 'user') {
      history[history.length - 1] = {
        role: 'user',
        content: `${last.content}\n${userText}`.trim(),
      };
    } else {
      history.push({ role: 'user', content: userText });
    }
  }

  if (!history.length || history[history.length - 1].role !== 'user') {
    // нечего отвечать (последнее слово не за пользователем)
    return emptyResult();
  }

  // Поисковый запрос: для фото — подпись + машинное описание, иначе просто текст.
  // Если разбор фото провалился и подписи нет, запрос был бы пустым: тогда
  // откатываемся на текст последнего хода, чтобы RAG не искал по пустой строке.
  const query =
    (photoData ? agent.buildPhotoQuery(photoData, caption) : '') ||
    history[history.length - 1].content;

  const { examples, facts, embedTokens } = await agent.retrieveContext(query);
  const firstTurn = !history.some((m) => m.role === 'assistant');
  const systemPrompt = agent.buildSystemPrompt({
    examples,
    facts,
    firstTurn,
    photo: photoData,
    photoCaption: caption,
  });
  const { text: rawReply, usage } = await agent.generateReply(systemPrompt, history);
  const { text: replyText, escalate, reason } = agent.parseEscalation(rawReply);

  const baseText =
    replyText ||
    (escalate ? `Передал ваш вопрос ${OWNER_NAME} — он скоро с вами свяжется.` : '');

  // Про отброшенные по лимиту фото клиенту надо сказать честно — иначе он решит,
  // что ассистент посмотрел всё, и не пришлёт важный кадр повторно.
  const dropNote = !quotaDropped
    ? ''
    : photoData
      ? 'P.S. Посмотрел не все фото — их пришло слишком много подряд. ' +
        'Если что-то важное осталось, пришлите отдельно чуть позже.'
      : 'P.S. Фото пока посмотреть не смог — их пришло слишком много подряд. ' +
        'Попробуйте прислать через час или опишите словами.';

  // Суффикс приклеиваем ДО сохранения — иначе в админке оператор увидит не тот
  // текст, который на самом деле получил клиент.
  const suffix = [replySuffix, dropNote].filter(Boolean).join('\n\n');
  const finalText = baseText && suffix ? `${baseText}\n\n${suffix}` : baseText;

  const cost = agent.costOf({
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    embedTokens,
    visionPromptTokens: visionUsage.prompt_tokens,
    visionCompletionTokens: visionUsage.completion_tokens,
  });

  if (finalText) {
    await astore.saveMessage(conv.id, 'assistant', finalText, {
      escalate,
      reason: reason || null,
      facts: facts.length,
      examples: examples.length,
      usage: usage || null,
      vision_usage: photoData ? visionUsage : null,
      photo_category: photoData ? photoData.category : null,
      cost,
    });
  }

  if (escalate) {
    await astore.setStatus(conv.id, 'escalated');
  }

  return {
    conversation_id: conv.id,
    reply: finalText || null,
    escalate,
    reason: reason || '',
    operator_mode: false,
    facts: facts.length,
    examples: examples.length,
    contact_name: conv.contact_name,
    is_driver: conv.is_driver,
    photo: photoData,
    user_text: userText,
    cost,
  };
}

module.exports = { processMessage };