'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The deployed image installs Chromium through apt. Never silently select a
// Puppeteer-downloaded browser when that configured executable is missing.
function systemBrowserPath(env = process.env) {
  const executable = (env.CHROME_PATH || env.PUPPETEER_EXECUTABLE_PATH || '').trim();
  const message = 'Configure CHROME_PATH or PUPPETEER_EXECUTABLE_PATH as an absolute path to installed Chromium. Implicit browser-cache fallback is disabled.';
  if (!executable || !path.isAbsolute(executable)) throw new Error(message);
  try {
    if (!fs.statSync(executable).isFile()) throw new Error();
    fs.accessSync(executable, fs.constants.X_OK);
  } catch { throw new Error(message); }
  return executable;
}

module.exports = { systemBrowserPath };
