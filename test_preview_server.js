'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createPreviewApp } = require('./preview_server');
const { createHttpAuth } = require('./http_auth');
const env = { ASSISTANT_PREVIEW_MODE: 'true', ASSISTANT_PREVIEW_KEY: 'preview-synthetic-key-'.repeat(3), ADMIN_API_KEY: 'admin-synthetic-key-'.repeat(3) };

test('preview refuses incomplete configuration and messaging credentials before loading integrations', () => {
  const factory = () => { throw Error('must not load'); };
  for (const patch of [{ ASSISTANT_PREVIEW_MODE: '' }, { ASSISTANT_PREVIEW_KEY: '' }, { ADMIN_API_KEY: '' }, { ASSISTANT_PREVIEW_KEY: env.ADMIN_API_KEY }, ...['TELEGRAM_BOT_TOKEN','TG_KB_BOT_TOKEN','BOT_TOKEN','RESEND_API_KEY'].map(k => ({ [k]: 'synthetic' }))]) {
    assert.throws(() => createPreviewApp({ ...env, ...patch }, factory), /Preview requires|Messaging credentials/);
  }
});

test('HTTP preview requires server authentication, permits signed web chat, blocks all sends and administrative writes', async () => {
  const calls = [];
  const app = createPreviewApp(env, ({ adminKey, ...deps }) => {
    assert.deepEqual(deps, { readOnlyAdmin: true }); // No send or escalation hooks.
    const router = express.Router(), auth = createHttpAuth(adminKey);
    router.post('/session', (_req, res) => res.json({ token: auth.issueSession() }));
    router.post('/chat', auth.requireSession, (req, res) => {
      calls.push({ id: req.webSession.external_id, trusted: auth.isAdmin(req) });
      res.json({ reply: 'synthetic' });
    });
    router.get('/conversations', auth.requireAdmin, (_req, res) => res.json([]));
    router.all('*', (_req, res) => { calls.push('unsafe'); res.json({ reached: true }); });
    return router;
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method = 'GET', body, headers = {}) => fetch(base + path, { method, headers: { 'content-type':'application/json', ...headers }, ...(body ? {body: JSON.stringify(body)} : {}) });
  const gate = { 'x-preview-key': env.ASSISTANT_PREVIEW_KEY };
  const admin = { 'x-admin-key': env.ADMIN_API_KEY };
  try {
    assert.equal((await request('/health')).status, 200);
    assert.equal((await request('/assistant/session', 'POST', {})).status, 401);
    assert.equal((await request('/assistant/session?key=' + env.ASSISTANT_PREVIEW_KEY, 'POST', {})).status, 401);
    const token = (await (await request('/assistant/session', 'POST', {}, gate)).json()).token;
    assert.equal((await request('/assistant/chat', 'POST', {channel:'web',external_id:'victim'}, admin)).status, 401);
    assert.equal((await request('/assistant/chat', 'POST', {channel:'web',external_id:'victim'}, {...admin,'x-web-session':token})).status, 200);
    assert.match(calls[0].id, /^session:/); assert.equal(calls[0].trusted, false);
    assert.equal((await request('/assistant/conversations', 'GET', null, gate)).status, 401);
    assert.equal((await request('/assistant/conversations', 'GET', null, admin)).status, 200);
    for (const channel of ['telegram', 'whatsapp']) assert.equal((await request('/assistant/chat','POST',{channel},admin)).status,403);
    for (const path of ['/assistant/conversations/1/reply','/assistant/conversations/1/read','/assistant/kb-staging/1/approve','/assistant/admin-chat','/assistant/billing','/assistant/wa/exceptions']) {
      for (const method of ['POST','PUT','PATCH','DELETE']) assert.equal((await request(path,method,{},admin)).status,403);
    }
    assert.equal(calls.length, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
