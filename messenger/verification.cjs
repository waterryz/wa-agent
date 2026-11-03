'use strict';
const { createHash, timingSafeEqual } = require('node:crypto');

function hasDigest(input, digest) {
  if (typeof input !== 'string' || !input.length || input.length > 512) return false;
  return timingSafeEqual(createHash('sha256').update(input).digest(), Buffer.from(digest, 'hex'));
}

function matches(token) {
  return hasDigest(token, '8f50a644bf59a5488b76632f42a86cc310e8bb868776e3b1afd88e6267c38b0a');
}

function matchesPairing(code) {
  return Date.now() < Date.parse('2026-11-04T15:00:00Z') &&
    hasDigest(code, 'feafd4cd1657d8292a951185ce520e396e4cdbe81f138beb9daa0ff5aa22c41a');
}

module.exports = { matches, matchesPairing };
