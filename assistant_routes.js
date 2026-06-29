// assistant_routes.js — HTTP-интерфейс общего ядра ИИ-ассистента.
// Монтируется в server.js:  app.use('/assistant', createAssistantRouter({...}))
//
// Публичные эндпоинты (зовут сайт и бот):
//   POST /assistant/chat               — отправить сообщение, получить ответ ИИ
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
const core = require('./assistant_core');
const astore = require('./assistant_store');

/**
 * @param {object} deps
 * @param {function} [deps.sendTelegram]  async (chatId, text) => отправить в Telegram
 * @param {function} [deps.sendWhatsApp]  async (number, text) => отправить в WhatsApp
 * @param {function} [deps.onEscalation]  async ({channel,external_id,name,question,reason}) — лог эскалации (для совместимости со старой панелью)
 * @param {string}   [deps.adminKey]      секрет для админских эндпоинтов
 */
function createAssistantRouter(deps = {}) {
  const { sendTelegram, sendWhatsApp, onEscalation, adminKey } = deps;
  const router = express.Router();
  router.use(express.json());

  // ── защита админских маршрутов ──
  function requireAdmin(req, res, next) {
    if (!adminKey) return next(); // ключ не задан → не проверяем (локальная разработка)
    const key = req.get('x-admin-key') || req.query.key;
    if (key !== adminKey) return res.status(401).json({ error: 'Доступ запрещён' });
    next();
  }

  // ───────────────────────── ПУБЛИЧНЫЕ ─────────────────────────

  // Главная точка: сайт и бот шлют сюда сообщение пользователя.
  router.post('/chat', async (req, res) => {
    try {
      const b = req.body || {};
      const channel = b.channel;
      const external_id = b.external_id;
      const message = b.message;
      if (!['web', 'telegram', 'whatsapp'].includes(channel)) {
        return res.status(400).json({ error: 'Некорректный channel' });
      }
      if (!external_id || !message || !String(message).trim()) {
        return res.status(400).json({ error: 'Нужны external_id и message' });
      }

      const result = await core.processMessage({
        channel,
        external_id,
        message,
        contact: { name: b.name || null, email: b.email || null, phone: b.phone || null },
        is_driver: typeof b.is_driver === 'boolean' ? b.is_driver : null,
        driver_id: b.driver_id || null,
      });

      // Эскалацию дублируем в старую панель «Переданные вопросы», если задан хук.
      if (result.escalate && typeof onEscalation === 'function') {
        onEscalation({
          channel,
          external_id,
          name: result.contact_name || b.name || null,
          question: message,
          reason: result.reason,
        }).catch(() => {});
      }

      res.json({
        conversation_id: result.conversation_id,
        reply: result.reply,
        operator_mode: result.operator_mode,
        escalated: result.escalate,
        is_driver: result.is_driver,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Поллинг новых ответов (ИИ + оператор) для веб-чата.
  router.get('/conversations/:id/poll', async (req, res) => {
    try {
      const after = parseInt(req.query.after || '0', 10) || 0;
      const conv = await astore.getConversation(req.params.id);
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
      await astore.markAdminRead(req.params.id); // открыли → прочитано
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

  return router;
}

module.exports = { createAssistantRouter };