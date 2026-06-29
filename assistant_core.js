// assistant_core.js — единый пайплайн обработки входящего сообщения,
// общий для всех каналов (сайт, Telegram, WhatsApp).
//
// Логика одна на всех:
//   1. найти/создать диалог, сохранить сообщение пользователя
//   2. если включён режим оператора → ИИ молчит (отвечает человек)
//   3. иначе: RAG (факты + стиль) → генерация (Kimi) → разбор эскалации
//   4. сохранить ответ ИИ, при эскалации пометить статус
//
// Никакого HTTP/Telegram/WhatsApp здесь нет — только логика. Отправку
// ответа в нужный канал делает вызывающая сторона.

const agent = require('./agent');
const astore = require('./assistant_store');

const { OWNER_NAME } = agent;

/**
 * @param {object} p
 * @param {'web'|'telegram'|'whatsapp'} p.channel
 * @param {string|number} p.external_id   уникальный id собеседника в канале
 * @param {string} p.message              текст последнего сообщения пользователя
 * @param {object} [p.contact]            {name, email, phone}
 * @param {boolean} [p.is_driver]
 * @param {string}  [p.driver_id]
 * @param {Array}   [p.historyOverride]   готовая история [{role,content}] (для WhatsApp);
 *                                        если не передана — берётся из БД
 * @returns {Promise<{conversation_id:number, reply:string|null, escalate:boolean,
 *                    reason:string, operator_mode:boolean, facts:number, examples:number,
 *                    contact_name:string|null, is_driver:boolean}>}
 */
async function processMessage({
  channel,
  external_id,
  message,
  contact = {},
  is_driver = null,
  driver_id = null,
  historyOverride = null,
}) {
  const text = (message || '').trim();
  if (!text) throw new Error('Пустое сообщение');

  const conv = await astore.getOrCreateConversation({
    channel,
    external_id,
    name: contact.name || null,
    email: contact.email || null,
    phone: contact.phone || null,
    is_driver,
    driver_id,
  });

  // Сообщение пользователя сохраняем всегда — даже в режиме оператора,
  // чтобы человек в админке видел, что написал клиент.
  await astore.saveMessage(conv.id, 'user', text);

  // Оператор забрал чат на себя → ИИ не отвечает.
  if (conv.operator_mode) {
    return {
      conversation_id: conv.id,
      reply: null,
      escalate: false,
      reason: '',
      operator_mode: true,
      facts: 0,
      examples: 0,
      contact_name: conv.contact_name,
      is_driver: conv.is_driver,
    };
  }

  // История для модели: WhatsApp отдаёт свою (из самого мессенджера),
  // остальные каналы строятся из БД.
  const history = historyOverride || (await astore.getHistory(conv.id));
  if (!history.length || history[history.length - 1].role !== 'user') {
    // нечего отвечать (последнее слово не за пользователем)
    return {
      conversation_id: conv.id,
      reply: null,
      escalate: false,
      reason: '',
      operator_mode: false,
      facts: 0,
      examples: 0,
      contact_name: conv.contact_name,
      is_driver: conv.is_driver,
    };
  }

  const lastUser = history[history.length - 1].content;
  const { examples, facts } = await agent.retrieveContext(lastUser);
  const firstTurn = !history.some((m) => m.role === 'assistant');
  const systemPrompt = agent.buildSystemPrompt({ examples, facts, firstTurn });
  const { text: rawReply, usage } = await agent.generateReply(systemPrompt, history);
  const { text: replyText, escalate, reason } = agent.parseEscalation(rawReply);

  const finalText =
    replyText ||
    (escalate ? `Передал ваш вопрос ${OWNER_NAME} — он скоро с вами свяжется.` : '');

  if (finalText) {
    await astore.saveMessage(conv.id, 'assistant', finalText, {
      escalate,
      reason: reason || null,
      facts: facts.length,
      examples: examples.length,
      usage: usage || null,
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
  };
}

module.exports = { processMessage };