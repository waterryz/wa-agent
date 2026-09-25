'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { systemBrowserPath } = require('./system_browser');

test('missing, relative, nonexistent and directory executables fail without cache fallback', () => {
  for (const env of [{}, { CHROME_PATH: 'chromium' },
    { CHROME_PATH: path.join(__dirname, 'nonexistent-chromium') },
    { CHROME_PATH: __dirname },
    { CHROME_PATH: 'wrong', PUPPETEER_EXECUTABLE_PATH: process.execPath }]) {
    assert.throws(() => systemBrowserPath(env), /Implicit browser-cache fallback is disabled/);
  }
  assert.equal(systemBrowserPath({ PUPPETEER_EXECUTABLE_PATH: process.execPath }), process.execPath);
  assert.equal(systemBrowserPath({ CHROME_PATH: ` ${process.execPath} ` }), process.execPath);
});

test('installed WhatsApp LocalAuth passes the explicit browser to launch without remote-session extraction', async t => {
  const { Client, LocalAuth } = require('whatsapp-web.js');
  const puppeteer = require('puppeteer');
  const root = path.resolve(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(root, 'pf-browser-test-'));
  const sentinel = new Error('stop before browser launch or network');
  let options;
  t.mock.method(puppeteer, 'launch', async passed => { options = passed; throw sentinel; });
  t.mock.method(puppeteer, 'connect', async () => { throw new Error('unexpected remote browser'); });
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), root);
    assert.ok(path.basename(dir).startsWith('pf-browser-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const executablePath = systemBrowserPath({ CHROME_PATH: process.execPath });
  const client = new Client({ authStrategy: new LocalAuth({ dataPath: dir }),
    puppeteer: { executablePath, headless: true, args: [] } });
  await assert.rejects(client.initialize(), error => error === sentinel);
  assert.equal(options.executablePath, process.execPath);
  assert.equal(options.userDataDir, path.join(dir, 'session'));
  assert.equal(options.browserURL, undefined);
  assert.equal(options.browserWSEndpoint, undefined);
});
