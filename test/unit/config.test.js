'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../../src/config');

test('defaults', () => {
  const c = loadConfig({});
  assert.equal(c.port, 3000);
  assert.equal(c.oidc.enabled, false);
  assert.equal(c.cookieSecure, false);
});

test('https public url enables secure cookies; oidc needs issuer + client', () => {
  const c = loadConfig({ PUBLIC_URL: 'https://wish.example.com/', OIDC_ISSUER: 'https://kc/realms/x/', OIDC_CLIENT_ID: 'wl' });
  assert.equal(c.cookieSecure, true);
  assert.equal(c.publicUrl, 'https://wish.example.com');
  assert.equal(c.oidc.enabled, true);
  assert.equal(c.oidc.issuer, 'https://kc/realms/x');
  assert.equal(c.oidc.redirectUri, 'https://wish.example.com/api/auth/oidc/callback');
  assert.equal(loadConfig({ OIDC_ISSUER: 'https://kc' }).oidc.enabled, false);
});
