'use strict';

// Build-time smoke check of the real production browser and installed Puppeteer.
// No application module, provider key, WhatsApp session or remote page is loaded.
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const { systemBrowserPath } = require('./system_browser');

async function verify() {
  let browser;
  const deadline = setTimeout(() => {
    if (browser) browser.process()?.kill('SIGKILL');
    console.error('System Chromium smoke check timed out');
    process.exit(1);
  }, 30000);
  try {
    browser = await puppeteer.launch({
      executablePath: systemBrowserPath(), headless: true, timeout: 15000,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--disable-background-networking'],
    });
    const page = await browser.newPage();
    await page.setOfflineMode(true);
    const label = 'Prime Fusion — Русский — ქართული';
    await page.setContent(`<meta charset="utf-8"><main>${label}</main>`);
    assert.equal(await page.$eval('main', element => element.textContent), label);
    assert.equal(await page.evaluate(() => 21 * 2), 42);
    console.log(`System Chromium smoke check passed: ${await browser.version()}`);
  } finally {
    if (browser) await browser.close();
    clearTimeout(deadline);
  }
}

verify().catch(error => {
  console.error('System Chromium smoke check failed:', error.message);
  process.exitCode = 1;
});
