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
//
// НОВОЕ: приём фото. Изображения скачиваются из WhatsApp, сжимаются (sharp) и уходят
// в ядро как base64; ядро делает vision-вызов и дальше работает с ТЕКСТОМ описания.
// В историю диалога base64 не попадает никогда.

require('dotenv').config();

const path = require('path');
const express = require('express');
const QRCode = require('qrcode'); // генерация QR как data-URL картинки
const { Client, LocalAuth } = require('whatsapp-web.js');

// sharp — опционально: если пакет не установлен, фото уйдут без сжатия
// (дороже по входным токенам, но работать всё равно будет).
let sharp = null;
try {
  sharp = require('sharp');
} catch (_) {
  console.warn('⚠️  sharp не установлен — фото уйдут в модель без сжатия (дороже). npm i sharp');
}

const store = require('./store'); // старый слой: seen/blocked/escalations
const astore = require('./assistant_store'); // новый слой: диалоги/сообщения
const core = require('./assistant_core'); // общий пайплайн обработки
const { createAssistantRouter } = require('./assistant_routes');
const {
  AGENT_NAME,
  OWNER_NAME,
  VISION_MAX_IMAGES,
} = require('./agent');

const PORT = parseInt(process.env.PORT || process.env.WEB_PORT || '3000', 10);
// Устойчивый парсинг: принимаем true/1/yes/on в любом регистре и с пробелами,
// чтобы не споткнуться о "true" в кавычках, " true" с пробелом или "True".
const AUTO_REPLY = /^(true|1|yes|on)$/i.test(String(process.env.AUTO_REPLY || '').trim());
const DEBOUNCE_MS = parseInt(process.env.DEBOUNCE_MS || '8000', 10);
const ESCALATION_NUMBER = (process.env.ESCALATION_NUMBER || '').replace(/\D/g, '');
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || ''; // секрет для админских эндпоинтов /assistant
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''; // для доставки ответов оператора в Telegram
const WA_WEB_VERSION_URL =
  process.env.WA_WEB_VERSION_URL ||
  'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1038673194-alpha.html';

// ── Настройки фото ─────────────────────────────────────────────────────────
const PHOTO_MAX_SIDE = parseInt(process.env.PHOTO_MAX_SIDE || '1280', 10); // px, длинная сторона
const PHOTO_JPEG_QUALITY = parseInt(process.env.PHOTO_JPEG_QUALITY || '80', 10);
const PHOTO_MAX_BYTES = parseInt(process.env.PHOTO_MAX_BYTES || String(20 * 1024 * 1024), 10);
const PHOTO_RATE_PER_HOUR = parseInt(process.env.PHOTO_RATE_PER_HOUR || '20', 10); // фото/час на номер

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

// Исключения проверяются напрямую в Supabase прямо перед ответом (isBlockedFresh) —
// мгновенно, без задержки кэша. Кэш blockedSet нужен лишь как быстрый ранний отсев
// во входящем обработчике и как запасной вариант, если база недоступна.
let blockedSet = new Set();
async function refreshBlocked() {
  try {
    blockedSet = await store.blockedNumbers();
  } catch (e) {
    console.error('⚠️  Не удалось обновить список исключений:', e.message);
  }
}
// Точная проверка прямо перед ответом: спрашиваем Supabase напрямую (свежий список),
// заодно освежаем кэш. Если база недоступна — откатываемся на кэш, чтобы не зависнуть.
async function isBlockedFresh(number) {
  try {
    const set = await store.blockedNumbers();
    blockedSet = set;
    return set.has(number);
  } catch (e) {
    console.error('⚠️  Проверка исключений не удалась, использую кэш:', e.message);
    return blockedSet.has(number);
  }
}
refreshBlocked();
// Фоновый опрос — лёгкая страховка на случай правок в базе мимо панели (раз в минуту).
setInterval(refreshBlocked, 60000);

// ── Медиа: буфер входящих вложений и лимиты ────────────────────────────────

// chatId -> [Message] — вложения, пришедшие за окно дебаунса.
// Держим сами объекты сообщений: качать медиа будем один раз, в handleChat.
const pendingMedia = new Map();

function pushPendingMedia(chatId, msg) {
  const list = pendingMedia.get(chatId) || [];
  list.push(msg);
  pendingMedia.set(chatId, list);
}

function drainPendingMedia(chatId) {
  const list = pendingMedia.get(chatId) || [];
  pendingMedia.delete(chatId);
  return list;
}

// Текст, пришедший за это окно дебаунса отдельными сообщениями. Нужен, чтобы
// (а) заглушка про голосовое/стикер не проглотила написанный рядом вопрос,
// (б) вопрос, отправленный сразу ПОСЛЕ фото, попал в vision-вызов и в RAG.
const pendingText = new Map(); // chatId -> [строки]
function pushPendingText(chatId, text) {
  const list = pendingText.get(chatId) || [];
  list.push(text);
  pendingText.set(chatId, list);
}
function drainPendingText(chatId) {
  const list = pendingText.get(chatId) || [];
  pendingText.delete(chatId);
  return list;
}

// Текстовый след разобранных фото: chatId -> Map(msgId, trace).
// Без него на СЛЕДУЮЩЕМ сообщении история из WhatsApp вернёт голое «[Фото]»,
// и модель забудет, что именно было на снимке.
const photoTraces = new Map();
const PHOTO_TRACE_KEEP = 20; // сколько следов держим на чат
function rememberPhotoTrace(chatId, msgIds, trace) {
  const map = photoTraces.get(chatId) || new Map();
  msgIds.forEach((id, i) => {
    if (id) map.set(id, i === 0 ? trace : ''); // след кладём на первое фото пачки
  });
  while (map.size > PHOTO_TRACE_KEEP) map.delete(map.keys().next().value);
  photoTraces.set(chatId, map);
}

// Простой счётчик фото на номер в час — защита от альбома на 30 кадров.
const photoRate = new Map(); // number -> { count, resetAt }
function takePhotoQuota(number, want) {
  const now = Date.now();
  const rec = photoRate.get(number);
  if (!rec || now >= rec.resetAt) {
    photoRate.set(number, { count: want, resetAt: now + 3600000 });
    return Math.min(want, PHOTO_RATE_PER_HOUR);
  }
  const left = Math.max(0, PHOTO_RATE_PER_HOUR - rec.count);
  const take = Math.min(want, left);
  rec.count += take;
  return take;
}
// Возврат квоты за картинки, которые так и не удалось скачать/распознать —
// иначе битый файл «съедает» лимит клиента ни за что.
function refundPhotoQuota(number, n) {
  const rec = photoRate.get(number);
  if (rec && n > 0) rec.count = Math.max(0, rec.count - n);
}
// Чистим протухшие счётчики, чтобы Map не рос бесконечно на долгоживущем процессе.
setInterval(() => {
  const now = Date.now();
  for (const [num, rec] of photoRate) if (now >= rec.resetAt) photoRate.delete(num);
}, 3600000).unref?.();

const IMAGE_MIMES = /^image\/(jpeg|jpg|png|gif|webp|bmp|heic|heif)$/i;

// Скачивает вложение и готовит { b64, mime } для vision-вызова.
// Сжатие до PHOTO_MAX_SIDE экономит входные токены в разы, качество разбора не страдает.
// Любая ошибка → null: сбой на фото никогда не должен ронять ответ.
async function prepareImage(msg) {
  try {
    const media = await msg.downloadMedia();
    if (!media || !media.data) return null;

    const mime = (media.mimetype || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_MIMES.test(mime)) {
      console.warn(`⚠️  Формат ${mime || '?'} не поддерживается как изображение — пропускаю`);
      return null;
    }

    const buf = Buffer.from(media.data, 'base64');
    if (buf.length > PHOTO_MAX_BYTES) {
      console.warn(`⚠️  Фото ${Math.round(buf.length / 1024)} КБ — больше лимита, пропускаю`);
      return null;
    }

    if (!sharp) return { b64: media.data, mime };

    try {
      const small = await sharp(buf)
        .rotate() // учесть EXIF-поворот
        .resize({
          width: PHOTO_MAX_SIDE,
          height: PHOTO_MAX_SIDE,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: PHOTO_JPEG_QUALITY })
        .toBuffer();
      return { b64: small.toString('base64'), mime: 'image/jpeg' };
    } catch (e) {
      // Например HEIC без поддержки libheif в сборке sharp — отдаём как есть.
      console.warn('⚠️  Сжатие не удалось, отправляю оригинал:', e.message);
      return { b64: media.data, mime };
    }
  } catch (e) {
    console.error('⚠️  Не удалось скачать вложение:', e.message);
    return null;
  }
}

// Двуязычные заглушки для медиа, которые модель не разбирает.
const MEDIA_NOTICE = {
  voice:
    'Голосовые сообщения я пока не слушаю — напишите, пожалуйста, вопрос текстом, и я сразу отвечу.\n\n' +
    "I can't listen to voice messages yet — please write your question as text and I'll reply right away.",
  video:
    'Видео я пока не разбираю. Пришлите, пожалуйста, фото или опишите ситуацию словами.\n\n' +
    "I can't process video yet. Please send a photo or describe the situation in text.",
  photo_failed:
    'Фото не открылось у меня на стороне. Пришлите, пожалуйста, ещё раз (обычным JPG/PNG) ' +
    'или опишите проблему словами — я помогу.\n\n' +
    "I couldn't open the photo. Please resend it (as a regular JPG/PNG) or describe the issue in text.",
  photo_rate:
    'Фото пришло слишком много подряд — я успел посмотреть не всё. ' +
    'Пришлите, пожалуйста, самые важные кадры чуть позже или опишите ситуацию словами.\n\n' +
    'Too many photos at once — I couldn\'t review them all. Please resend the key ones a bit later ' +
    'or describe the situation in text.',
  document:
    `Получил ваш документ и передаю ${OWNER_NAME} — он посмотрит и свяжется с вами.\n\n` +
    `Got your document, I'm forwarding it to ${OWNER_NAME} — he'll review it and get back to you.`,
};

// ── История чата → сообщения для модели (user/assistant) ───────────────────
// Берётся из самого WhatsApp. skipIds — id сообщений-вложений, которые обрабатываются
// отдельно: их текстовый след добавит ядро (assistant_core), дублировать не нужно.
async function buildHistory(chat, skipIds = new Set()) {
  const raw = await chat.fetchMessages({ limit: 16 });
  const traces = photoTraces.get(chat.id._serialized);
  const turns = [];
  for (const m of raw) {
    const mid = m.id && m.id._serialized;
    if (mid && skipIds.has(mid)) continue;

    let text;
    if (m.type === 'image' && traces && mid && traces.has(mid)) {
      // Фото из прошлых сообщений: подставляем сохранённое описание, а не «[Фото]».
      text = traces.get(mid);
    } else {
      text = (m.body || '').trim();
      if (!text && m.hasMedia) text = mediaPlaceholder(m);
    }
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

function mediaPlaceholder(m) {
  switch (m.type) {
    case 'image':
      return '[Фото]';
    case 'ptt':
    case 'audio':
      return '[Голосовое сообщение]';
    case 'video':
      return '[Видео]';
    case 'document':
      return '[Документ]';
    case 'sticker':
      return '[Стикер]';
    default:
      return '[Вложение]';
  }
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

// Уведомление владельцу о переданном вопросе.
async function notifyOwner(contactName, number, question, reason) {
  if (!ESCALATION_NUMBER) return;
  const notif =
    `🔔 Вопрос от ${contactName} (${number}), на который ИИ не ответил:\n` +
    `«${question}»\nПричина: ${reason || '—'}`;
  try {
    await client.sendMessage(`${ESCALATION_NUMBER}@c.us`, notif);
    console.log(`   ↪️ уведомление отправлено ${OWNER_NAME}`);
  } catch (e) {
    console.error('   ⚠️ уведомление не ушло:', e.message);
  }
}

async function handleChat(chat) {
  const chatId = chat.id._serialized;
  const number = chatId.replace(/@.*$/, '');
  const contactName = chat.name || 'клиент';

  // Вложения этого окна дебаунса забираем в любом случае — иначе они «протухнут»
  // в буфере и всплывут при следующем сообщении.
  const media = drainPendingMedia(chatId);
  const windowText = drainPendingText(chatId); // текст, набранный в этом же окне

  // Точная проверка прямо перед ответом — напрямую в Supabase (мгновенно, без задержки кэша).
  // Закрывает и окно дебаунса: номер мог попасть в исключения, пока висел таймер.
  if (await isBlockedFresh(number)) {
    console.log(`⛔ ${contactName} — в исключениях, не отвечаю`);
    return;
  }

  const photoMsgs = media.filter((m) => m.type === 'image');
  const otherMedia = media.filter((m) => m.type !== 'image');

  // Подписи к не-фото вложениям тоже считаем текстом клиента.
  const otherCaptions = otherMedia.map((m) => (m.body || '').trim()).filter(Boolean);
  const hadText = windowText.length > 0 || otherCaptions.length > 0;

  // Документ всегда передаём человеку — даже если клиент дописал текст рядом.
  const hasDocument = otherMedia.some((m) => m.type === 'document');
  let docEscalated = false;
  if (hasDocument) {
    const q = otherCaptions.join(' ') || 'Клиент прислал документ';
    await store.addEscalation(number, contactName, q, 'Документ от клиента — нужен человек');
    if (AUTO_REPLY) await notifyOwner(contactName, number, q, 'Документ от клиента');
    docEscalated = true;
  }

  // ── Медиа, которые модель не разбирает: отвечаем детерминированно, без вызовов ИИ.
  // Если рядом пришёл обычный текст — заглушку НЕ шлём: пусть ИИ ответит на вопрос,
  // а про вложение он знает из служебной пометки в истории ([Голосовое сообщение] и т.п.).
  if (!photoMsgs.length && otherMedia.length && !hadText) {
    const kind = hasDocument
      ? 'document'
      : otherMedia.some((m) => m.type === 'video')
        ? 'video'
        : otherMedia.some((m) => m.type === 'ptt' || m.type === 'audio')
          ? 'voice'
          : null;

    // Стикеры и прочая мелочь — молча игнорируем, если больше ничего не пришло.
    if (!kind) return;

    const notice = MEDIA_NOTICE[kind];
    console.log('\n────────────────────────────────────');
    console.log(`👤 ${contactName}: [${kind}]`);
    console.log(`🤖 ${AGENT_NAME}: ${notice.split('\n')[0]}`);

    if (AUTO_REPLY) {
      await chat.sendStateTyping();
      await chat.sendMessage(notice);
      console.log('   ✅ отправлено');
    } else {
      console.log('   📝 AUTO_REPLY=false — не отправлено (режим теста)');
    }
    return;
  }

  // ── Фото: скачиваем, сжимаем, отдаём ядру.
  let images = [];
  const skipIds = new Set();
  let quotaExceeded = false;

  if (photoMsgs.length) {
    const allowed = takePhotoQuota(number, Math.min(photoMsgs.length, VISION_MAX_IMAGES));
    quotaExceeded = allowed < photoMsgs.length;
    if (quotaExceeded) {
      console.warn(
        `⚠️  ${contactName}: прислано ${photoMsgs.length} фото, беру ${allowed} (лимит ${PHOTO_RATE_PER_HOUR}/час)`,
      );
    }
    const take = photoMsgs.slice(0, allowed);
    // Все сообщения-фото исключаем из истории: их заменит текстовый след из ядра.
    for (const m of photoMsgs) if (m.id && m.id._serialized) skipIds.add(m.id._serialized);

    const prepared = await Promise.all(take.map(prepareImage));
    images = prepared.filter(Boolean);
    // Квоту за нескачавшиеся/битые картинки возвращаем.
    refundPhotoQuota(number, take.length - images.length);

    // Ни одной картинки не осталось: либо исчерпан лимит, либо все не скачались /
    // не того формата. Отвечаем короткой заглушкой, ИИ не дёргаем.
    if (!images.length) {
      const notice = allowed === 0 ? MEDIA_NOTICE.photo_rate : MEDIA_NOTICE.photo_failed;
      console.log('\n────────────────────────────────────');
      console.log(`👤 ${contactName}: [фото · ${photoMsgs.length} шт., ни одно не обработано]`);
      console.log(`🤖 ${AGENT_NAME}: ${notice.split('\n')[0]}`);
      if (AUTO_REPLY) {
        await chat.sendStateTyping();
        await chat.sendMessage(notice);
        console.log('   ✅ отправлено');
      } else {
        console.log('   📝 AUTO_REPLY=false — не отправлено (режим теста)');
      }
      return;
    }
  }

  const history = await buildHistory(chat, skipIds);

  // Подпись к фото: в whatsapp-web.js это body самого сообщения с картинкой.
  // Плюс текст, набранный отдельными сообщениями в этом же окне дебаунса —
  // клиент часто шлёт фото, а вопрос дописывает следующим сообщением.
  const caption = [
    ...photoMsgs.map((m) => (m.body || '').trim()),
    ...(images.length ? windowText : []),
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 1000);

  // Без фото работаем по-старому: отвечаем, только если последнее слово за клиентом.
  if (!images.length) {
    if (!history.length || history[history.length - 1].role !== 'user') return;
  }

  const lastUser = images.length
    ? caption || '[Фото]'
    : history[history.length - 1].content;

  const replySuffix = quotaExceeded
    ? 'P.S. Посмотрел не все фото — их пришло слишком много подряд. ' +
      'Если что-то важное осталось, пришлите отдельно чуть позже.'
    : '';

  // Через общее ядро: оно сохранит переписку в БД, учтёт режим оператора,
  // при наличии фото сделает vision-вызов, прогонит RAG+Kimi и вернёт ответ.
  const result = await core.processMessage({
    channel: 'whatsapp',
    external_id: number,
    message: lastUser,
    contact: { name: contactName },
    historyOverride: history,
    images: images.length ? images : null,
    photoCaption: images.length ? caption : null,
    replySuffix,
  });

  // Запоминаем текстовый след, чтобы на следующем сообщении история не потеряла,
  // что было на фото.
  if (result.photo && photoMsgs.length) {
    rememberPhotoTrace(
      chatId,
      photoMsgs.map((m) => m.id && m.id._serialized),
      result.user_text,
    );
  }

  // Оператор забрал этот чат на себя → ИИ молчит.
  if (result.operator_mode) {
    console.log(`✋ ${contactName} — режим оператора, ИИ не отвечает`);
    return;
  }

  const finalText = result.reply; // суффикс про лимит фото ядро уже приклеило
  if (!finalText) {
    console.log(`(пустой ответ для «${contactName}», пропускаю)`);
    return;
  }

  console.log('\n────────────────────────────────────');
  console.log(`👤 ${contactName}: ${result.user_text}`);
  console.log(`🤖 ${AGENT_NAME}: ${finalText}`);
  console.log(`   фактов: ${result.facts} · примеров стиля: ${result.examples}`);
  if (result.photo) {
    console.log(
      `   📷 фото: ${images.length} шт. · категория: ${result.photo.category} · ` +
        `описание: ${(result.photo.description || '').length} симв.`,
    );
  }
  if (result.cost) {
    console.log(
      `   💰 in ${result.cost.in} / out ${result.cost.out} / embed ${result.cost.embed} · ` +
        `$${result.cost.usd.toFixed(5)}`,
    );
  }
  if (result.escalate) console.log(`   🔔 эскалация → ${OWNER_NAME}: ${result.reason || '—'}`);

  // docEscalated: документ уже передан выше — второй раз не дублируем.
  if (result.escalate && !docEscalated) {
    await store.addEscalation(number, contactName, result.user_text, result.reason);
  }

  if (AUTO_REPLY) {
    await chat.sendStateTyping();
    await chat.sendMessage(finalText);
    console.log('   ✅ отправлено');
    if (result.escalate && !docEscalated) {
      await notifyOwner(contactName, number, result.user_text, result.reason);
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
  console.log(`✅ Бот готов. AUTO_REPLY=${AUTO_REPLY ? 'ON' : 'OFF'} (получено из env: ${JSON.stringify(process.env.AUTO_REPLY)})`);
  console.log(`📷 Фото: ${sharp ? 'sharp есть' : 'sharp НЕТ (без сжатия)'} · до ${VISION_MAX_IMAGES} шт./сообщение · ${PHOTO_RATE_PER_HOUR}/час на номер`);
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

// Запоминаем настоящий id чата (@c.us или @lid), чтобы ответ оператора уходил именно туда.
const waChatIds = new Map(); // digits -> полный _serialized id

client.on('message', async (msg) => {
  try {
    if (msg.from === 'status@broadcast') return;
    const chat = await msg.getChat();
    if (chat.isGroup) return;

    const number = chat.id._serialized.replace(/@.*$/, '');
    waChatIds.set(number, chat.id._serialized);
    store.recordContact(number, chat.name).catch(() => {});

    if (blockedSet.has(number)) {
      console.log(`⛔ ${chat.name || number} — в исключениях, не отвечаю`);
      return;
    }

    // Вложения складываем в буфер: скачаем их один раз, когда отработает дебаунс.
    if (msg.hasMedia) pushPendingMedia(chat.id._serialized, msg);
    else if ((msg.body || '').trim()) pushPendingText(chat.id._serialized, msg.body.trim());

    scheduleReply(chat);
  } catch (e) {
    console.error('Ошибка в обработчике message:', e);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  Отправители для ответов оператора (используются роутером /assistant)
// ═══════════════════════════════════════════════════════════════════════════

// WhatsApp: шлём напрямую через клиент в этом же процессе.
// Важно: у контакта может быть id вида @lid (а не телефон @c.us). Поэтому сначала берём
// настоящий id чата, запомненный из входящего сообщения; если его нет — пробуем определить
// по номеру через getNumberId, и лишь в крайнем случае клеим @c.us.
async function sendWhatsApp(number, text) {
  const raw = String(number || '');
  let chatId = raw.includes('@') ? raw : waChatIds.get(raw.replace(/\D/g, '')) || null;
  if (!chatId) {
    const digits = raw.replace(/\D/g, '');
    try {
      const nid = await client.getNumberId(digits);
      if (nid && nid._serialized) chatId = nid._serialized;
    } catch (e) {
      /* getNumberId может не сработать для @lid — игнорируем */
    }
    if (!chatId) chatId = `${digits}@c.us`;
  }
  await client.sendMessage(chatId, text);
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
// Лимит поднят: через /assistant/chat может прилетать фото в base64 с сайта.
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '25mb' }));
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
    // При изменении исключений из админки сразу освежаем кэш (без ожидания фонового цикла).
    onBlockedChange: refreshBlocked,
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
// Поддерживает images: [{b64, mime}] — тогда сначала делается vision-разбор.
app.post('/api/chat', async (req, res) => {
  try {
    const {
      retrieveContext,
      buildSystemPrompt,
      generateReply,
      parseEscalation,
      costOf,
      describeImages,
      buildPhotoQuery,
      photoHistoryText,
    } = require('./agent');

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

    const images = (Array.isArray(req.body && req.body.images) ? req.body.images : []).filter(
      (i) => i && i.b64 && i.mime,
    );

    if (!images.length && (!turns.length || turns[turns.length - 1].role !== 'user')) {
      return res.status(400).json({ error: 'Нет сообщения пользователя' });
    }

    const caption =
      turns.length && turns[turns.length - 1].role === 'user' && images.length
        ? turns[turns.length - 1].content
        : '';

    let photo = null;
    if (images.length) {
      photo = await describeImages(images, caption);
      const trace = photoHistoryText(photo, caption);
      if (turns.length && turns[turns.length - 1].role === 'user') {
        turns[turns.length - 1] = { role: 'user', content: trace };
      } else {
        turns.push({ role: 'user', content: trace });
      }
    }

    const lastUser = turns[turns.length - 1].content;
    const query = photo ? buildPhotoQuery(photo, caption) : lastUser;
    const { examples, facts, embedTokens } = await retrieveContext(query);
    const firstTurn = !turns.some((m) => m.role === 'assistant');
    const { text: raw, usage } = await generateReply(
      buildSystemPrompt({ examples, facts, firstTurn, photo, photoCaption: caption }),
      turns,
    );
    const { text, escalate, reason } = parseEscalation(raw);
    const reply =
      text || (escalate ? `Передал ваш вопрос ${OWNER_NAME} — он скоро с вами свяжется.` : '…');

    if (escalate) await store.addEscalation(null, 'Веб-чат (тест)', lastUser, reason);

    const visionUsage = (photo && photo.usage) || {};
    const cost = costOf({
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      embedTokens,
      visionPromptTokens: visionUsage.prompt_tokens,
      visionCompletionTokens: visionUsage.completion_tokens,
    });
    res.json({
      reply,
      escalated: escalate,
      reason,
      facts: facts.length,
      examples: examples.length,
      photo: photo ? { category: photo.category, description: photo.description } : null,
      usage: cost,
    });
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
  try {
    const { number, name } = req.body || {};
    const result = await store.addBlocked(number, name);
    await refreshBlocked(); // применяем сразу, не ждём 15-секундный цикл
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/blocked/:id', async (req, res) => {
  try {
    await store.removeBlocked(req.params.id);
    await refreshBlocked();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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