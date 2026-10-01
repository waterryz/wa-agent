const test = require('node:test');
const assert = require('node:assert/strict');

// Client construction is local; this test never makes a network request.
process.env.MOONSHOT_API_KEY ||= 'synthetic-key';
process.env.OPENAI_API_KEY ||= 'synthetic-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'synthetic-key';

const { buildSystemPrompt } = require('./agent');

test('current service policy overrides superseded handbook and chat snippets', () => {
  const prompt = buildSystemPrompt({
    examples: [],
    facts: [
      { content: 'Замена масла каждые 7000 миль.\nСервис KRS Auto Doctor.', priority: false },
      { content: 'Салонный фильтр: каждые 2–3 замены масла.', priority: false },
      { content: 'Планировать примерно после 6 000, выполнить не позднее 7 000 миль.', priority: true },
    ],
    firstTurn: true,
  });
  assert.doesNotMatch(prompt, /масла каждые 7000/);
  assert.doesNotMatch(prompt, /фильтр: каждые 2–3/);
  assert.match(prompt, /Сервис KRS Auto Doctor/);
  assert.match(prompt, /6 000 миль/);
  assert.match(prompt, /не позднее 7 000 миль/);
  assert.match(prompt, /каждой второй замене масла/);
});

test('unknown oil-change count requires checking the service history', () => {
  const prompt = buildSystemPrompt({ examples: [], facts: [], firstTurn: false });
  assert.match(prompt, /Если номер замены неизвестен, сверить историю с компанией/);
  assert.match(prompt, /не считай слова механика подтверждением/);
});

test('deposit answers cannot promise a next-day refund or declare the live site stale', () => {
  const prompt = buildSystemPrompt({ examples: [], facts: [], firstTurn: false });
  assert.match(prompt, /сумма зависит от конкретного подписанного договора/);
  assert.match(prompt, /Не объявляй документы действующего сайта устаревшими без проверки/);
  assert.match(prompt, /Для планового ТО в K, R & S Auto Service запись не нужна/);
  assert.match(prompt, /Если клиент спрашивает, когда вернут депозит: назови общий срок/);
  assert.match(prompt, /Не называй упомянутые клиентом \$1 000 стандартной фиксированной суммой для всех/);
});

test('repair payment disputes are escalated without promises about billing or response time', () => {
  const prompt = buildSystemPrompt({ examples: [], facts: [], firstTurn: false });
  assert.match(prompt, /не подтверждай зачёт/);
  assert.match(prompt, /Не утверждай без проверки, что конкретный счёт сервис выставит напрямую владельцу/);
  assert.match(prompt, /Не обещай, когда и кто свяжется/);
  assert.match(prompt, /\[\[ESCALATE\]\]/);
});
