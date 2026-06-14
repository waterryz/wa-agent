// Веб-панель управления исключениями: http://localhost:3000
//   node web.js

require('dotenv').config();

const path = require('path');
const express = require('express');
const store = require('./store');
const {
  OWNER_NAME,
  retrieveContext,
  buildSystemPrompt,
  generateReply,
  parseEscalation,
} = require('./agent');

// Railway задаёт PORT сам; локально — WEB_PORT или 3000
const PORT = parseInt(process.env.PORT || process.env.WEB_PORT || '3000', 10);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Чат с Alex (тест без WhatsApp): принимает историю диалога, отдаёт ответ
app.post('/api/chat', async (req, res) => {
  try {
    const turns = (Array.isArray(req.body && req.body.messages) ? req.body.messages : [])
      .filter(
        (m) =>
          m &&
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string' &&
          m.content.trim(),
      )
      .map((m) => ({ role: m.role, content: m.content.trim() }));
    while (turns.length && turns[0].role === 'assistant') turns.shift();
    if (!turns.length || turns[turns.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'Нет сообщения пользователя' });
    }

    const lastUser = turns[turns.length - 1].content;
    const { examples, facts } = await retrieveContext(lastUser);
    const firstTurn = !turns.some((m) => m.role === 'assistant');
    const raw = await generateReply(buildSystemPrompt({ examples, facts, firstTurn }), turns);
    const { text, escalate, reason } = parseEscalation(raw);
    const reply =
      text || (escalate ? `Передал ваш вопрос ${OWNER_NAME} — он скоро с вами свяжется.` : '…');

    if (escalate) await store.addEscalation(null, 'Веб-чат', lastUser, reason);

    res.json({ reply, escalated: escalate, reason, facts: facts.length, examples: examples.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// список контактов, которые недавно писали (для выбора)
app.get('/api/seen', async (req, res) => {
  try {
    res.json(await store.listSeen());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// текущие исключения
app.get('/api/blocked', async (req, res) => {
  try {
    res.json(await store.listBlocked());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// добавить исключение { number, name }
app.post('/api/blocked', async (req, res) => {
  try {
    const { number, name } = req.body || {};
    res.json(await store.addBlocked(number, name));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// убрать исключение
app.delete('/api/blocked/:id', async (req, res) => {
  try {
    await store.removeBlocked(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// переданные человеку вопросы
app.get('/api/escalations', async (req, res) => {
  try {
    res.json(await store.listEscalations());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// отметить вопрос решённым
app.post('/api/escalations/:id/resolve', async (req, res) => {
  try {
    await store.resolveEscalation(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`🌐 Панель исключений: http://localhost:${PORT}`);
});
