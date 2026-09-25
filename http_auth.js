'use strict';

const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const SESSION_SECONDS = 30 * 24 * 60 * 60;

function sameSecret(actual, expected) {
  if (typeof actual !== 'string' || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function createHttpAuth(adminKey, now = () => Date.now()) {
  const key = typeof adminKey === 'string' ? adminKey.trim() : '';
  const sign = value => createHmac('sha256', key).update('prime-fusion:web-session:v1:' + value).digest('base64url');
  const isAdmin = req => sameSecret(req.get('x-admin-key'), key);
  function requireAdmin(req, res, next) {
    res.set('Cache-Control', 'no-store');
    if (!key) return res.status(503).json({ error: 'Admin access is not configured' });
    if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  }
  function issueSession() {
    if (!key) return null;
    const subject = randomBytes(24).toString('base64url');
    const expires = Math.floor(now() / 1000) + SESSION_SECONDS;
    const payload = `v1.${subject}.${expires}`;
    return `${payload}.${sign(payload)}`;
  }
  function readSession(token) {
    if (!key || typeof token !== 'string' || token.length > 180) return null;
    const match = /^(v1\.([A-Za-z0-9_-]{32})\.([0-9]{10}))\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match || !sameSecret(match[4], sign(match[1]))) return null;
    const seconds = Math.floor(now() / 1000);
    const expires = Number(match[3]);
    if (expires <= seconds || expires > seconds + SESSION_SECONDS) return null;
    return { external_id: `session:${match[2]}`, expires };
  }
  function requireSession(req, res, next) {
    if (!key) return res.status(503).json({ error: 'Chat access is not configured' });
    const session = readSession(req.get('x-web-session'));
    if (!session) return res.status(401).json({ error: 'Invalid chat session' });
    req.webSession = session;
    next();
  }
  // QR is an administrator page opened directly in a browser. Basic auth is
  // accepted only for these read-only endpoints; mutation APIs need the header.
  function requireQrAdmin(req, res, next) {
    res.set('Cache-Control', 'no-store');
    if (!key) return res.status(503).send('Admin access is not configured');
    const header = req.get('authorization') || '';
    let password = '';
    if (header.startsWith('Basic ')) {
      const pair = Buffer.from(header.slice(6), 'base64').toString('utf8');
      if (pair.startsWith('admin:')) password = pair.slice(6);
    }
    if (isAdmin(req) || sameSecret(password, key)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Prime Fusion admin", charset="UTF-8"');
    return res.status(401).send('Administrator login required');
  }
  return { isAdmin, requireAdmin, requireQrAdmin, issueSession, readSession, requireSession };
}

function protectLegacyRoutes(app, adminKey) {
  const auth = createHttpAuth(adminKey);
  app.use(['/api/chat', '/api/seen', '/api/blocked', '/api/escalations'], auth.requireAdmin);
  app.use(['/qr', '/api/wa-status'], auth.requireQrAdmin);
}

module.exports = { createHttpAuth, protectLegacyRoutes, SESSION_SECONDS };
