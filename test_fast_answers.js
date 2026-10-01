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
test('current service and DMV answers keep the complete instructions', () => {
  const filters = faq.lookup({ text: 'когда менять фильтры' });
  assert.match(filters.text, /каждой второй замене масла/);
  assert.match(filters.text, /каждом ТО/);
  assert.match(faq.lookup({ text: 'how often should the filters be changed' }).text, /every second oil change/);
  assert.equal(faq.lookup({ text: 'Когда менять воздушный и салонный фильтры?' }).id, 'service_filters');
  const interval = faq.lookup({ text: 'когда менять масло' }).text;
  assert.match(interval, /6 000 миль/);
  assert.match(interval, /не позднее 7 000 миль/);
  const transfer = faq.lookup({ text: 'Can my brother drive the rental car for one day if he has a TLC license?' }).text;
  assert.match(transfer, /Do not let anyone else drive/);
  assert.doesNotMatch(transfer, /second driver|approved driver/i);
  const dmv = faq.lookup({ text: 'какие фото нужны для дмв' }).text;
  assert.equal(faq.lookup({ text: 'Какие фотографии нужно отправить после DMV-инспекции?' }).id, 'inspection_photos');
  for (const item of ['бланк', 'спереди', 'сзади', 'слева', 'справа', 'пробег']) assert.ok(dmv.includes(item), item);
  const service = faq.lookup({ text: 'как отправить чек' }).text;
  assert.match(service, /«Сервис» → «Отправить фото после сервиса»/);
  assert.doesNotMatch(service, /Сервис и документы/);
});
test('personal, compound, ambiguous and photo questions bypass templates', () => {
  for (const text of ['я оплатил сервис верните деньги', 'где сервис и почему у меня долг', 'გადახდა', 'I already paid, why do I owe money?']) assert.equal(faq.lookup({ text }), null);
  assert.equal(faq.lookup({ text: 'где хендбук', hasPhoto: true }), null);
  assert.equal(faq.lookup({ topic: 'payment', text: 'I paid yesterday', language: 'en' }), null);
});
test('mechanic uncertainty about oil-change count receives the approved filter rule', () => {
  const question = 'Механик не знает, какая замена масла по счёту. Что делать с воздушным и салонным фильтрами?';
  const reply = faq.lookup({ text: question });
  assert.equal(reply.id, 'service_filters');
  assert.match(reply.text, /каждой второй замене масла/);
  assert.match(reply.text, /историю обслуживания/);
  assert.equal(faq.lookup({ text: 'Mechanic does not know which oil change this is. What about the filters?' }).id, 'service_filters');
  for (const text of [
    'Я оплатил фильтры после замены масла. Верните деньги.',
    'После замены масла машина заглохла и фильтр дымит. Что делать?',
    'Механик предлагает дорогой ремонт фильтра. Сколько я должен платить?',
  ]) assert.equal(faq.lookup({ text }), null);
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
