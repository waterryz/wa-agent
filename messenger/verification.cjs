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
    hasDigest(code, '70101cf3477569df3387f4df13f33e48c719d75e69da59d244c136b2d2d7a841');
}

module.exports = { matches, matchesPairing };
