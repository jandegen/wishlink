'use strict';
const path = require('node:path');
const express = require('express');
const { createRepo } = require('./repo');
const { createOidcClient } = require('./oidc');
const { fetchPreview: defaultFetchPreview } = require('./preview');
const { hashPassword, verifyPassword, generatePassword, newToken, sha256, createRateLimiter } = require('./security');
const { ValidationError, validateRegistration, validateWish, validateClaimType, optionalUrl } = require('./validation');

const COOKIE = 'wl_session';
const OIDC_COOKIE = 'wl_oidc';

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createApp({ db, config, oidcClient, rateLimiter, previewFetcher }) {
  const repo = createRepo(db);
  const app = express();
  const oidc = oidcClient || (config.oidc.enabled ? createOidcClient(config.oidc) : null);
  const limiter = rateLimiter || createRateLimiter({ max: 20, windowMs: 60_000 });
  const fetchPreview = previewFetcher || ((url) => defaultFetchPreview(url, { allowPrivate: config.previewAllowPrivate }));
  const previewLimiter = createRateLimiter({ max: 30, windowMs: 60_000 });

  // Link previews are generated in the background after saving a wish.
  const inflight = new Set();
  const previews = {
    schedule(linkIds) {
      for (const id of linkIds) {
        const link = repo.getLink(id);
        if (!link) continue;
        const job = fetchPreview(link.url)
          .catch(() => null)
          .then((p) => { if (repo.getLink(id)) repo.setLinkPreview(id, p); })
          .catch((e) => console.error('preview update failed', e))
          .finally(() => inflight.delete(job));
        inflight.add(job);
      }
    },
    idle: async () => { while (inflight.size) await Promise.all([...inflight]); },
  };
  if (config.trustProxy) app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy':
        "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data: https: http:; frame-ancestors 'none'",
    });
    next();
  });
  app.use(express.json({ limit: '32kb' }));

  // CSRF defence in depth (SameSite=Lax cookie + origin check for state-changing requests).
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (origin) {
      let host;
      try { host = new URL(origin).host; } catch { host = null; }
      if (host !== req.get('host')) return next(new HttpError(403, 'forbidden_origin'));
    }
    next();
  });

  const setCookie = (res, name, value, maxAgeSec, extra = '') => {
    res.append('Set-Cookie',
      `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}` +
      `${config.cookieSecure ? '; Secure' : ''}${extra}`);
  };

  function startSession(res, userId) {
    const token = newToken();
    const ttl = config.sessionTtlHours * 3600;
    repo.createSession(sha256(token), userId, Date.now() + ttl * 1000);
    setCookie(res, COOKIE, token, ttl);
  }

  // Resolve current user (if any)
  app.use('/api', (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    req.user = token ? repo.getSessionUser(sha256(token)) || null : null;
    next();
  });
  const requireAuth = (req, res, next) => (req.user ? next() : next(new HttpError(401, 'unauthenticated')));
  const requireAdmin = (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'unauthenticated'));
    return req.user.is_admin ? next() : next(new HttpError(403, 'forbidden'));
  };
  const idParam = (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new HttpError(404, 'not_found');
    return id;
  };

  const api = express.Router();
  app.use('/api', api);

  api.get('/health', (req, res) => res.json({ status: 'ok' }));

  // ---------- auth ----------
  api.get('/auth/config', (req, res) => res.json({ oidc: Boolean(oidc) }));

  api.post('/auth/register', (req, res) => {
    if (!limiter.hit(`reg:${req.ip}`)) throw new HttpError(429, 'too_many_requests');
    const d = validateRegistration(req.body);
    if (repo.usernameTaken(d.username)) throw new HttpError(409, 'username_taken');
    if (repo.findUserByEmail(d.email)) throw new HttpError(409, 'email_taken');
    const id = repo.createUser({ ...d, passwordHash: hashPassword(d.password) });
    startSession(res, id);
    res.status(201).json({ user: repo.userPublic(repo.getUser(id)) });
  });

  api.post('/auth/login', (req, res) => {
    if (!limiter.hit(`login:${req.ip}`)) throw new HttpError(429, 'too_many_requests');
    const { login, password } = req.body || {};
    if (typeof login !== 'string' || typeof password !== 'string') throw new HttpError(400, 'required');
    const user = repo.findUserByLogin(login.trim());
    // Always run a hash comparison to keep timing similar for unknown users.
    const ok = verifyPassword(password, user ? user.password_hash : hashPassword('dummy-password'));
    if (!user || !ok) throw new HttpError(401, 'invalid_credentials');
    startSession(res, user.id);
    res.json({ user: repo.userPublic(user) });
  });

  api.post('/auth/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) repo.deleteSession(sha256(token));
    setCookie(res, COOKIE, '', 0);
    res.status(204).end();
  });

  // Change own password; other sessions of this user are signed out.
  api.post('/auth/password', requireAuth, (req, res) => {
    if (!limiter.hit(`pw:${req.user.id}`)) throw new HttpError(429, 'too_many_requests');
    const { currentPassword, newPassword } = req.body || {};
    if (typeof newPassword !== 'string' || newPassword.length < 8) throw new ValidationError('password_too_short', 'password');
    if (newPassword.length > 200) throw new ValidationError('too_long', 'password');
    if (!req.user.password_hash) throw new HttpError(400, 'no_local_password'); // OIDC-only account
    if (typeof currentPassword !== 'string' || !verifyPassword(currentPassword, req.user.password_hash)) {
      throw new HttpError(403, 'wrong_password');
    }
    repo.setPassword(req.user.id, hashPassword(newPassword));
    repo.deleteSessionsOfUser(req.user.id, sha256(parseCookies(req.headers.cookie)[COOKIE]));
    res.status(204).end();
  });

  api.get('/auth/me', requireAuth, (req, res) => res.json({ user: repo.userPublic(req.user) }));

  api.get('/auth/oidc/login', async (req, res, next) => {
    try {
      if (!oidc) throw new HttpError(404, 'oidc_disabled');
      const { url, state, nonce } = await oidc.authorizationUrl();
      setCookie(res, OIDC_COOKIE, `${state}.${nonce}`, 600);
      res.redirect(url);
    } catch (e) { next(e); }
  });

  api.get('/auth/oidc/callback', async (req, res, next) => {
    try {
      if (!oidc) throw new HttpError(404, 'oidc_disabled');
      const [state, nonce] = (parseCookies(req.headers.cookie)[OIDC_COOKIE] || '').split('.');
      if (!state || !nonce || req.query.state !== state || typeof req.query.code !== 'string') {
        throw new HttpError(400, 'invalid_oidc_state');
      }
      const p = await oidc.handleCallback(req.query.code, nonce);
      let user = repo.findUserBySub(p.sub);
      if (!user && p.email && p.emailVerified) {
        const byMail = repo.findUserByEmail(p.email);
        if (byMail && !byMail.oidc_sub) { repo.linkOidcSub(byMail.id, p.sub); user = byMail; }
      }
      if (!user) {
        if (!p.email) throw new HttpError(400, 'oidc_email_missing');
        if (repo.findUserByEmail(p.email)) throw new HttpError(409, 'email_taken');
        const base = (p.username || p.email.split('@')[0]).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 28) || 'user';
        let username = base;
        for (let i = 1; repo.usernameTaken(username); i++) username = `${base}${i}`;
        const [first = '', ...rest] = (p.name || '').split(' ');
        const id = repo.createUser({
          username,
          firstName: p.firstName || first || username,
          lastName: p.lastName || rest.join(' ') || '-',
          email: p.email,
          oidcSub: p.sub,
        });
        user = repo.getUser(id);
      }
      startSession(res, user.id);
      setCookie(res, OIDC_COOKIE, '', 0);
      res.redirect('/');
    } catch (e) { next(e); }
  });

  // ---------- owner: own wishes (never include claim data) ----------
  api.get('/wishes/mine', requireAuth, (req, res) => res.json({ wishes: repo.listOwnWishes(req.user.id) }));

  api.post('/wishes', requireAuth, (req, res) => {
    const { id, pendingLinks } = repo.createWish(req.user.id, validateWish(req.body));
    previews.schedule(pendingLinks);
    res.status(201).json({ wish: repo.getOwnWish(id, req.user.id) });
  });

  api.put('/wishes/:id', requireAuth, (req, res) => {
    const id = idParam(req);
    const pending = repo.updateWish(id, req.user.id, validateWish(req.body));
    if (!pending) throw new HttpError(404, 'not_found');
    previews.schedule(pending);
    res.json({ wish: repo.getOwnWish(id, req.user.id) });
  });

  api.put('/wishes/:id/published', requireAuth, (req, res) => {
    const id = idParam(req);
    if (typeof req.body?.published !== 'boolean') throw new HttpError(400, 'required');
    if (!repo.setPublished(id, req.user.id, req.body.published)) throw new HttpError(404, 'not_found');
    res.json({ wish: repo.getOwnWish(id, req.user.id) });
  });

  api.delete('/wishes/:id', requireAuth, (req, res) => {
    if (!repo.deleteWish(idParam(req), req.user.id)) throw new HttpError(404, 'not_found');
    res.status(204).end();
  });

  // Live preview for the link input in the wish form (own session only, rate limited).
  api.post('/preview', requireAuth, async (req, res, next) => {
    try {
      if (!previewLimiter.hit(`prev:${req.user.id}`)) throw new HttpError(429, 'too_many_requests');
      const url = optionalUrl(req.body?.url);
      if (!url) throw new HttpError(400, 'required');
      res.json({ preview: await fetchPreview(url) });
    } catch (e) { next(e); }
  });

  // ---------- other users' wishes ----------
  api.get('/users', requireAuth, (req, res) => res.json({ users: repo.listOwnersWithPublished(req.user.id) }));

  api.get('/users/:id/wishes', requireAuth, (req, res) => {
    const data = repo.listWishesForViewer(idParam(req), req.user.id);
    if (!data) throw new HttpError(404, 'not_found');
    res.json(data);
  });

  api.put('/wishes/:id/claim', requireAuth, (req, res) => {
    const id = idParam(req);
    const type = validateClaimType(req.body?.type);
    if (repo.setClaim(id, req.user.id, type) === 'not_found') throw new HttpError(404, 'not_found');
    res.status(204).end();
  });

  api.delete('/wishes/:id/claim', requireAuth, (req, res) => {
    if (repo.removeClaim(idParam(req), req.user.id) === 'not_found') throw new HttpError(404, 'not_found');
    res.status(204).end();
  });

  // ---------- administration ----------
  // Admins manage accounts only: no access to wish contents or claims through these endpoints.
  api.get('/admin/users', requireAdmin, (req, res) => res.json({ users: repo.listUsersForAdmin() }));

  api.post('/admin/users/:id/password', requireAdmin, (req, res) => {
    const id = idParam(req);
    const target = repo.getUser(id);
    if (!target) throw new HttpError(404, 'not_found');
    let password = req.body?.password;
    const generated = password === undefined || password === null || password === '';
    if (generated) password = generatePassword(12);
    else if (typeof password !== 'string' || password.length < 8) throw new ValidationError('password_too_short', 'password');
    else if (password.length > 200) throw new ValidationError('too_long', 'password');
    repo.setPassword(id, hashPassword(password));
    repo.deleteSessionsOfUser(id); // sign the user out everywhere
    console.log(`admin ${req.user.username} reset the password of ${target.username}`);
    res.json(generated ? { password } : {});
  });

  api.delete('/admin/users/:id', requireAdmin, (req, res) => {
    const id = idParam(req);
    if (id === req.user.id) throw new HttpError(400, 'cannot_delete_self');
    const target = repo.getUser(id);
    if (!target) throw new HttpError(404, 'not_found');
    repo.deleteUser(id); // wishes, claims and sessions are removed by ON DELETE CASCADE
    console.log(`admin ${req.user.username} deleted user ${target.username}`);
    res.status(204).end();
  });

  api.use((req, res, next) => next(new HttpError(404, 'not_found')));

  // ---------- static frontend ----------
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '5m' }));
  app.get('*', (req, res, next) => (req.path.startsWith('/api') ? next() : res.sendFile(
    path.join(__dirname, '..', 'public', 'index.html'))));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.code, field: err.field });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large' });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.code });
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  });

  app.locals.repo = repo;
  app.locals.previews = previews;
  return app;
}

module.exports = { createApp };
