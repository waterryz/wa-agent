const test = require('node:test');
const assert = require('node:assert/strict');

// Local prompt construction only. No model or production data is called.
process.env.MOONSHOT_API_KEY ||= 'synthetic-key';
process.env.OPENAI_API_KEY ||= 'synthetic-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'synthetic-key';

const { buildSystemPrompt } = require('./agent');

test('old service snippets do not override current owner-approved rules', () => {
  const prompt = buildSystemPrompt({
    examples: [],
    facts: [
      { content: 'Замена масла каждые 7000 миль.\nСервис KRS Auto Doctor.', priority: false },
      { content: 'Салонный фильтр: каждые 2–3 замены масла.', priority: false },
    ],
    firstTurn: true,
  });
  assert.doesNotMatch(prompt, /масла каждые 7000/);
  assert.doesNotMatch(prompt, /фильтр: каждые 2–3/);
  assert.match(prompt, /Сервис KRS Auto Doctor/);
  assert.match(prompt, /6 000 миль/);
  assert.match(prompt, /не позднее 7 000/);
  assert.match(prompt, /каждой второй замене масла/);
  assert.match(prompt, /сверить записи с компанией/);
});

test('web assistant keeps correct channel and avoids unsupported promises', () => {
  const prompt = buildSystemPrompt({ examples: [], facts: [], firstTurn: false });
  assert.match(prompt, /в канале, из которого они написали/);
  assert.doesNotMatch(prompt, /в текущий WhatsApp-чат/);
  assert.match(prompt, /на «вы»/);
  assert.match(prompt, /четыре стороны машины и одометр/);
  assert.match(prompt, /в течение 30 дней/);
  assert.match(prompt, /\$1 000 не считай стандартом/);
  assert.match(prompt, /Не обещай, когда и кто ответит/);
  assert.match(prompt, /\[\[ESCALATE\]\]/);
});

test('obsolete crash advice is filtered without suppressing safety advice', () => {
  const prompt = buildSystemPrompt({
    examples: [],
    facts: [{ content: [
      'Не нужно звонить Антону сразу.',
      'Не давать другой стороне данные своей страховки.',
      'При ущербе менее $1000 обращаться к страховке нецелесообразно.',
      'Если есть пострадавшие — сразу звонить 911.',
    ].join('\n'), priority: false }],
    firstTurn: false,
  });
  assert.doesNotMatch(prompt, /Не нужно звонить Антону сразу/);
  assert.doesNotMatch(prompt, /Не давать другой стороне данные своей страховки/);
  assert.doesNotMatch(prompt, /ущербе менее \$1000 обращаться к страховке нецелесообразно/);
  assert.match(prompt, /Если есть пострадавшие — сразу звонить 911/);
  assert.match(prompt, /водители обмениваются именем, адресом, номером прав, регистрацией и страховкой/);
});
