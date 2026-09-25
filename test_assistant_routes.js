const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const express = require('express');
const { createPreviewApp } = require('./preview_server');

test('Telegram identity and FAQ require server authentication; cancelled voice is unavailable', async () => {
  const calls = [];
  let markedRead = 0;
  const old = Module._load;
  Module._load = function(request, parent) {
    if (parent?.filename.endsWith('assistant_routes.js')) {
      if (request === './assistant_core') return { processMessage: async args => {
        calls.push(args); return { conversation_id: 1, reply: 'test answer', photo: null, fast_answer: true, action: 'handbook' };
      }};
      if (request === './agent') return { VISION_MAX_IMAGES: 4 };
      if (request === './assistant_store') return {
        getConversation: async id => ({ id, unread_count: 7 }),
        getMessages: async () => [{ id: 1, role: 'user', content: 'synthetic' }],
        markAdminRead: async () => { markedRead++; },
      };
      if (['./assistant_store','./store','./admin_assistant','./kb_collector'].includes(request)) return {};
    }
    return old.apply(this, arguments);
  };
  let create;
  try { create = require('./assistant_routes').createAssistantRouter; } finally { Module._load = old; }
  const app = express();
  app.use('/assistant', create({ adminKey: 'synthetic-key' }));
  app.use('/no-key', create({}));
  const previewEnv = { ASSISTANT_PREVIEW_MODE: 'true', ASSISTANT_PREVIEW_KEY: 'p'.repeat(32), ADMIN_API_KEY: 'a'.repeat(32) };
  app.use('/preview', createPreviewApp(previewEnv, create));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, key, session) => fetch(base + path, { method:'POST', headers:{'Content-Type':'application/json', ...(key ? {'x-admin-key':key} : {}), ...(session ? {'x-web-session':session} : {})}, body:JSON.stringify(body) });
  try {
    const body = { channel:'telegram', external_id:'123', message:'hello' };
    assert.equal((await post('/assistant/chat',body)).status,401);
    assert.equal((await post('/assistant/chat',body,'wrong-key')).status,401);
    let response = await post('/assistant/chat',{ ...body, message:'', faq_topic:'handbook', language:'ru', is_driver:true, driver_id:'123', context:'Step 2' },'synthetic-key');
    assert.equal(response.status,200);
    assert.equal(calls[0].faqTopic,'handbook');
    assert.equal(calls[0].context,'Step 2');
    assert.equal((await response.json()).action,'handbook');
    const session = (await (await post('/assistant/session', {})).json()).token;
    response = await post('/assistant/chat',{ ...body, channel:'web', is_driver:true, driver_id:'123', context:'Injected context' }, null, session);
    assert.equal(response.status,200);
    assert.equal(calls[1].is_driver,null);
    assert.equal(calls[1].driver_id,null);
    assert.equal(calls[1].context,null);
    assert.equal((await post('/assistant/transcribe',{})).status,410);
    assert.equal((await fetch(base+'/assistant/capabilities')).status,401);
    const caps = await fetch(base+'/assistant/capabilities',{headers:{'x-admin-key':'synthetic-key'}});
    assert.equal(caps.status,200);
    assert.equal((await caps.json()).voice,false);
    // Exercise the actual router through the preview gate, not a fake GET handler.
    const detail = '/preview/assistant/conversations/1';
    assert.equal((await fetch(base + detail)).status, 401);
    assert.equal((await fetch(base + detail, { headers: { 'x-preview-key': previewEnv.ASSISTANT_PREVIEW_KEY } })).status, 401);
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(base + detail, { method, headers: { 'x-admin-key': previewEnv.ADMIN_API_KEY } });
      assert.equal(response.status, 200);
      if (method === 'GET') assert.deepEqual(await response.json(), { conversation: { id: '1', unread_count: 7 }, messages: [{ id: 1, role: 'user', content: 'synthetic' }] });
    }
    assert.equal(markedRead, 0, 'preview viewing must leave the shared unread queue intact');
    assert.equal((await fetch(base + '/assistant/conversations/1', { headers: { 'x-admin-key': 'synthetic-key' } })).status, 200);
    assert.equal(markedRead, 1, 'production retains its existing mark-read behavior');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
