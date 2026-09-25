'use strict';

// Dedicated, opt-in HTTP preview. Never import server.js or start messaging workers.
const express = require('express');
const { timingSafeEqual } = require('node:crypto');

function matches(value, expected) {
  if (typeof value !== 'string') return false;
  const a = Buffer.from(value), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function createPreviewApp(env = process.env, routerFactory) {
  const previewKey = env.ASSISTANT_PREVIEW_KEY || '';
  const adminKey = env.ADMIN_API_KEY || '';
  if (env.ASSISTANT_PREVIEW_MODE !== 'true' || previewKey.length < 32 || adminKey.length < 32 || previewKey === adminKey) {
    throw new Error('Preview requires explicit mode and separate server keys of at least 32 characters');
  }
  // Reject accidental copies of messaging credentials rather than silently using them.
  for (const name of ['TELEGRAM_BOT_TOKEN', 'TG_KB_BOT_TOKEN', 'BOT_TOKEN', 'RESEND_API_KEY']) {
    if (env[name]) throw new Error('Messaging credentials must not be configured in the HTTP preview');
  }
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => res.json({ ok: true, mode: 'http-preview', messaging: false }));
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!matches(req.get('x-preview-key'), previewKey) && !matches(req.get('x-admin-key'), adminKey)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    if (req.method === 'POST' && req.path === '/assistant/session') return next();
    if (req.method === 'POST' && req.path === '/assistant/chat') {
      if (req.body?.channel !== 'web') return res.status(403).json({ error: 'preview_web_only' });
      // Even an administrator must use a new signed visitor session in this copy.
      delete req.headers['x-admin-key'];
      return next();
    }
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    return res.status(403).json({ error: 'preview_read_only' });
  });
  const createRouter = routerFactory || require('./assistant_routes').createAssistantRouter;
  app.use('/assistant', createRouter({ adminKey, readOnlyAdmin: true }));
  return app;
}

if (require.main === module) {
  require('dotenv').config();
  const app = createPreviewApp();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => console.log('HTTP preview listening; messaging and administrative writes disabled'));
}

module.exports = { createPreviewApp };
