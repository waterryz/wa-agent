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
