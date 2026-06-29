// server.js — единый процесс для Railway: веб-панель + WhatsApp-бот + QR + ОБЩЕЕ ЯДРО ИИ-ассистента.
// Запуск: node server.js   (npm start)
//
// Зачем объединено: Railway запускает ОДНУ команду (один процесс). web.js и bot.js
// жили отдельно — на Railway мог работать только один. Теперь оба поднимаются вместе,
// QR показывается на /qr.
//
// НОВОЕ: подключено общее ядро ИИ-ассистента (/assistant/*). Через него ходят сайт и
// Telegram-бот, а WhatsApp-поток теперь тоже пишет переписку в общие таблицы, так что
// все чаты видны в админке и оператор может «забрать» любой диалог.

require('dotenv').config();

const path = require('path');
const express = require('express');
const QRCode = require('qrcode'); // генерация QR как data-URL картинки
const { Client, LocalAuth } = require('whatsapp-web.js');

const store = require('./store'); // старый слой: seen/blocked/escalations
const astore = require('./assistant_store'); // новый слой: диалоги/сообщения
const core = require('./assistant_core'); // общий пайплайн обработки
const { createAssistantRouter } = require('./assistant_routes');
const {
  AGENT_NAME,
  OWNER_NAME,
} = require('./agent');

const PORT = parseInt(process.env.PORT || process.env.WEB_PORT || '3000', 10);
const AUTO_REPLY = process.env.AUTO_REPLY === 'true';
const DEBOUNCE_MS = parseInt(process.env.DEBOUNCE_MS || '8000', 10);
const ESCALATION_NUMBER = (process.env.ESCALATION_NUMBER || '').replace(/\D/g, '');
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || ''; // секрет для админских эндпоинтов /assistant
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''; // для доставки ответов оператора в Telegram
const WA_WEB_VERSION_URL =
  process.env.WA_WEB_VERSION_URL ||
  'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1038673194-alpha.html';

// ─────────────────────────────────────────────────────────────────────────
//  Состояние WhatsApp-подключения (для отображения на /qr)
// ─────────────────────────────────────────────────────────────────────────
const waState = {
  status: 'starting', // starting | qr | authenticated | ready | disconnected | auth_failure
  qr: null,
  qrDataUrl: null,
  updatedAt: Date.now(),
};

function setState(patch) {
  Object.assign(waState, patch, { updatedAt: Date.now() });
}

// ═══════════════════════════════════════════════════════════════════════════
//  ЧАСТЬ 1. WhatsApp-бот
// ═══════════════════════════════════════════════════════════════════════════

// Кэш исключений (кому бот не отвечает). Обновляется из Supabase раз в 15 сек.
let blockedSet = new Set();
async function refreshBlocked() {
  try {
    blockedSet = await store.blockedNumbers();
  } catch (e) {
    console.error('⚠️  Не удалось обновить список исключений:', e.message);
  }
}
refreshBlocked();
setInterval(refreshBlocked, 15000);

// История чата → сообщения для модели (user/assistant) — берётся из самого WhatsApp.
async function buildHistory(chat) {
  const raw = await chat.fetchMessages({ limit: 16 });
  const turns = [];
  for (const m of raw) {
    const text = (m.body || '').trim();
    if (!text) continue;
    const role = m.fromMe ? 'assistant' : 'user';
    if (turns.length && turns[turns.length - 1].role === role) {
      turns[turns.length - 1].content += '\n' + text;
    } else {
      turns.push({ role, content: text });
    }
  }
  while (turns.length && turns[0].role === 'assistant') turns.shift();
  return turns;
}

// Дебаунс: ждём, пока клиент допишет серию сообщений
const timers = new Map();
function scheduleReply(chat) {
  const id = chat.id._serialized;
  if (timers.has(id)) clearTimeout(timers.get(id));
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      handleChat(chat).catch((e) => console.error('Ошибка обработки чата:', e));
    }, DEBOUNCE_MS),
  );
}

async function handleChat(chat) {
  const number = chat.id._serialized.replace(/@.*$/, '');

  const history = await buildHistory(chat);
  if (!history.length || history[history.length - 1].role !== 'user') {
    return; // последнее слово не за клиентом
  }

  const lastUser = history[history.length - 1].content;
  const contactName = chat.name || 'клиент';

  // Через общее ядро: оно сохранит переписку в БД, учтёт режим оператора,
  // прогонит RAG+Kimi и вернёт ответ. История берётся из самого WhatsApp.
  const result = await core.processMessage({
    channel: 'whatsapp',
    external_id: number,
    message: lastUser,
    contact: { name: contactName },
    historyOverride: history,
  });

  // Оператор забрал этот чат на себя → ИИ молчит.
  if (result.operator_mode) {
    console.log(`✋ ${contactName} — режим оператора, ИИ не отвечает`);
    return;
  }

  const finalText = result.reply;
  if (!finalText) {
    console.log(`(пустой ответ для «${contactName}», пропускаю)`);
    return;
  }

  console.log('\n────────────────────────────────────');
  console.log(`👤 ${contactName}: ${lastUser}`);
  console.log(`🤖 ${AGENT_NAME}: ${finalText}`);
  console.log(`   фактов: ${result.facts} · примеров стиля: ${result.examples}`);
  if (result.escalate) console.log(`   🔔 эскалация → ${OWNER_NAME}: ${result.reason || '—'}`);

  if (result.escalate) {
    await store.addEscalation(number, contactName, lastUser, result.reason);
  }

  if (AUTO_REPLY) {
    await chat.sendStateTyping();
    await chat.sendMessage(finalText);
    console.log('   ✅ отправлено');
    if (result.escalate && ESCALATION_NUMBER) {
      const notif =
        `🔔 Вопрос от ${contactName} (${number}), на который ИИ не ответил:\n` +
        `«${lastUser}»\nПричина: ${result.reason || '—'}`;
      try {
        await client.sendMessage(`${ESCALATION_NUMBER}@c.us`, notif);
        console.log(`   ↪️ уведомление отправлено ${OWNER_NAME}`);
      } catch (e) {
        console.error('   ⚠️ уведомление не ушло:', e.message);
      }
    }
  } else {
    console.log('   📝 AUTO_REPLY=false — не отправлено (режим теста)');
  }
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: process.env.WA_SESSION_PATH || './wa_session' }),
  webVersionCache: { type: 'remote', remotePath: WA_WEB_VERSION_URL },
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    executablePath:
      process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  },
});

client.on('qr', async (qr) => {
  console.log('📱 Получен QR. Открой /qr в браузере чтобы отсканировать (или смотри ниже).');
  try {
    require('qrcode-terminal').generate(qr, { small: true });
  } catch (_) {}
  try {
    const qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 1 });
    setState({ status: 'qr', qr, qrDataUrl });
  } catch (e) {
    setState({ status: 'qr', qr, qrDataUrl: null });
  }
});

client.on('authenticated', () => {
  console.log('🔑 Авторизация прошла, сессия сохранена.');
  setState({ status: 'authenticated', qr: null, qrDataUrl: null });
});

client.on('ready', () => {
  console.log(`✅ Бот готов. AUTO_REPLY=${AUTO_REPLY ? 'ON' : 'OFF'}`);
  setState({ status: 'ready', qr: null, qrDataUrl: null });
});

client.on('auth_failure', (m) => {
  console.error('❌ Ошибка авторизации:', m);
  setState({ status: 'auth_failure' });
});

client.on('disconnected', (r) => {
  console.warn('⚠️  Отключено от WhatsApp:', r);
  setState({ status: 'disconnected', qr: null, qrDataUrl: null });
  setTimeout(() => client.initialize().catch((e) => console.error('reinit:', e.message)), 5000);
});

client.on('message', async (msg) => {
  try {
    if (msg.from === 'status@broadcast') return;
    const chat = await msg.getChat();
    if (chat.isGroup) return;

    const number = chat.id._serialized.replace(/@.*$/, '');
    store.recordContact(number, chat.name).catch(() => {});

    if (blockedSet.has(number)) {
      console.log(`⛔ ${chat.name || number} — в исключениях, не отвечаю`);
      return;
    }
    scheduleReply(chat);
  } catch (e) {
    console.error('Ошибка в обработчике message:', e);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  Отправители для ответов оператора (используются роутером /assistant)
// ═══════════════════════════════════════════════════════════════════════════

// WhatsApp: шлём напрямую через клиент в этом же процессе.
async function sendWhatsApp(number, text) {
  const digits = String(number).replace(/\D/g, '');
  await client.sendMessage(`${digits}@c.us`, text);
}

// Telegram: бот живёт в отдельном (Python) сервисе, поэтому шлём напрямую через Bot API.
async function sendTelegram(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN не задан — не могу отправить ответ оператора в Telegram');
  }
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const data = await r.json();
  if (!data.ok) throw new Error('Telegram API: ' + (data.description || r.status));
}

// ═══════════════════════════════════════════════════════════════════════════
//  ЧАСТЬ 2. Веб-сервер (панель + QR + ядро ассистента)
// ═══════════════════════════════════════════════════════════════════════════

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Общее ядро ИИ-ассистента: /assistant/chat, /assistant/conversations и т.д.
app.use(
  '/assistant',
  createAssistantRouter({
    sendTelegram,
    sendWhatsApp,
    adminKey: ADMIN_API_KEY,
    // Эскалации из веба/телеграма дублируем в старую панель «Переданные вопросы».
    onEscalation: ({ external_id, name, question, reason }) =>
      store.addEscalation(external_id, name, question, reason),
  }),
);

// ── Страница привязки WhatsApp с QR ────────────────────────────────────────
app.get('/qr', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Привязка WhatsApp · Prime Fusion</title>
<style>
  :root { --bg:#0b0f14; --card:#141b24; --accent:#c8f04c; --text:#e8edf2; --muted:#8a97a6; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg);
         color:var(--text); display:flex; min-height:100vh; align-items:center; justify-content:center; padding:24px; }
  .card { background:var(--card); border-radius:20px; padding:32px; max-width:420px; width:100%;
          text-align:center; box-shadow:0 10px 40px rgba(0,0,0,.4); }
  h1 { font-size:20px; margin:0 0 8px; }
  p { color:var(--muted); font-size:14px; line-height:1.5; margin:8px 0; }
  .qrbox { background:#fff; border-radius:16px; padding:16px; display:inline-block; margin:16px 0; min-height:320px;
           min-width:320px; display:flex; align-items:center; justify-content:center; }
  .qrbox img { display:block; width:288px; height:288px; }
  .status { font-weight:600; padding:8px 16px; border-radius:999px; display:inline-block; font-size:13px; margin-bottom:8px; }
  .s-ready { background:rgba(200,240,76,.15); color:var(--accent); }
  .s-wait { background:rgba(138,151,166,.15); color:var(--muted); }
  .s-err { background:rgba(255,90,90,.15); color:#ff5a5a; }
  .spin { width:32px; height:32px; border:3px solid #2a3540; border-top-color:var(--accent);
          border-radius:50%; animation:r 1s linear infinite; }
  @keyframes r { to { transform:rotate(360deg); } }
  a.panel { display:inline-block; margin-top:16px; color:var(--accent); text-decoration:none; font-size:14px; }
</style></head>
<body>
  <div class="card">
    <h1>Привязка WhatsApp</h1>
    <div id="statusWrap"><span class="status s-wait" id="status">Загрузка…</span></div>
    <div class="qrbox" id="qrbox"><div class="spin"></div></div>
    <p id="hint">На телефоне: <b>WhatsApp → Настройки → Связанные устройства → Привязать устройство</b>, затем отсканируйте код.</p>
    <a class="panel" href="/">← Перейти в панель управления</a>
  </div>
<script>
  async function poll() {
    try {
      const r = await fetch('/api/wa-status'); const d = await r.json();
      const status = document.getElementById('status');
      const qrbox = document.getElementById('qrbox');
      const hint = document.getElementById('hint');
      if (d.status === 'ready') {
        status.className = 'status s-ready'; status.textContent = '✅ Подключено';
        qrbox.innerHTML = '<div style="color:#1a1a1a;font-weight:600;">Телефон привязан</div>';
        hint.textContent = 'Бот работает. Эту страницу можно закрыть.';
      } else if (d.status === 'authenticated') {
        status.className = 'status s-wait'; status.textContent = 'Авторизация…';
        qrbox.innerHTML = '<div class="spin"></div>';
      } else if (d.status === 'qr' && d.qrDataUrl) {
        status.className = 'status s-wait'; status.textContent = 'Ожидание сканирования';
        qrbox.innerHTML = '<img src="' + d.qrDataUrl + '" alt="QR">';
      } else if (d.status === 'auth_failure') {
        status.className = 'status s-err'; status.textContent = '❌ Ошибка авторизации';
      } else if (d.status === 'disconnected') {
        status.className = 'status s-err'; status.textContent = '⚠️ Отключено, переподключаюсь…';
        qrbox.innerHTML = '<div class="spin"></div>';
      } else {
        status.className = 'status s-wait'; status.textContent = 'Запуск…';
        qrbox.innerHTML = '<div class="spin"></div>';
      }
    } catch (e) {
      document.getElementById('status').textContent = 'Нет связи с сервером';
    }
  }
  poll(); setInterval(poll, 2000);
</script>
</body></html>`);
});

// статус WhatsApp (для страницы /qr)
app.get('/api/wa-status', (req, res) => {
  res.json({
    status: waState.status,
    qrDataUrl: waState.status === 'qr' ? waState.qrDataUrl : null,
    autoReply: AUTO_REPLY,
    updatedAt: waState.updatedAt,
  });
});

// ── Чат с Alex (старый тестовый эндпоинт без сохранения — оставлен для совместимости) ──
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

    const { retrieveContext, buildSystemPrompt, generateReply, parseEscalation, costOf } =
      require('./agent');
    const lastUser = turns[turns.length - 1].content;
    const { examples, facts, embedTokens } = await retrieveContext(lastUser);
    const firstTurn = !turns.some((m) => m.role === 'assistant');
    const { text: raw, usage } = await generateReply(
      buildSystemPrompt({ examples, facts, firstTurn }),
      turns,
    );
    const { text, escalate, reason } = parseEscalation(raw);
    const reply =
      text || (escalate ? `Передал ваш вопрос ${OWNER_NAME} — он скоро с вами свяжется.` : '…');

    if (escalate) await store.addEscalation(null, 'Веб-чат (тест)', lastUser, reason);

    const cost = costOf({
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      embedTokens,
    });
    res.json({ reply, escalated: escalate, reason, facts: facts.length, examples: examples.length, usage: cost });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/seen', async (req, res) => {
  try { res.json(await store.listSeen()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/blocked', async (req, res) => {
  try { res.json(await store.listBlocked()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/blocked', async (req, res) => {
  try { const { number, name } = req.body || {}; res.json(await store.addBlocked(number, name)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/blocked/:id', async (req, res) => {
  try { await store.removeBlocked(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/escalations', async (req, res) => {
  try { res.json(await store.listEscalations()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/escalations/:id/resolve', async (req, res) => {
  try { await store.resolveEscalation(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  Запуск
// ═══════════════════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`🌐 Веб-панель:  http://localhost:${PORT}/`);
  console.log(`📱 Привязка WA: http://localhost:${PORT}/qr`);
  console.log(`🤖 Ядро ассистента: POST http://localhost:${PORT}/assistant/chat`);
});

console.log('🚀 Инициализирую WhatsApp...');
client.initialize().catch((e) => {
  console.error('Не удалось инициализировать WhatsApp:', e.message);
  setState({ status: 'auth_failure' });
});