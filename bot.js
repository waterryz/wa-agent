require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const {
  AGENT_NAME,
  OWNER_NAME,
  retrieveContext,
  buildSystemPrompt,
  generateReply,
  parseEscalation,
} = require('./agent');
const store = require('./store');

const AUTO_REPLY = process.env.AUTO_REPLY === 'true';

// Кэш исключений (кому бот не отвечает). Обновляется из Supabase раз в 15 сек,
// чтобы изменения из веб-панели подхватывались без перезапуска.
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
const DEBOUNCE_MS = parseInt(process.env.DEBOUNCE_MS || '8000', 10);
// Номер, куда слать уведомления о переданных вопросах (только цифры, с кодом страны)
const ESCALATION_NUMBER = (process.env.ESCALATION_NUMBER || '').replace(/\D/g, '');

// Привязка к версии WhatsApp Web — лечит "Execution context was destroyed"
// (библиотека рассинхронилась с текущей версией WA). Если снова сломается —
// возьми свежий файл из https://github.com/wppconnect-team/wa-version/tree/main/html
// и пропиши ссылку в WA_WEB_VERSION_URL в .env.
const WA_WEB_VERSION_URL =
  process.env.WA_WEB_VERSION_URL ||
  'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1038673194-alpha.html';

// ── История чата → сообщения для модели (user/assistant) ─────────────
async function buildHistory(chat) {
  const raw = await chat.fetchMessages({ limit: 16 });
  const turns = [];
  for (const m of raw) {
    const text = (m.body || '').trim();
    if (!text) continue; // пропускаем медиа и пустые
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

// ── Дебаунс: ждём, пока клиент допишет серию сообщений ───────────────
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
  const history = await buildHistory(chat);
  if (!history.length || history[history.length - 1].role !== 'user') {
    return; // последнее слово не за клиентом — отвечать не на что
  }

  const lastUser = history[history.length - 1].content;
  const contactName = chat.name || 'клиент';

  const { examples, facts } = await retrieveContext(lastUser);
  const systemPrompt = buildSystemPrompt({ examples, facts });
  const rawReply = await generateReply(systemPrompt, history);
  const { text, escalate, reason } = parseEscalation(rawReply);
  const finalText =
    text || (escalate ? `Передал ваш вопрос ${OWNER_NAME} — он скоро с вами свяжется.` : '');

  if (!finalText) {
    console.log(`(пустой ответ Kimi для «${contactName}», пропускаю)`);
    return;
  }

  console.log('\n────────────────────────────────────');
  console.log(`👤 ${contactName}: ${lastUser}`);
  console.log(`🤖 ${AGENT_NAME} (Kimi): ${finalText}`);
  console.log(`   фактов: ${facts.length} · примеров стиля: ${examples.length}`);
  if (escalate) console.log(`   🔔 эскалация → ${OWNER_NAME}: ${reason || '—'}`);

  // записываем переданный вопрос в базу (виден в веб-панели) независимо от режима
  if (escalate) {
    await store.addEscalation(number, contactName, lastUser, reason);
  }

  if (AUTO_REPLY) {
    await chat.sendStateTyping();
    await chat.sendMessage(finalText);
    console.log('   ✅ отправлено');
    if (escalate && ESCALATION_NUMBER) {
      const notif =
        `🔔 Вопрос от ${contactName} (${number}), на который ИИ не ответил:\n` +
        `«${lastUser}»\nПричина: ${reason || '—'}`;
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

// ── WhatsApp клиент ──────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './wa_session' }),
  webVersionCache: { type: 'remote', remotePath: WA_WEB_VERSION_URL },
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    executablePath: process.env.CHROME_PATH || undefined,
  },
});

client.on('qr', (qr) => {
  console.log('Отсканируй QR-код в WhatsApp на телефоне (Настройки → Связанные устройства):');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () =>
  console.log('🔑 Авторизация прошла, сессия сохранена в ./wa_session'),
);
client.on('ready', () =>
  console.log(
    `✅ Бот запущен. AUTO_REPLY=${AUTO_REPLY ? 'ON (отвечает сам)' : 'OFF (только лог)'}`,
  ),
);
client.on('auth_failure', (m) => console.error('❌ Ошибка авторизации:', m));
client.on('disconnected', (r) => console.warn('⚠️  Отключено от WhatsApp:', r));

// 'message' срабатывает только на входящие (не свои) сообщения
client.on('message', async (msg) => {
  try {
    if (msg.from === 'status@broadcast') return; // статусы
    const chat = await msg.getChat();
    if (chat.isGroup) return; // только личные диалоги

    const number = chat.id._serialized.replace(/@.*$/, '');
    store.recordContact(number, chat.name).catch(() => {}); // запоминаем для веб-панели

    if (blockedSet.has(number)) {
      console.log(`⛔ ${chat.name || number} — в исключениях, не отвечаю`);
      return;
    }

    scheduleReply(chat);
  } catch (e) {
    console.error('Ошибка в обработчике message:', e);
  }
});

client.initialize();
