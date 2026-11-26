'use strict';
const crypto = require('node:crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Readable alphabet for generated passwords: no 0/O, 1/l/I, no symbols.
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function generatePassword(length = 12) {
  let out = '';
  for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  return out;
}

const newToken = () => crypto.randomBytes(32).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Tiny in-memory fixed-window rate limiter (per key). */
function createRateLimiter({ max, windowMs, now = Date.now }) {
  const hits = new Map();
  return {
    /** @returns {boolean} true if allowed */
    hit(key) {
      const t = now();
      const e = hits.get(key);
      if (!e || e.reset <= t) {
        hits.set(key, { count: 1, reset: t + windowMs });
        return true;
      }
      e.count += 1;
      return e.count <= max;
    },
    clear() { hits.clear(); },
  };
}

module.exports = { hashPassword, verifyPassword, generatePassword, newToken, sha256, createRateLimiter };
