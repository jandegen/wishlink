'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRegistration, validateWish, validateClaimType, ValidationError } = require('../../src/validation');

const reg = { username: 'anna', firstName: 'Anna', lastName: 'Muster', password: 'secret123' };

test('registration: accepts valid input', () => {
  assert.equal(validateRegistration(reg).username, 'anna');
});

test('registration: needs no e-mail address and does not carry one along', () => {
  const v = validateRegistration({ ...reg, email: 'ignored@example.com' });
  assert.equal(v.email, undefined);
  assert.deepEqual(Object.keys(v).sort(), ['firstName', 'lastName', 'password', 'username']);
});

test('registration: rejects bad input', () => {
  for (const [patch, code] of [
    [{ username: 'ab' }, 'required'],
    [{ username: 'a b c' }, 'invalid_username'],
    [{ password: 'short' }, 'password_too_short'],
    [{ firstName: ' ' }, 'required'],
  ]) {
    assert.throws(() => validateRegistration({ ...reg, ...patch }), (e) => e instanceof ValidationError && e.code === code);
  }
});

test('wish: defaults, trimming and url normalisation', () => {
  const w = validateWish({ title: '  Bike ', links: ['https://example.com/a', ' ', 'https://example.com/a', 'https://example.com/b'] });
  assert.deepEqual(w, { title: 'Bike', description: '', links: ['https://example.com/a', 'https://example.com/b'], priority: 2, quantity: 1 });
  assert.equal(validateWish({ title: 'x', quantity: '3' }).quantity, 3);
  for (const q of [0, -1, 1.5, 100, 'abc']) assert.throws(() => validateWish({ title: 'x', quantity: q }), { code: 'invalid_quantity' });
  assert.deepEqual(validateWish({ title: 'x' }).links, []);
});

test('wish: rejects non-http urls and bad priority', () => {
  assert.throws(() => validateWish({ title: 'x', links: ['javascript:alert(1)'] }), { code: 'invalid_url' });
  assert.throws(() => validateWish({ title: 'x', links: ['not a url'] }), { code: 'invalid_url' });
  assert.throws(() => validateWish({ title: 'x', links: 'https://a.b' }), { code: 'invalid_url' });
  const many = Array.from({ length: 7 }, (_, i) => `https://e.com/${i}`);
  assert.throws(() => validateWish({ title: 'x', links: many }), { code: 'too_many_links' });
  assert.throws(() => validateWish({ title: 'x', priority: 7 }), { code: 'invalid_priority' });
  assert.throws(() => validateWish({ title: '' }), { code: 'required' });
});

test('claim type', () => {
  assert.equal(validateClaimType('gift'), 'gift');
  assert.equal(validateClaimType('purchased'), 'gift'); // legacy value is merged into gift
  assert.throws(() => validateClaimType('steal'), { code: 'invalid_claim_type' });
});
