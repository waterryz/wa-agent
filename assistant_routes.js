// assistant_routes.js — HTTP-интерфейс общего ядра ИИ-ассистента.
// Монтируется в server.js:  app.use('/assistant', createAssistantRouter({...}))
//
// Публичные эндпоинты (зовут сайт и бот):
//   POST /assistant/chat               — отправить сообщение (текст и/или фото), получить ответ ИИ
//   POST /assistant/vision             — только разбор фото, без RAG и без ответа клиенту
//   GET  /assistant/conversations/:id/poll?after=<id>  — новые ответы (для веб-чата)
//
// Админские эндпоинты (нужен заголовок x-admin-key, если задан ADMIN_API_KEY):
//   GET  /assistant/conversations                  — список диалогов
//   GET  /assistant/conversations/:id              — диалог + полная история
//   POST /assistant/conversations/:id/reply        — ответ оператора {content}
//   POST /assistant/conversations/:id/operator-mode {on:true|false}
//   POST /assistant/conversations/:id/status        {status:'active'|'closed'...}
//   POST /assistant/conversations/:id/read          — отметить прочитанным

const express = require('express');
const { createHttpAuth, SESSION_SECONDS } = require('./http_auth');
const { createWebDigestSource } = require('./web_digest');
const { mountBilling } = require('./service_billing');
const core = require('./assistant_core');
const astore = require('./assistant_store');
const agent = require('./agent');
const store = require('./store'); // старый слой: seen / blocked / escalations (для админки)
const adminAssistant = require('./admin_assistant'); // ИИ-редактор базы знаний (админский чат)
const kbCollector = require('./kb_collector'); // сбор фактов из ТГ-рассылки + модерация черновиков

// Лимит на одну картинку в base64. Важно, чтобы VISION_MAX_IMAGES × этот лимит
// укладывался в лимит тела запроса (JSON_BODY_LIMIT в server.js, по умолчанию
// 25 МБ), иначе express вернёт 413 HTML — а клиент ждёт JSON и не разберёт ответ.
// 4 × 5 МБ = 20 МБ < 25 МБ. Клиенты (bot.py, сайт) жмут до ~1280px и шлют ~150 КБ.
const MAX_IMAGE_B64_BYTES = parseInt(process.env.MAX_IMAGE_B64_BYTES || String(5 * 1024 * 1024), 10);
const ALLOWED_IMAGE_MIMES = /^image\/(jpeg|jpg|png|gif|webp|bmp|heic|heif)$/i;

/**
 * Проверяет и нормализует массив картинок из тела запроса.
 * Возвращает { images, dropped, error }. Неверный формат — явная ошибка клиенту,
 * а не тихое «фото не вижу»; лишние сверх лимита считаются в dropped.
 */
function parseImages(raw) {
  if (raw == null) return { images: [], dropped: 0, error: null };
  if (!Array.isArray(raw)) return { images: [], dropped: 0, error: 'images должен быть массивом' };

  const images = [];
  const dropped = Math.max(0, raw.length - agent.VISION_MAX_IMAGES);
  for (const item of raw.slice(0, agent.VISION_MAX_IMAGES)) {
    if (!item || typeof item !== 'object') continue;
    // Сайт может прислать b64 вместе с префиксом data:image/jpeg;base64,...
    // Если его не снять, в запрос к модели уедет двойной префикс и мусор.
    const b64 = (typeof item.b64 === 'string' ? item.b64 : '').replace(/^data:[^,]*,/, '');
    const mime = String(item.mime || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!b64 || !mime) return { images: [], dropped: 0, error: 'у каждой картинки нужны b64 и mime' };
    if (!ALLOWED_IMAGE_MIMES.test(mime)) {
      return { images: [], dropped: 0, error: `формат ${mime} не поддерживается` };
    }
    if (b64.length > MAX_IMAGE_B64_BYTES) {
      return { images: [], dropped: 0, error: 'картинка слишком большая — сожмите перед отправкой' };
    }
    images.push({ b64, mime });
  }
  return { images, dropped, error: null };
}

/**
 * @param {object} deps
 * @param {function} [deps.sendTelegram]  async (chatId, text) => отправить в Telegram
 * @param {function} [deps.sendWhatsApp]  async (number, text) => отправить в WhatsApp
 * @param {function} [deps.onEscalation]  async ({channel,external_id,name,question,reason}) — лог эскалации (для совместимости со старой панелью)
 * @param {function} [deps.onBlockedChange] async () => вызывается после изменения списка исключений (освежить кэш)
 * @param {string}   [deps.adminKey]      секрет для админских эндпоинтов
 * @param {boolean}  [deps.readOnlyAdmin] skip implicit admin writes in preview GET/HEAD requests
 */
function createAssistantRouter(deps = {}) {
  const { sendTelegram, sendWhatsApp, onEscalation, onBlockedChange, adminKey } = deps;
  const router = express.Router();
  const auth = createHttpAuth(adminKey);
  const requireAdmin = auth.requireAdmin;
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  // Тело уже разобрано глобальным express.json() в server.js (лимит JSON_BODY_LIMIT,
  // по умолчанию 25mb — под фото в base64). Второй парсер здесь не нужен: body-parser
  // видит req._body и всё равно пропустил бы запрос, создавая ложное впечатление,
  // что у роутера свой лимит. Строка ниже — на случай монтирования роутера в другое
  // приложение без глобального парсера.
  router.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '25mb' }));
  mountBilling(router, requireAdmin, { supabase: astore.supabase });

  // ── защита админских маршрутов ──
  // Missing configuration never opens administrator access. Keys in URLs are
  // deliberately unsupported (URLs can enter history and proxy logs).

  router.get('/reports/web-messages', requireAdmin, async (req, res) => {
    try {
      const source = createWebDigestSource(astore.supabase, {
        coverageStart: process.env.ASSISTANT_DIGEST_COVERAGE_START || '',
      });
      res.json(await source.readWindow(req.query.start, req.query.end));
    } catch (error) {
      res.status(error.status === 400 ? 400 : 503).json({
        error: error.status === 400 ? 'invalid_report_period' : 'web_report_unavailable',
      });
    }
  });

  // ───────────────────────── ПУБЛИЧНЫЕ ─────────────────────────

  router.post('/session', (req, res) => {
    const token = auth.issueSession();
    if (!token) return res.status(503).json({ error: 'Chat access is not configured' });
    res.json({ token, expires_in: SESSION_SECONDS });
  });

  router.get('/capabilities', (req, res) => {
    if (!adminKey || req.get('x-admin-key') !== adminKey) return res.status(401).json({ error: 'Unauthorized' });
    res.json({ version: '2026-09-24', fast_answers: true, service_categories: true, voice: false });
  });

  // Главная точка: сайт и бот шлют сюда сообщение пользователя.
  // Поддерживает фото: images: [{b64, mime}] + необязательный photo_caption.
  router.post('/chat', async (req, res) => {
    try {
      const b = req.body || {};
      const channel = b.channel;
      let external_id = b.external_id;
      const message = b.message;
      const trusted = auth.isAdmin(req);
      if (['telegram', 'whatsapp'].includes(channel) && !trusted) return res.status(401).json({ error: 'Unauthorized' });
      if (channel === 'web' && !trusted) {
        const session = auth.readSession(req.get('x-web-session'));
        if (!session) return res.status(401).json({ error: 'Invalid chat session' });
        external_id = session.external_id;
      }
      const faqTopic = trusted && typeof b.faq_topic === 'string' ? b.faq_topic : null;
      if (!['web', 'telegram', 'whatsapp'].includes(channel)) {
        return res.status(400).json({ error: 'Некорректный channel' });
      }

      const { images, dropped, error: imgError } = parseImages(b.images);
      if (imgError) return res.status(400).json({ error: imgError });

      if (!external_id) return res.status(400).json({ error: 'Нужен external_id' });
      // Фото без подписи — валидный случай: текст не обязателен, если есть картинка.
      if (!images.length && !faqTopic && (!message || !String(message).trim())) {
        return res.status(400).json({ error: 'Нужен message или images' });
      }

      const photoCaption =
        b.photo_caption !== undefined ? b.photo_caption : b.photoCaption;

      const result = await core.processMessage({
        channel,
        external_id,
        message,
        faqTopic,
        language: ['ru', 'en', 'ka'].includes(b.language) ? b.language : null,
        context: trusted ? b.context : null,
        contact: { name: b.name || null, email: b.email || null, phone: b.phone || null },
        is_driver: trusted && typeof b.is_driver === 'boolean' ? b.is_driver : null,
        driver_id: trusted ? b.driver_id || null : null,
        images: images.length ? images : null,
        photoCaption: images.length ? photoCaption ?? null : null,
        // Клиент прислал больше картинок, чем мы разбираем за раз — говорим об этом
        // прямо в ответе, иначе он решит, что ассистент посмотрел все.
        replySuffix: dropped
          ? `P.S. Посмотрел первые ${images.length} фото из ${images.length + dropped} — ` +
            `остальные пришлите отдельным сообщением, если они важны.`
          : trusted ? String(b.reply_suffix || '') : '',
      });

      // Эскалацию дублируем в старую панель «Переданные вопросы», если задан хук.
      // В question отдаём user_text: для фото это текстовый след с описанием,
      // иначе в панели была бы пустая строка или голое «[Фото]».
      if (result.escalate && typeof onEscalation === 'function') {
        onEscalation({
          channel,
          external_id,
          name: result.contact_name || b.name || null,
          question: result.user_text || message,
          reason: result.reason,
        }).catch(() => {});
      }

      res.json({
        conversation_id: result.conversation_id,
        reply: result.reply,
        operator_mode: result.operator_mode,
        escalated: result.escalate,
        is_driver: result.is_driver,
        fast_answer: Boolean(result.fast_answer),
        action: result.action || null,
        // Для логов и отладки на стороне бота. base64 сюда не возвращается.
        photo: result.photo
          ? { category: result.photo.category, description: result.photo.description }
          : null,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Fail closed: a missing admin key must not expose a paid audio endpoint.
  router.post('/transcribe', async (req, res) => {
    // Owner cancelled voice. Keep shared OpenAI credentials used for embeddings.
    res.status(410).json({ error: 'voice_disabled' });
  });

  // Только «глаза»: разбирает фото и возвращает структуру. Ни RAG, ни ответа
  // клиенту, ни записи в БД. Используется сервисным меню Telegram-бота, где нужно
  // вытащить пробег/чек/работы, а не поговорить с клиентом.
  //   body: { images: [{b64, mime}], mode: 'service' | 'client', caption?: string }
  // ПОД АДМИН-КЛЮЧОМ: эндпоинт напрямую жжёт vision-токены и не привязан к диалогу,
  // поэтому открытым его держать нельзя. bot.py шлёт заголовок x-admin-key.
  router.post('/vision', requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const { images, error: imgError } = parseImages(b.images);
      if (imgError) return res.status(400).json({ error: imgError });
      if (!images.length) return res.status(400).json({ error: 'Нужны images' });

      const mode = b.mode === 'client' ? 'client' : 'service';
      const out =
        mode === 'client'
          ? await agent.describeImages(images, String(b.caption || ''))
          : await agent.describeServicePhotos(images);

      const usage = out.usage || {};
      const cost = agent.costOf({
        visionPromptTokens: usage.prompt_tokens,
        visionCompletionTokens: usage.completion_tokens,
      });
      const { usage: _drop, ...data } = out;
      res.json({ mode, ...data, cost });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Поллинг новых ответов (ИИ + оператор) для веб-чата.
  router.get('/conversations/:id/poll', async (req, res) => {
    try {
      const trusted = auth.isAdmin(req);
      const session = trusted ? null : auth.readSession(req.get('x-web-session'));
      if (!trusted && !session) return res.status(401).json({ error: 'Unauthorized' });
      const id = Number(req.params.id);
      const after = Number(req.query.after || '0');
      if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(after) || after < 0) {
        return res.status(400).json({ error: 'Invalid message cursor' });
      }
      const conv = await astore.getConversation(req.params.id);
      if (!conv || (!trusted && (conv.channel !== 'web' || conv.external_id !== session.external_id))) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      const replies = await astore.getRepliesSince(req.params.id, after);
      res.json({
        operator_mode: conv.operator_mode,
        status: conv.status,
        messages: replies.map((m) => ({
          id: m.id,
          role: m.role, // assistant | operator
          content: m.content,
          created_at: m.created_at,
        })),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ───────────────────────── АДМИНСКИЕ ─────────────────────────

  router.get('/conversations', requireAdmin, async (req, res) => {
    try {
      const list = await astore.listConversations({
        channel: req.query.channel || null,
        status: req.query.status || null,
        limit: parseInt(req.query.limit || '100', 10),
      });
      res.json(list);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/conversations/:id', requireAdmin, async (req, res) => {
    try {
      const conv = await astore.getConversation(req.params.id);
      const messages = await astore.getMessages(req.params.id);
      // The preview shares storage with production. Merely viewing a conversation
      // must not consume the owner's unread queue (including implicit HEADs).
      if (!deps.readOnlyAdmin) await astore.markAdminRead(req.params.id);
      res.json({ conversation: conv, messages });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Ответ живого оператора. По умолчанию автоматически включает режим оператора,
  // чтобы ИИ не перебивал. Доставляем в нужный канал; для web клиент заберёт поллингом.
  router.post('/conversations/:id/reply', requireAdmin, async (req, res) => {
    try {
      const content = (req.body && req.body.content || '').trim();
      if (!content) return res.status(400).json({ error: 'Пустой ответ' });
      const takeover = req.body.takeover !== false; // по умолчанию true

      const conv = await astore.getConversation(req.params.id);
      await astore.saveMessage(conv.id, 'operator', content);
      if (takeover && !conv.operator_mode) await astore.setOperatorMode(conv.id, true);

      // Доставка в исходный канал
      try {
        if (conv.channel === 'telegram' && typeof sendTelegram === 'function') {
          await sendTelegram(conv.external_id, content);
        } else if (conv.channel === 'whatsapp' && typeof sendWhatsApp === 'function') {
          await sendWhatsApp(conv.external_id, content);
        }
        // web: ничего не делаем — браузер заберёт через /poll
      } catch (sendErr) {
        return res.status(502).json({ error: 'Сообщение сохранено, но не доставлено: ' + sendErr.message });
      }

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/conversations/:id/operator-mode', requireAdmin, async (req, res) => {
    try {
      await astore.setOperatorMode(req.params.id, !!(req.body && req.body.on));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/conversations/:id/status', requireAdmin, async (req, res) => {
    try {
      const status = req.body && req.body.status;
      if (!['active', 'escalated', 'closed'].includes(status)) {
        return res.status(400).json({ error: 'Некорректный status' });
      }
      await astore.setStatus(req.params.id, status);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/conversations/:id/read', requireAdmin, async (req, res) => {
    try {
      await astore.markAdminRead(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ───────────── WhatsApp: исключения и переданные вопросы (для админки) ─────────────
  // Тот же функционал, что старая exceptions.html, но под защитой admin-ключа.

  // Список текущих исключений.
  router.get('/wa/exceptions', requireAdmin, async (req, res) => {
    try { res.json(await store.listBlocked()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Недавние контакты (для выпадающего списка «Добавить из недавних»).
  router.get('/wa/recent', requireAdmin, async (req, res) => {
    try { res.json(await store.listSeen()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Добавить номер в исключения.
  router.post('/wa/exceptions', requireAdmin, async (req, res) => {
    try {
      const { number, name } = req.body || {};
      const row = await store.addBlocked(number, name);
      if (typeof onBlockedChange === 'function') await onBlockedChange();
      res.json(row);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Убрать из исключений.
  router.delete('/wa/exceptions/:id', requireAdmin, async (req, res) => {
    try {
      await store.removeBlocked(req.params.id);
      if (typeof onBlockedChange === 'function') await onBlockedChange();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Переданные человеку вопросы (эскалации).
  router.get('/wa/escalations', requireAdmin, async (req, res) => {
    try { res.json(await store.listEscalations()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Отметить эскалацию решённой.
  router.post('/wa/escalations/:id/resolve', requireAdmin, async (req, res) => {
    try {
      await store.resolveEscalation(req.params.id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ───────────── ИИ-редактор базы знаний (админский чат) ─────────────
  // Работает ТОЛЬКО по тексту, который админ вводит здесь. Клиентские сообщения
  // и эскалации сюда не попадают.
  router.post('/admin-chat', requireAdmin, async (req, res) => {
    try {
      const { message, history } = req.body || {};
      if (!message || !String(message).trim()) {
        return res.status(400).json({ error: 'message пустой' });
      }
      const out = await adminAssistant.adminChat(String(message), Array.isArray(history) ? history : []);
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ───────── Черновики из ТГ-рассылки (модерация базы знаний) ─────────
  // Предложения фактов, собранные из группы. Прод-база knowledge меняется
  // только когда владелец нажимает «Принять» здесь.
  router.get('/kb-staging', requireAdmin, async (req, res) => {
    try {
      const status = ['pending', 'approved', 'rejected'].includes(req.query.status)
        ? req.query.status
        : 'pending';
      const items = await kbCollector.listStaging({ status });
      res.json({ items, pending: await kbCollector.countPending() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/kb-staging/:id/approve', requireAdmin, async (req, res) => {
    try {
      const { content } = req.body || {}; // необязательная правка текста перед принятием
      const out = await kbCollector.approveStaging(req.params.id, content);
      res.json(out);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.post('/kb-staging/:id/reject', requireAdmin, async (req, res) => {
    try {
      const out = await kbCollector.rejectStaging(req.params.id);
      res.json(out);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  return router;
}

module.exports = { createAssistantRouter };
