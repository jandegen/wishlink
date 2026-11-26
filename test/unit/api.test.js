'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../../src/db');
const { createApp } = require('../../src/app');
const { loadConfig } = require('../../src/config');
const { createRateLimiter } = require('../../src/security');

async function start(opts = {}) {
  const app = createApp({
    db: openDatabase(':memory:'), config: loadConfig({}),
    rateLimiter: createRateLimiter({ max: 1000, windowMs: 1000 }),
    previewFetcher: async () => null, ...opts,
  });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, url, body) => {
      const res = await fetch(base + url, {
        method, redirect: 'manual',
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const sc = res.headers.getSetCookie().find((c) => c.startsWith('wl_session='));
      if (sc) cookie = sc.split(';')[0];
      const text = await res.text();
      return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
    };
  };
  return { base, client, app, close: () => server.close() };
}

const user = (n) => ({ username: n, firstName: n, lastName: 'Test', password: 'password1' });

test('auth: register, me, logout, login, errors', async (t) => {
  const s = await start(); t.after(s.close);
  const c = s.client();
  assert.equal((await c('GET', '/api/auth/me')).status, 401);
  assert.equal((await c('POST', '/api/auth/register', user('anna'))).status, 201);
  assert.equal((await c('GET', '/api/auth/me')).body.user.username, 'anna');
  assert.ok(!JSON.stringify((await c('GET', '/api/auth/me')).body).includes('password'));
  assert.equal((await c('POST', '/api/auth/logout')).status, 204);
  assert.equal((await c('GET', '/api/auth/me')).status, 401);
  assert.equal((await c('POST', '/api/auth/login', { login: 'ANNA', password: 'password1' })).status, 200); // case-insensitive
  assert.equal((await c('POST', '/api/auth/login', { login: 'anna', password: 'bad' })).status, 401);
  assert.equal((await c('POST', '/api/auth/register', user('anna'))).body.error, 'username_taken');
  assert.equal((await c('POST', '/api/auth/register', { ...user('xxx2'), password: '1' })).body.error, 'password_too_short');
});

test('login is rate limited', async (t) => {
  const s = await start({ rateLimiter: createRateLimiter({ max: 2, windowMs: 60000 }) }); t.after(s.close);
  const c = s.client();
  await c('POST', '/api/auth/login', { login: 'a', password: 'b' });
  await c('POST', '/api/auth/login', { login: 'a', password: 'b' });
  assert.equal((await c('POST', '/api/auth/login', { login: 'a', password: 'b' })).status, 429);
});

test('protected routes need auth; cross-origin writes are rejected', async (t) => {
  const s = await start(); t.after(s.close);
  const c = s.client();
  for (const [m, u] of [['GET', '/api/wishes/mine'], ['GET', '/api/users'], ['POST', '/api/wishes'], ['PUT', '/api/wishes/1/claim']]) {
    assert.equal((await c(m, u, m === 'GET' ? undefined : {})).status, 401, `${m} ${u}`);
  }
  const res = await fetch(`${s.base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}',
  });
  assert.equal(res.status, 403);
});

test('privacy: owner never sees claims; others do', async (t) => {
  const s = await start(); t.after(s.close);
  const [owner, bob, carol] = [s.client(), s.client(), s.client()];
  const ownerId = (await owner('POST', '/api/auth/register', user('owner'))).body.user.id;
  await bob('POST', '/api/auth/register', user('bob'));
  await carol('POST', '/api/auth/register', user('carol'));

  const w = (await owner('POST', '/api/wishes', { title: 'Bike', description: 'red', links: ['https://x.io'], priority: 1 })).body.wish;
  assert.equal(w.published, false);
  // draft is invisible and not claimable
  assert.deepEqual((await bob('GET', '/api/users')).body.users, []);
  assert.deepEqual((await bob('GET', `/api/users/${ownerId}/wishes`)).body.wishes, []);
  assert.equal((await bob('PUT', `/api/wishes/${w.id}/claim`, { type: 'gift' })).status, 404);

  await owner('PUT', `/api/wishes/${w.id}/published`, { published: true });
  assert.equal((await bob('GET', '/api/users')).body.users[0].wishCount, 1);
  assert.equal((await bob('PUT', `/api/wishes/${w.id}/claim`, { type: 'gift' })).status, 204);
  assert.equal((await carol('PUT', `/api/wishes/${w.id}/claim`, { type: 'contribute' })).status, 204);
  assert.equal((await bob('PUT', `/api/wishes/${w.id}/claim`, { type: 'bogus' })).status, 400);

  const seen = (await carol('GET', `/api/users/${ownerId}/wishes`)).body.wishes[0].claims;
  assert.deepEqual(seen.map((x) => [x.username, x.type]), [['bob', 'gift'], ['carol', 'contribute']]);

  // owner: no claim info anywhere, no way to fetch it
  const mine = await owner('GET', '/api/wishes/mine');
  assert.ok(!/claim|bob|carol|gift|contribute/i.test(JSON.stringify(mine.body)));
  assert.equal((await owner('GET', `/api/users/${ownerId}/wishes`)).status, 404);
  assert.equal((await owner('PUT', `/api/wishes/${w.id}/claim`, { type: 'gift' })).status, 404);
  assert.equal((await owner('GET', '/api/users')).body.users.length, 0);
  const upd = await owner('PUT', `/api/wishes/${w.id}`, { title: 'Bike 2', priority: 3 });
  assert.ok(!/claim|bob|carol/i.test(JSON.stringify(upd.body)));

  // removing a claim
  assert.equal((await bob('DELETE', `/api/wishes/${w.id}/claim`)).status, 204);
  assert.equal((await carol('GET', `/api/users/${ownerId}/wishes`)).body.wishes[0].claims.length, 1);
});

test('only the owner can edit, publish or delete a wish', async (t) => {
  const s = await start(); t.after(s.close);
  const [a, b] = [s.client(), s.client()];
  await a('POST', '/api/auth/register', user('alice1'));
  await b('POST', '/api/auth/register', user('bobby1'));
  const w = (await a('POST', '/api/wishes', { title: 'T' })).body.wish;
  assert.equal((await b('PUT', `/api/wishes/${w.id}`, { title: 'hack' })).status, 404);
  assert.equal((await b('PUT', `/api/wishes/${w.id}/published`, { published: true })).status, 404);
  assert.equal((await b('DELETE', `/api/wishes/${w.id}`)).status, 404);
  assert.equal((await a('POST', '/api/wishes', { title: 'T', links: ['javascript:x'] })).status, 400);
  assert.equal((await a('DELETE', `/api/wishes/${w.id}`)).status, 204);
  assert.equal((await a('GET', '/api/wishes/mine')).body.wishes.length, 0);
});

test('serves frontend, security headers, health, spa fallback', async (t) => {
  const s = await start(); t.after(s.close);
  const idx = await fetch(`${s.base}/`);
  assert.match(await idx.text(), /WishLink/);
  assert.equal(idx.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(`${s.base}/api/health`)).status, 200);
  assert.equal((await fetch(`${s.base}/api/nope`)).status, 404);
  assert.equal((await fetch(`${s.base}/i18n/de.json`)).status, 200);
});

test('i18n files have identical keys', () => {
  const de = require('../../public/i18n/de.json');
  const en = require('../../public/i18n/en.json');
  assert.deepEqual(Object.keys(de).sort(), Object.keys(en).sort());
});

test('OIDC flow (mocked provider): creates user, then logs in again', async (t) => {
  const calls = [];
  const oidcClient = {
    async authorizationUrl() { return { url: 'https://kc.example/auth', state: 'st', nonce: 'no' }; },
    async handleCallback(code, nonce) {
      calls.push([code, nonce]);
      return { sub: 'kc-1', username: 'kcuser', email: 'kc@x.io', emailVerified: true, firstName: 'Kay', lastName: 'Cee' };
    },
  };
  const s = await start({ oidcClient }); t.after(s.close);
  assert.equal((await fetch(`${s.base}/api/auth/config`).then((r) => r.json())).oidc, true);
  const login = await fetch(`${s.base}/api/auth/oidc/login`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  const oidcCookie = login.headers.getSetCookie()[0].split(';')[0];
  const bad = await fetch(`${s.base}/api/auth/oidc/callback?state=wrong&code=c`, { headers: { cookie: oidcCookie } });
  assert.equal(bad.status, 400);
  const cb = await fetch(`${s.base}/api/auth/oidc/callback?state=st&code=abc`, { redirect: 'manual', headers: { cookie: oidcCookie } });
  assert.equal(cb.status, 302);
  assert.deepEqual(calls[0], ['abc', 'no']);
  const session = cb.headers.getSetCookie().find((c) => c.startsWith('wl_session=')).split(';')[0];
  const me = await fetch(`${s.base}/api/auth/me`, { headers: { cookie: session } }).then((r) => r.json());
  assert.equal(me.user.username, 'kcuser');
  await fetch(`${s.base}/api/auth/oidc/callback?state=st&code=abc`, { redirect: 'manual', headers: { cookie: oidcCookie } });
  assert.equal(calls.length, 2); // second login re-uses the same user
});

test('OIDC disabled by default', async (t) => {
  const s = await start(); t.after(s.close);
  assert.equal((await fetch(`${s.base}/api/auth/oidc/login`)).status, 404);
});

test('links: previews are generated in background and served to owner and viewers', async (t) => {
  const fake = async (url) => (url.includes('good')
    ? { title: 'Nice Bike', description: 'A bike', image: 'https://cdn.example/b.png', siteName: 'shop.example' } : null);
  const calls = [];
  const s = await start({ previewFetcher: async (u) => { calls.push(u); return fake(u); } }); t.after(s.close);
  const [owner, bob] = [s.client(), s.client()];
  const ownerId = (await owner('POST', '/api/auth/register', user('linker'))).body.user.id;
  await bob('POST', '/api/auth/register', user('viewer'));
  const created = (await owner('POST', '/api/wishes', {
    title: 'Bike', links: ['https://good.example/a', 'https://bad.example/b'],
  })).body.wish;
  assert.deepEqual(created.links.map((l) => l.status), ['pending', 'pending']);
  await s.app.locals.previews.idle();
  const mine = (await owner('GET', '/api/wishes/mine')).body.wishes[0];
  assert.equal(mine.links[0].preview.title, 'Nice Bike');
  assert.equal(mine.links[1].status, 'failed');
  await owner('PUT', `/api/wishes/${created.id}/published`, { published: true });
  const seen = (await bob('GET', `/api/users/${ownerId}/wishes`)).body.wishes[0];
  assert.equal(seen.links[0].preview.image, 'https://cdn.example/b.png');
  // editing without changing a good link does not refetch it
  calls.length = 0;
  await owner('PUT', `/api/wishes/${created.id}`, { title: 'Bike', links: ['https://good.example/a'] });
  await s.app.locals.previews.idle();
  assert.deepEqual(calls, []);
});

test('POST /api/preview needs auth and a valid url', async (t) => {
  const s = await start({ previewFetcher: async () => ({ title: 'T', description: '', image: null, siteName: 's' }) }); t.after(s.close);
  const c = s.client();
  assert.equal((await c('POST', '/api/preview', { url: 'https://a.b' })).status, 401);
  await c('POST', '/api/auth/register', user('prev1'));
  assert.equal((await c('POST', '/api/preview', { url: 'https://a.b' })).body.preview.title, 'T');
  assert.equal((await c('POST', '/api/preview', { url: 'file:///etc/passwd' })).status, 400);
  assert.equal((await c('POST', '/api/preview', {})).status, 400);
});

test('registration without e-mail: account has none; accounts created earlier with an e-mail can still log in with it', async (t) => {
  const s = await start(); t.after(s.close);
  const c = s.client();
  const reg = await c('POST', '/api/auth/register', user('newbie'));
  assert.equal(reg.status, 201);
  assert.equal(reg.body.user.email, null);
  await c('POST', '/api/auth/logout');
  assert.equal((await c('POST', '/api/auth/login', { login: 'newbie', password: 'password1' })).status, 200);
  // two accounts without e-mail do not collide on the unique column
  assert.equal((await s.client()('POST', '/api/auth/register', user('newbie2'))).status, 201);
  // a legacy account (e-mail set) keeps working: login by e-mail, case-insensitive
  const { hashPassword } = require('../../src/security');
  s.app.locals.repo.createUser({ username: 'oldtimer', firstName: 'O', lastName: 'T', email: 'Old@Example.com', passwordHash: hashPassword('legacy-pass-1') });
  const l = await s.client()('POST', '/api/auth/login', { login: 'old@example.com', password: 'legacy-pass-1' });
  assert.equal(l.status, 200);
  assert.equal(l.body.user.email, 'Old@Example.com');
});

test('OIDC: an IdP without e-mail still creates an account (e-mail is optional)', async (t) => {
  const oidcClient = {
    async authorizationUrl() { return { url: 'https://kc.example/auth', state: 'st', nonce: 'no' }; },
    async handleCallback() { return { sub: 'kc-noemail', username: 'mailless', firstName: 'No', lastName: 'Mail' }; },
  };
  const s = await start({ oidcClient }); t.after(s.close);
  const login = await fetch(`${s.base}/api/auth/oidc/login`, { redirect: 'manual' });
  const oidcCookie = login.headers.getSetCookie()[0].split(';')[0];
  const cb = await fetch(`${s.base}/api/auth/oidc/callback?state=st&code=abc`, { redirect: 'manual', headers: { cookie: oidcCookie } });
  assert.equal(cb.status, 302);
  const session = cb.headers.getSetCookie().find((c) => c.startsWith('wl_session=')).split(';')[0];
  const me = await fetch(`${s.base}/api/auth/me`, { headers: { cookie: session } }).then((r) => r.json());
  assert.equal(me.user.username, 'mailless');
  assert.equal(me.user.email, null);
});

test('auth config exposes the operator name for the privacy notice (null when not configured)', async (t) => {
  const s = await start(); t.after(s.close);
  assert.equal((await s.client()('GET', '/api/auth/config')).body.operator, null);
  const named = await start({ config: loadConfig({ OPERATOR_NAME: '  Erika Mustermann ' }) }); t.after(named.close);
  assert.equal((await named.client()('GET', '/api/auth/config')).body.operator, 'Erika Mustermann');
});
