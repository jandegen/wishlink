'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword, createRateLimiter, sha256, newToken, generatePassword } = require('../../src/security');

test('password hashing verifies and salts', () => {
  const a = hashPassword('pw-12345');
  assert.notEqual(a, hashPassword('pw-12345'));
  assert.ok(verifyPassword('pw-12345', a));
  assert.ok(!verifyPassword('wrong', a));
  assert.ok(!verifyPassword('x', null));
  assert.ok(!verifyPassword('x', 'garbage'));
});

test('tokens are unique; sha256 is stable', () => {
  assert.notEqual(newToken(), newToken());
  assert.equal(sha256('a'), sha256('a'));
});

test('rate limiter blocks after max and resets after window', () => {
  let now = 0;
  const l = createRateLimiter({ max: 2, windowMs: 1000, now: () => now });
  assert.ok(l.hit('k')); assert.ok(l.hit('k')); assert.ok(!l.hit('k'));
  assert.ok(l.hit('other'));
  now = 1001;
  assert.ok(l.hit('k'));
});

test('generated passwords are readable and unique', () => {
  const set = new Set(Array.from({ length: 200 }, () => generatePassword(12)));
  assert.equal(set.size, 200);
  for (const p of set) assert.match(p, /^[A-HJ-NP-Za-km-z2-9]{12}$/);
});
