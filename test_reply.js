// Тест «мозга» бота без WhatsApp: вводишь сообщение как клиент —
// скрипт ищет факты и примеры в Supabase и показывает, что ответил бы Kimi.
//
//   node test_reply.js "Здравствуйте, у вас есть свободные авто на выходные?"
//   node test_reply.js            ← интерактивный режим (диалог в терминале)

require('dotenv').config();

const readline = require('readline');
const {
  AGENT_NAME,
  KIMI_MODEL,
  retrieveContext,
  buildSystemPrompt,
  generateReply,
  parseEscalation,
} = require('./agent');

async function answerOnce(history) {
  const lastUser = history[history.length - 1].content;
  const { examples, facts } = await retrieveContext(lastUser);
  const raw = await generateReply(buildSystemPrompt({ examples, facts }), history);
  const { text, escalate, reason } = parseEscalation(raw);
  const shown = text || (escalate ? '(передаю вопрос Антону)' : '');
  console.log(`🤖 ${AGENT_NAME} (Kimi): ${shown}`);
  if (escalate) console.log(`   🔔 эскалация → Антон: ${reason || '—'}`);
  console.log(`   фактов: ${facts.length} · примеров стиля: ${examples.length}\n`);
  return text || shown;
}

function ask(rl, q) {
  return new Promise((resolve) => rl.question(q, resolve));
}

async function interactive() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history = []; // копит диалог, как реальная переписка
  console.log(`Интерактивный тест (модель: ${KIMI_MODEL}). Пиши как клиент. "exit" — выход.\n`);
  for (;;) {
    const text = (await ask(rl, '👤 Клиент: ')).trim();
    if (!text) continue;
    if (['exit', 'quit', 'выход'].includes(text.toLowerCase())) break;
    history.push({ role: 'user', content: text });
    const reply = await answerOnce(history);
    history.push({ role: 'assistant', content: reply });
  }
  rl.close();
}

const argText = process.argv.slice(2).join(' ').trim();
const run = argText ? answerOnce([{ role: 'user', content: argText }]) : interactive();
run.catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
