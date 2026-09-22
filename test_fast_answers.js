const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const faq = require('./fast_answers');
const { decode, transcribe } = require('./transcribe');

test('exact aliases and explicit buttons, RU/EN', () => {
  assert.equal(faq.lookup({ text: 'ГДЕ СКАЧАТЬ ХЕНДБУК?' }).id, 'handbook');
  assert.equal(faq.lookup({ text: 'Where is the service shop?' }).id, 'service_address');
  assert.equal(faq.lookup({ topic: 'payment', language: 'ru' }).id, 'payment');
  assert.match(faq.lookup({ text: 'нет убера и лифта' }).text, /Даже без/);
  assert.equal(faq.lookup({ text: 'сервис' }).action, 'service_choice');
});
test('personal, compound, ambiguous and photo questions bypass templates', () => {
  for (const text of ['я оплатил сервис верните деньги', 'где сервис и почему у меня долг', 'გადახდა', 'I already paid, why do I owe money?']) assert.equal(faq.lookup({ text }), null);
  assert.equal(faq.lookup({ text: 'где хендбук', hasPhoto: true }), null);
  assert.equal(faq.lookup({ topic: 'payment', text: 'I paid yesterday', language: 'en' }), null);
});
test('core saves both messages, bypasses all models, and respects operator takeover', async () => {
  let operator = false, calls = [], saved = [];
  const old = Module._load;
  Module._load = function(request, parent, main) {
    if (parent?.filename.endsWith('assistant_core.js') && request === './agent') return {
      OWNER_NAME: 'Owner', costOf: () => ({}), retrieveContext: () => { calls.push('retrieve'); throw Error('model forbidden'); },
    };
    if (parent?.filename.endsWith('assistant_core.js') && request === './assistant_store') return {
      getOrCreateConversation: async () => ({ id: 1, operator_mode: operator }),
      saveMessage: async (...args) => saved.push(args),
    };
    return old.apply(this, arguments);
  };
  let core;
  try { delete require.cache[require.resolve('./assistant_core')]; core = require('./assistant_core'); } finally { Module._load = old; }
  const normal = await core.processMessage({ channel: 'telegram', external_id: '123', message: 'где хендбук' });
  assert.equal(normal.fast_answer, true);
  assert.deepEqual(saved.map(x => x[1]), ['user', 'assistant']);
  assert.deepEqual(calls, []);
  operator = true;
  saved = [];
  const takeover = await core.processMessage({ channel: 'telegram', external_id: '123', message: 'где хендбук' });
  assert.equal(takeover.reply, null);
  assert.equal(takeover.operator_mode, true);
  assert.deepEqual(saved.map(x => x[1]), ['user']);
});
test('audio validation rejects arbitrary files and malformed base64', () => {
  assert.throws(() => decode({ filename: 'file.exe', audio: 'AAAA' }));
  assert.throws(() => decode({ filename: 'voice.ogg', audio: '%%%%' }));
  assert.equal(decode({ filename: 'voice.ogg', audio: Buffer.from('fake ogg').toString('base64') }).mime, 'audio/ogg');
});
test('voice preserves Russian, English and Georgian text, without forcing UI language', async () => {
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'synthetic-test-key';
  try {
    for (const [i, text] of ['Где сервис?', 'Where is the shop?', 'სად არის სერვისი?'].entries()) {
      let called = 0;
      const request = async (url, options) => {
        called++;
        assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
        assert.equal(options.body.has('language'), false);
        return { ok: true, json: async () => ({ text }) };
      };
      const body = { external_id: '123', filename: 'voice.ogg', audio: Buffer.from('fake recording' + i).toString('base64') };
      assert.equal(await transcribe(body, request), text);
      assert.equal(await transcribe(body, request), text);
      assert.equal(called, 1);
    }
  } finally { if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; }
});
