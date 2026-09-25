const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const express = require('express');
const faq = require('./fast_answers');
const { createKnowledge, validateCatalog } = require('./company_knowledge');
const { shortAnswerOptions } = require('./model_options');
const { createDraftNotifier } = require('./draft_notifications');
const snapshot = require('./knowledge/test-catalog.json');

test('courtesy does not send a common question through a paid model', () => {
  for (const text of ['Подскажите, пожалуйста, где сервис?', 'Здравствуйте! Где сервис, пожалуйста?', 'Hello, where is the service shop? Thanks!']) {
    assert.equal(faq.lookup({ text }).id, 'service_address');
  }
  for (const text of ['Подскажите, где сервис и почему у меня долг?', 'Где сервис НЕ надо ехать?', 'Please, I paid yesterday, why do I owe money?', 'Подскажите, какая моя ставка?']) {
    assert.equal(faq.lookup({ text }), null);
  }
  assert.equal(faq.lookup({ text: 'где сервис', hasPhoto: true }), null);
});

test('candidate application and availability never promise a reservation, RU/EN', () => {
  for (const topic of ['application', 'availability']) {
    assert.match(faq.lookup({ topic, language: 'ru' }).text, /не гарантирует.*бронирован/s);
    assert.match(faq.lookup({ topic, language: 'en' }).text, /does not guarantee/i);
  }
  assert.match(faq.lookup({ text: 'нет убера и лифта' }).text, /можно подать/);
  assert.match(faq.lookup({ topic: 'dmv_under_one', language: 'ru' }).text, /не менее 1 года/);
});

test('exact answers to all 70 current test questions; one cached fetch; no generation', async () => {
  let calls = 0;
  const kb = createKnowledge({ fetchImpl: async () => { calls++; return { ok: true, text: async () => JSON.stringify(snapshot) }; } });
  assert.equal(snapshot.questions.length, 70);
  for (const q of snapshot.questions) {
    const answer = await kb.testAnswer(q.question, 'ru');
    assert.equal(answer.id, `test:${q.id}`);
    assert.ok(answer.text.includes(q.options[q.correct]), q.question);
    assert.match(answer.version, /^[a-f0-9]{64}$/);
  }
  assert.equal(calls, 1);
  assert.equal(await kb.testAnswer('Я прошёл тест, выдайте машину', 'ru'), null);
  assert.equal(await kb.testAnswer(snapshot.questions[0].question, 'en'), null);
});

test('changed catalog refreshes; stale answers are not presented as current', async () => {
  let time = 100000, available = true;
  const data = JSON.parse(JSON.stringify(snapshot));
  const kb = createKnowledge({ now: () => time, fetchImpl: async () => {
    if (!available) throw Error('offline');
    return { ok: true, text: async () => JSON.stringify(data) };
  } });
  const q = data.questions[0];
  const first = await kb.testAnswer(q.question);
  q.correct = (q.correct + 1) % q.options.length;
  time += 61000;
  const edited = await kb.testAnswer(q.question);
  assert.ok(edited.text.includes(q.options[q.correct]));
  assert.notEqual(edited.version, first.version);
  time += 61000; available = false;
  assert.equal(await kb.testAnswer(q.question), null);
  assert.ok((await kb.context('инспекция DMV')).every(f => !f.source.includes('/api/translate')));
  assert.throws(() => validateCatalog({ questions: [{ id: 'x', question: 'x', options: ['a'], correct: 5 }] }));
});

test('handbook and approved owner directions remain available offline', async () => {
  const kb = createKnowledge({ fetchImpl: async () => { throw Error('offline'); } });
  const facts = await kb.context('бланк инспекции DMV Гарри Алекс');
  assert.ok(facts.some(f => /распечатать/.test(f.content) && /Гарри/.test(f.content)));
  assert.ok(facts.some(f => /Mobile handbook/.test(f.source)));
  const wav = await kb.context('Как работать с пандусом WAV?');
  assert.ok(wav.some(f => /page 10$/.test(f.source)));
});

test('only supported Kimi models receive non-thinking option', () => {
  assert.deepEqual(shortAnswerOptions('kimi-k2.6'), { thinking: { type: 'disabled' } });
  assert.deepEqual(shortAnswerOptions('kimi-k3'), {});
  assert.deepEqual(shortAnswerOptions('different-provider'), {});
});

test('current online contact policy survives compound and foreign-language retrieval without the catalog', async () => {
  const kb = createKnowledge({ fetchImpl: async () => { throw Error('offline'); } });
  for (const query of [
    'Это проверка тестовой версии, заявка не нужна. Есть ли у Prime Fusion офис и как проходит общение перед получением машины?',
    'Can I walk into your office today or do I need an appointment?',
    'ოფისი გაქვთ? მანქანის მისაღებად როგორ შევხვდეთ?',
  ]) {
    const facts = await kb.context(query);
    const policy = facts.find(f => /нет офиса/.test(f.content));
    assert.ok(policy?.priority, query);
    assert.match(policy.content, /после заполнения заявки/);
    assert.match(policy.content, /встреча назначается при выдаче машины/);
    assert.match(policy.content, /primefusion\.cars@gmail\.com/);
    assert.match(policy.content, /https:\/\/t\.me\/primefusiontlcbot/);
  }
});

test('actual agent requests disable reasoning, limit output and avoid SDK retries', async () => {
  const constructors = [], requests = [];
  const envKeys = ['MOONSHOT_API_KEY', 'OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'KIMI_MODEL', 'ASSISTANT_REPLY_MAX_TOKENS', 'KIMI_TIMEOUT_MS'];
  const previous = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { MOONSHOT_API_KEY: 'synthetic', OPENAI_API_KEY: 'synthetic', SUPABASE_URL: 'https://example.test', SUPABASE_SERVICE_KEY: 'synthetic', KIMI_MODEL: 'kimi-k2.6', ASSISTANT_REPLY_MAX_TOKENS: '1200', KIMI_TIMEOUT_MS: '30000' });
  const original = Module._load;
  Module._load = function(request, parent) {
    if (parent?.filename.endsWith('agent.js')) {
      if (request === 'dotenv') return { config() {} };
      if (request === 'openai') return class { constructor(options) {
        constructors.push(options);
        this.chat = { completions: { create: async (body, opts) => { requests.push({ body, opts }); return { choices: [{ message: { content: 'Synthetic answer' }, finish_reason: 'stop' }], usage: {} }; } } };
        this.embeddings = { create: async () => ({ data: [{ embedding: [0] }], usage: {} }) };
      } };
      if (request === '@supabase/supabase-js') return { createClient: () => ({ from() { const q = { select: () => q, eq: () => q, order: () => q, limit: async () => ({ data: [] }) }; return q; }, rpc: async () => ({ data: [] }) }) };
      if (request === './company_knowledge') return { context: async () => [] };
    }
    return original.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve('./agent')];
    const agent = require('./agent');
    await agent.generateReply('System', [{ role: 'user', content: 'Hello' }]);
    await agent.retrieveContext('Hello');
    assert.ok(constructors.every(c => c.maxRetries === 0));
    assert.equal(constructors[1].timeout, 8000);
    assert.equal(requests[0].body.max_tokens, 1200);
    assert.equal(requests[0].opts.timeout, 30000);
    assert.deepEqual(requests.map(r => r.body.thinking), [{ type: 'disabled' }, { type: 'disabled' }]);
  } finally {
    Module._load = original;
    for (const k of envKeys) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; }
    delete require.cache[require.resolve('./agent')];
  }
});

function fakeDb(rows = []) {
  const states = new Map();
  return { states, from(table) {
    let filters = [], write = null, single = false;
    const q = {
      select() { return q; }, eq(k, v) { filters.push([k, v]); return q; },
      order() { return q; }, limit() { return q; },
      upsert(value) { write = value; return q; },
      maybeSingle() { single = true; return q; },
      then(resolve, reject) {
        let data;
        if (write) { states.set(write.bot, write); data = write; }
        else {
          data = (table === 'knowledge_staging' ? rows : [...states.values()]).filter(r => filters.every(([k, v]) => r[k] === v));
          if (single) data = data[0] || null;
        }
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return q;
  } };
}

test('new drafts notify internal channel once; edited draft notifies again; no approval', async () => {
  const row = { id: 10, raw_text: 'Original post', proposed_content: 'New service rule', status: 'pending' };
  const db = fakeDb([row]), calls = [];
  const notify = createDraftNotifier({ db, env: { TELEGRAM_BOT_TOKEN: 'synthetic', KB_NOTIFY_CHAT_ID: '-100123', KB_ADMIN_URL: 'https://admin.example.test/review' },
    fetchImpl: async (url, options) => { calls.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true, result: { message_id: calls.length } }) }; } });
  assert.equal((await notify.flush()).sent, 1);
  assert.equal((await notify.flush()).sent, 0);
  assert.equal(calls[0].chat_id, '-100123');
  assert.equal(calls[0].reply_markup.inline_keyboard[0][0].url, 'https://admin.example.test/review');
  assert.match(calls[0].text, /До подтверждения/);
  assert.equal(row.status, 'pending');
  row.raw_text = 'Edited post';
  assert.equal((await notify.flush()).sent, 1);
  row.status = 'approved'; row.raw_text = 'not pending';
  assert.equal((await notify.flush()).sent, 0);
});

test('notification failure can retry and missing settings never send to guessed recipient', async () => {
  const db = fakeDb([{ id: 10, raw_text: 'Original', status: 'pending' }]);
  let ok = false, calls = 0;
  const options = { db, env: { TELEGRAM_BOT_TOKEN: 'synthetic', KB_NOTIFY_CHAT_ID: '-100123', KB_ADMIN_URL: 'https://admin.example.test/' },
    fetchImpl: async () => { calls++; return { ok, json: async () => ({ ok, result: { message_id: 8 } }) }; } };
  const notify = createDraftNotifier(options);
  await assert.rejects(notify.flush());
  assert.equal(db.states.size, 0);
  ok = true;
  assert.equal((await notify.flush()).sent, 1);
  const before = calls;
  assert.equal((await createDraftNotifier({ ...options, env: {} }).flush()).skipped, 'not_configured');
  assert.equal(calls, before);
});

function mockedCore({ takeover = false, generationFails = false, updatedKnowledge = false } = {}) {
  const saved = [], statuses = [];
  let taken = false, generated = 0;
  const original = Module._load;
  Module._load = function(request, parent) {
    if (parent?.filename.endsWith('assistant_core.js')) {
      if (request === './company_knowledge') return { testAnswer: async () => null };
      if (request === './agent') return { OWNER_NAME: 'Owner', costOf: () => ({}),
        retrieveContext: async () => ({ facts: [], examples: [], embedTokens: 0 }), buildSystemPrompt: () => 'Test',
        generateReply: async () => { generated++; taken = takeover; if (generationFails) throw Error('provider failed'); return { text: 'Synthetic reply', usage: {} }; },
        parseEscalation: text => ({ text, escalate: false, reason: '' }),
      };
      if (request === './assistant_store') return {
        hasReviewedKnowledgeSince: async () => updatedKnowledge,
        getOrCreateConversation: async () => ({ id: 1, operator_mode: false }),
        getConversation: async () => ({ id: 1, operator_mode: taken }),
        saveMessage: async (...args) => saved.push(args),
        getHistory: async () => [{ role: 'user', content: 'Unusual question' }],
        setStatus: async (...args) => statuses.push(args),
      };
    }
    return original.apply(this, arguments);
  };
  let core;
  try { delete require.cache[require.resolve('./assistant_core')]; core = require('./assistant_core'); }
  finally { Module._load = original; }
  return { core, saved, statuses, generated: () => generated };
}

test('FAQ keeps full history without model use', async () => {
  const m = mockedCore();
  const result = await m.core.processMessage({ channel: 'telegram', external_id: 'test', message: 'Подскажите, где сервис?' });
  assert.equal(result.fast_answer, true);
  assert.equal(m.generated(), 0);
  assert.deepEqual(m.saved.map(x => x[1]), ['user', 'assistant']);
});

test('operator takeover during generation suppresses stale AI reply', async () => {
  const m = mockedCore({ takeover: true });
  const result = await m.core.processMessage({ channel: 'telegram', external_id: 'test', message: 'Unusual question' });
  assert.equal(result.reply, null);
  assert.equal(result.operator_mode, true);
  assert.deepEqual(m.saved.map(x => x[1]), ['user']);
});

test('approved broadcast updates prevent outdated factual FAQ bypass', async () => {
  const m = mockedCore({ updatedKnowledge: true });
  const result = await m.core.processMessage({ channel: 'telegram', external_id: 'test', message: 'Где сервис?' });
  assert.equal(m.generated(), 1);
  assert.equal(result.fast_answer, undefined);
});

test('provider timeout preserves question and marks it for review', async () => {
  const m = mockedCore({ generationFails: true });
  const result = await m.core.processMessage({ channel: 'telegram', external_id: 'test', message: 'Unusual question' });
  assert.equal(result.escalate, true);
  assert.match(result.reply, /Вопрос сохранён/);
  assert.deepEqual(m.statuses, [[1, 'escalated']]);
});

test('admin draft approval fails closed without key and rejects wrong key', async () => {
  let listed = 0;
  const original = Module._load;
  Module._load = function(request, parent) {
    if (parent?.filename.endsWith('assistant_routes.js')) {
      if (request === './kb_collector') return { listStaging: async () => { listed++; return []; }, countPending: async () => 0 };
      if (request === './agent') return { VISION_MAX_IMAGES: 4 };
      if (['./assistant_core', './assistant_store', './store', './admin_assistant'].includes(request)) return {};
    }
    return original.apply(this, arguments);
  };
  let create;
  try { delete require.cache[require.resolve('./assistant_routes')]; create = require('./assistant_routes').createAssistantRouter; }
  finally { Module._load = original; }
  const app = express(); app.use('/missing', create({})); app.use('/key', create({ adminKey: 'synthetic' }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/missing/kb-staging')).status, 503);
    assert.equal((await fetch(base + '/key/kb-staging')).status, 401);
    assert.equal((await fetch(base + '/key/kb-staging', { headers: { 'x-admin-key': 'synthetic' } })).status, 200);
    assert.equal(listed, 1);
  } finally { await new Promise(r => server.close(r)); }
});
