'use strict';
const crypto = require('node:crypto');

/**
 * Minimal OpenID Connect authorization-code client (works with Keycloak).
 * The ID token is received directly from the token endpoint over TLS, so per OIDC Core §3.1.3.7
 * its signature need not be verified; iss, aud, exp and nonce are checked.
 */
function createOidcClient(cfg, fetchImpl = fetch) {
  let discovery;
  async function getDiscovery() {
    if (!discovery) {
      const res = await fetchImpl(`${cfg.issuer}/.well-known/openid-configuration`);
      if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
      discovery = await res.json();
    }
    return discovery;
  }

  function decodeJwtPayload(jwt) {
    const parts = String(jwt).split('.');
    if (parts.length !== 3) throw new Error('invalid id_token');
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  }

  return {
    async authorizationUrl() {
      const d = await getDiscovery();
      const state = crypto.randomBytes(16).toString('base64url');
      const nonce = crypto.randomBytes(16).toString('base64url');
      const url = new URL(d.authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: cfg.clientId,
        redirect_uri: cfg.redirectUri,
        scope: cfg.scope,
        state,
        nonce,
      }).toString();
      return { url: url.toString(), state, nonce };
    },

    /** Exchanges the code and returns normalized profile claims. */
    async handleCallback(code, expectedNonce) {
      const d = await getDiscovery();
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: cfg.redirectUri,
        client_id: cfg.clientId,
      });
      if (cfg.clientSecret) body.set('client_secret', cfg.clientSecret);
      const res = await fetchImpl(d.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
      const tokens = await res.json();
      const claims = decodeJwtPayload(tokens.id_token);
      const aud = [].concat(claims.aud);
      if (claims.iss !== (d.issuer || cfg.issuer)) throw new Error('issuer mismatch');
      if (!aud.includes(cfg.clientId)) throw new Error('audience mismatch');
      if (!claims.exp || claims.exp * 1000 < Date.now()) throw new Error('id_token expired');
      if (claims.nonce !== expectedNonce) throw new Error('nonce mismatch');
      return {
        sub: claims.sub,
        username: claims.preferred_username,
        email: claims.email,
        emailVerified: claims.email_verified === true,
        firstName: claims.given_name,
        lastName: claims.family_name,
        name: claims.name,
      };
    },
  };
}

module.exports = { createOidcClient };
