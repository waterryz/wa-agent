'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const express = require('express');
const { createHttpAuth, protectLegacyRoutes, SESSION_SECONDS } = require('./http_auth');

test('signed sessions expire, reject edits and cannot double as administrator credentials', () => {
  let clock = 1800000000000;
  const auth = createHttpAuth('synthetic-admin-secret', () => clock);
  const token = auth.issueSession();
  assert.match(auth.readSession(token).external_id, /^session:/);
  assert.equal(auth.readSession(token.slice(0, -2) + 'xx'), null);
  assert.equal(createHttpAuth('different-secret', () => clock).readSession(token), null);
  assert.equal(auth.isAdmin({ get: () => token }), false);
  clock += SESSION_SECONDS * 1000;
  assert.equal(auth.readSession(token), null);
  assert.equal(createHttpAuth('').issueSession(), null);
});

test('HTTP isolation: two clients, spoofed identities, private channels, missing keys and legacy routes', async () => {
  const calls = [];
  const reads = [];
  const conversations = new Map();
  const previousLoad = Module._load;
  Module._load = function(request, parent) {
    if (parent?.filename.endsWith('assistant_routes.js')) {
      if (request === './assistant_core') return { processMessage: async args => {
        calls.push(args);
        let row = [...conversations.values()].find(c => c.channel === args.channel && c.external_id === args.external_id);
        if (!row) {
          row = { id: conversations.size + 1, channel: args.channel, external_id: args.external_id, status: 'active', operator_mode: false };
          conversations.set(String(row.id), row);
        }
        return { conversation_id: row.id, reply: 'synthetic response' };
      }};
      if (request === './assistant_store') return {
        getConversation: async id => conversations.get(String(id)),
        getRepliesSince: async id => { reads.push(String(id)); return [{ id: 1, role: 'assistant', content: 'private-' + id }]; },
        listConversations: async () => [],
      };
      if (request === './agent') return { VISION_MAX_IMAGES: 4 };
      if (['./store', './admin_assistant', './kb_collector'].includes(request)) return {};
    }
    return previousLoad.apply(this, arguments);
  };
  let create;
  try { create = require('./assistant_routes').createAssistantRouter; }
  finally { Module._load = previousLoad; }
  const app = express();
  protectLegacyRoutes(app, 'synthetic-admin-secret');
  app.use('/assistant', create({ adminKey: 'synthetic-admin-secret' }));
  app.use('/missing', create({}));
  app.all(['/api/chat','/api/seen','/api/blocked','/api/blocked/:id','/api/escalations','/api/escalations/:id/resolve','/qr','/api/wa-status'], (req,res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, body, headers = {}) => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const body = { channel: 'web', external_id: 'victim-id', message: 'hello', is_driver: true, driver_id: 99, context: 'injected', reply_suffix: 'injected' };
  try {
    assert.equal((await request('/assistant/chat', body)).status, 401);
    const tokenA = (await (await request('/assistant/session', {})).json()).token;
    const tokenB = (await (await request('/assistant/session', {})).json()).token;
    assert.notEqual(tokenA, tokenB);
    const a = await (await request('/assistant/chat', body, {'x-web-session': tokenA})).json();
    const b = await (await request('/assistant/chat', body, {'x-web-session': tokenB})).json();
    assert.notEqual(a.conversation_id, b.conversation_id);
    assert.notEqual(calls[0].external_id, 'victim-id');
    assert.notEqual(calls[0].external_id, calls[1].external_id);
    for (const call of calls) {
      assert.equal(call.is_driver, null); assert.equal(call.driver_id, null);
      assert.equal(call.context, null); assert.equal(call.replySuffix, '');
    }
    const own = await request(`/assistant/conversations/${a.conversation_id}/poll`, undefined, {'x-web-session': tokenA});
    assert.equal(own.status, 200);
    assert.equal((await own.json()).messages[0].content, 'private-' + a.conversation_id);
    assert.equal((await request(`/assistant/conversations/${b.conversation_id}/poll`, undefined, {'x-web-session': tokenA})).status, 404);
    assert.deepEqual(reads, [String(a.conversation_id)]);
    assert.equal((await request(`/assistant/conversations/${a.conversation_id}/poll`)).status, 401);
    assert.equal((await request('/assistant/conversations/1/poll?after=-1', undefined, {'x-web-session': tokenA})).status, 400);
    for (const channel of ['telegram', 'whatsapp']) {
      assert.equal((await request('/assistant/chat', {...body,channel}, {'x-web-session': tokenA})).status, 401);
      assert.equal((await request('/assistant/chat', {...body,channel}, {'x-admin-key':'synthetic-admin-secret'})).status, 200);
    }
    assert.equal((await request('/assistant/conversations?key=synthetic-admin-secret')).status, 401);
    assert.equal((await request('/assistant/conversations', undefined, {'x-admin-key':'synthetic-admin-secret'})).status, 200);
    assert.equal((await request('/missing/conversations')).status, 503);
    assert.equal((await request('/missing/session', {})).status, 503);
    assert.equal((await request('/missing/vision', { images: [] })).status, 503);
    for (const path of ['/api/chat','/api/seen','/api/blocked','/api/blocked/7','/api/escalations','/api/escalations/7/resolve']) {
      assert.equal((await request(path, {})).status, 401, path);
      assert.equal((await request(path, {}, {'x-admin-key':'synthetic-admin-secret'})).status, 200, path);
    }
    for (const path of ['/qr','/api/wa-status']) {
      assert.equal((await request(path)).status, 401);
      const authorization = 'Basic ' + Buffer.from('admin:synthetic-admin-secret').toString('base64');
      assert.equal((await request(path, undefined, {authorization})).status, 200);
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
