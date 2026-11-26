'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOidcClient } = require('../../src/oidc');

const cfg = { issuer: 'https://kc/realms/x', clientId: 'wl', clientSecret: 's', redirectUri: 'https://w/cb', scope: 'openid' };
const jwt = (p) => `h.${Buffer.from(JSON.stringify(p)).toString('base64url')}.s`;

function fakeFetch(idClaims) {
  return async (url) => {
    const json = (o) => ({ ok: true, json: async () => o });
    if (url.endsWith('/.well-known/openid-configuration')) {
      return json({ issuer: cfg.issuer, authorization_endpoint: `${cfg.issuer}/auth`, token_endpoint: `${cfg.issuer}/token` });
    }
    return json({ id_token: jwt(idClaims) });
  };
}
const good = { iss: cfg.issuer, aud: 'wl', exp: Math.floor(Date.now() / 1000) + 60, nonce: 'n', sub: '1', email: 'a@b.c', email_verified: true };

test('authorization url contains required params', async () => {
  const c = createOidcClient(cfg, fakeFetch(good));
  const { url, state, nonce } = await c.authorizationUrl();
  const u = new URL(url);
  assert.equal(u.searchParams.get('client_id'), 'wl');
  assert.equal(u.searchParams.get('state'), state);
  assert.equal(u.searchParams.get('nonce'), nonce);
  assert.equal(u.searchParams.get('response_type'), 'code');
});

test('callback validates id_token claims', async () => {
  assert.equal((await createOidcClient(cfg, fakeFetch(good)).handleCallback('c', 'n')).sub, '1');
  for (const [patch, nonce] of [[{ iss: 'evil' }, 'n'], [{ aud: 'other' }, 'n'], [{ exp: 1 }, 'n'], [{}, 'wrong']]) {
    await assert.rejects(createOidcClient(cfg, fakeFetch({ ...good, ...patch })).handleCallback('c', nonce));
  }
});
