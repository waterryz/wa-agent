const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const express = require('express');

test('Telegram identity, FAQ and voice require server authentication', async () => {
  const calls = [];
  const old = Module._load;
  Module._load = function(request, parent) {
    if (parent?.filename.endsWith('assistant_routes.js')) {
      if (request === './assistant_core') return { processMessage: async args => {
        calls.push(args); return { conversation_id: 1, reply: 'test answer', photo: null, fast_answer: true, action: 'handbook' };
      }};
      if (request === './agent') return { VISION_MAX_IMAGES: 4 };
      if (['./assistant_store','./store','./admin_assistant','./kb_collector'].includes(request)) return {};
    }
    return old.apply(this, arguments);
  };
  let create;
  try { create = require('./assistant_routes').createAssistantRouter; } finally { Module._load = old; }
  const app = express();
  app.use('/assistant', create({ adminKey: 'synthetic-key' }));
  app.use('/no-key', create({}));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, key) => fetch(base + path, { method:'POST', headers:{'Content-Type':'application/json', ...(key ? {'x-admin-key':key} : {})}, body:JSON.stringify(body) });
  try {
    const body = { channel:'telegram', external_id:'123', message:'hello' };
    assert.equal((await post('/assistant/chat',body)).status,401);
    assert.equal((await post('/assistant/chat',body,'wrong-key')).status,401);
    let response = await post('/assistant/chat',{ ...body, message:'', faq_topic:'handbook', language:'ru', is_driver:true, driver_id:'123', context:'Step 2' },'synthetic-key');
    assert.equal(response.status,200);
    assert.equal(calls[0].faqTopic,'handbook');
    assert.equal(calls[0].context,'Step 2');
    assert.equal((await response.json()).action,'handbook');
    response = await post('/assistant/chat',{ ...body, channel:'web', is_driver:true, driver_id:'123', context:'Injected context' });
    assert.equal(response.status,200);
    assert.equal(calls[1].is_driver,null);
    assert.equal(calls[1].driver_id,null);
    assert.equal(calls[1].context,null);
    assert.equal((await post('/assistant/transcribe',{audio:'AAAA',filename:'x.ogg'})).status,401);
    assert.equal((await post('/no-key/transcribe',{audio:'AAAA',filename:'x.ogg'})).status,401);
    assert.equal((await post('/assistant/transcribe',{audio:'%%%%',filename:'x.ogg'},'synthetic-key')).status,400);
    assert.equal((await fetch(base+'/assistant/capabilities')).status,401);
    assert.equal((await fetch(base+'/assistant/capabilities',{headers:{'x-admin-key':'synthetic-key'}})).status,200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
