'use strict';

/** Reads configuration from environment variables (12-factor). */
function loadConfig(env = process.env) {
  const int = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
  const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));
  const publicUrl = (env.PUBLIC_URL || `http://localhost:${int(env.PORT, 3000)}`).replace(/\/+$/, '');
  return {
    port: int(env.PORT, 3000),
    databasePath: env.DATABASE_PATH || './data/wishlink.db',
    publicUrl,
    // Who runs this instance (shown in the privacy notice: "your data is stored on <operator>'s server").
    operatorName: (env.OPERATOR_NAME || '').trim().slice(0, 80),
    sessionTtlHours: int(env.SESSION_TTL_HOURS, 24 * 14),
    cookieSecure: bool(env.COOKIE_SECURE, publicUrl.startsWith('https://')),
    // Max. registrations / logins per minute and IP (brute-force protection); raised only for automated tests.
    authRateLimit: int(env.AUTH_RATE_LIMIT, 20),
    trustProxy: bool(env.TRUST_PROXY, false),
    // Link previews refuse internal addresses (SSRF protection); only enable for tests / trusted setups.
    previewAllowPrivate: bool(env.PREVIEW_ALLOW_PRIVATE, false),
    // Initial admin account, created at startup if it does not exist yet (never overwrites an existing user).
    admin: {
      username: env.ADMIN_USERNAME || 'admin',
      email: env.ADMIN_EMAIL || '',
      password: env.ADMIN_PASSWORD || '',
    },
    oidc: {
      enabled: Boolean(env.OIDC_ISSUER && env.OIDC_CLIENT_ID),
      issuer: (env.OIDC_ISSUER || '').replace(/\/+$/, ''),
      clientId: env.OIDC_CLIENT_ID || '',
      clientSecret: env.OIDC_CLIENT_SECRET || '',
      redirectUri: env.OIDC_REDIRECT_URI || `${publicUrl}/api/auth/oidc/callback`,
      scope: env.OIDC_SCOPE || 'openid profile email',
    },
  };
}

module.exports = { loadConfig };
