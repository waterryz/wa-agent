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
  assert.match(prompt, /Не могу подтвердить время ответа; вопрос передан сотруднику/);
  assert.match(prompt, /\[\[ESCALATE\]\]/);
});

test('crash advice does not carry forward superseded instructions', () => {
  const prompt = buildSystemPrompt({
    examples: [],
    facts: [{
      content: [
        'Не нужно звонить Антону сразу.',
        'Если вы не виноваты — не давать другой стороне данные своей страховки.',
        'Если виноваты вы — полицию вызовет другая сторона.',
        'Через **5 дней** сходить в полицейский участок за рапортом.',
        'Выслать все материалы Антону в Telegram.',
        'При ущербе менее $1000 обращаться к страховке нецелесообразно.',
        'Без него страховой клейм открыть нельзя.',
        'Если виноват другой водитель — ущерб покрывает его страховка, ты не платишь ничего.',
        'Если есть пострадавшие — сразу звонить 911.',
      ].join('\n'),
      priority: false,
    }],
    firstTurn: false,
  });
  assert.doesNotMatch(prompt, /не давать другой стороне данные своей страховки/i);
  assert.doesNotMatch(prompt, /полицию вызовет другая сторона/i);
  assert.doesNotMatch(prompt, /через \*\*5 дней\*\*/i);
  assert.doesNotMatch(prompt, /Telegram/);
  assert.doesNotMatch(prompt, /ущербе менее \$1000 обращаться к страховке нецелесообразно/i);
  assert.doesNotMatch(prompt, /без него страховой клейм открыть нельзя/i);
  assert.doesNotMatch(prompt, /ты не платишь ничего/i);
  assert.match(prompt, /Если есть пострадавшие — сразу звонить 911/);
  assert.match(prompt, /водители обмениваются именем, адресом, номером прав, данными регистрации и страховки/);
  assert.match(prompt, /Это не запрет срочно обратиться в компанию/);
  assert.match(prompt, /без перехода в другой мессенджер/);
  assert.match(prompt, /не решай по предполагаемой сумме ущерба/);
  assert.match(prompt, /не утверждай, что он прочитал его/);
});


test('first reply uses respectful Russian and no channel or attachment status is invented', () => {
  const prompt = buildSystemPrompt({ examples: [], facts: [], firstTurn: true });
  assert.match(prompt, /Здравствуйте, я Alex, ИИ-помощник Prime Fusion/);
  assert.doesNotMatch(prompt, /Ты общаешься с клиентами в WhatsApp|текущий WhatsApp-чат/);
  assert.match(prompt, /не хватает фото или бланка/);
  assert.match(prompt, /если тебе не передан подтверждённый статус отчёта/);
  assert.match(prompt, /после 6 800 миль остаётся ровно 200/);
});
