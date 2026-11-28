'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../../src/db');
const { createApp } = require('../../src/app');
const { loadConfig } = require('../../src/config');
const { ensureAdmin } = require('../../src/bootstrap');
const { createRateLimiter } = require('../../src/security');

async function start() {
  const db = openDatabase(':memory:');
  const app = createApp({
    db, config: loadConfig({}), rateLimiter: createRateLimiter({ max: 1000, windowMs: 1000 }), previewFetcher: async () => null,
  });
  ensureAdmin(app.locals.repo, { username: 'admin', password: 'admin-pass-1' }, { log() {}, error() {} });
  const server = await new Promise((r) => { const sv = app.listen(0, () => r(sv)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, url, body) => {
      const res = await fetch(base + url, {
        method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const sc = res.headers.getSetCookie().find((c) => c.startsWith('wl_session='));
      if (sc) cookie = sc.split(';')[0];
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
  };
  return { client, repo: app.locals.repo, close: () => server.close() };
}
const reg = (u) => ({ username: u, password: 'password1', firstName: u, lastName: 'Test' });
async function member(s, name) {
  const c = s.client();
  const id = (await c('POST', '/api/auth/register', reg(name))).body.user.id;
  return { c, id };
}

test('profile: users change first and last name', async (t) => {
  const s = await start(); t.after(s.close);
  const a = await member(s, 'anna1');
  const r = await a.c('PUT', '/api/auth/profile', { firstName: '  Anna-Lena ', lastName: 'Meier' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.user.firstName, r.body.user.lastName, r.body.user.username], ['Anna-Lena', 'Meier', 'anna1']);
  assert.equal((await a.c('GET', '/api/auth/me')).body.user.lastName, 'Meier');
  assert.equal((await a.c('PUT', '/api/auth/profile', { firstName: '', lastName: 'X' })).body.error, 'required');
  assert.equal((await a.c('PUT', '/api/auth/profile', { firstName: 'x'.repeat(81), lastName: 'X' })).body.error, 'too_long');
  assert.equal((await s.client()('PUT', '/api/auth/profile', { firstName: 'A', lastName: 'B' })).status, 401);
});

test('admin has no wishes and sees no wishes of others', async (t) => {
  const s = await start(); t.after(s.close);
  const bob = await member(s, 'bobby');
  await bob.c('PUT', `/api/wishes/${(await bob.c('POST', '/api/wishes', { title: 'W' })).body.wish.id}/published`, { published: true });
  const admin = s.client();
  await admin('POST', '/api/auth/login', { login: 'admin', password: 'admin-pass-1' });
  for (const [m, u, b] of [['GET', '/api/wishes/mine'], ['POST', '/api/wishes', { title: 'x' }], ['GET', '/api/users'],
    ['GET', `/api/users/${bob.id}/wishes`], ['PUT', '/api/wishes/1/claim', { type: 'gift' }], ['POST', `/api/users/${bob.id}/ideas`, { title: 'x' }]]) {
    const r = await admin(m, u, b);
    assert.equal(r.status, 403, `${m} ${u}`);
    assert.equal(r.body.error, 'admin_no_wishes');
  }
  // the account list carries no wish data, and admins are nobody's wish list
  assert.ok(!JSON.stringify((await admin('GET', '/api/admin/users')).body).includes('wishCount'));
  const adminId = (await admin('GET', '/api/auth/me')).body.user.id;
  assert.ok(!(await bob.c('GET', '/api/users')).body.users.some((u) => u.id === adminId));
  assert.equal((await bob.c('GET', `/api/users/${adminId}/wishes`)).status, 404);
  assert.equal((await bob.c('POST', `/api/users/${adminId}/ideas`, { title: 'x' })).status, 404);
});

test('ideas: visible to everybody except the person they are for', async (t) => {
  const s = await start(); t.after(s.close);
  const [owner, bob, carol] = [await member(s, 'owner1'), await member(s, 'bobby'), await member(s, 'carol')];
  const own = (await owner.c('POST', '/api/wishes', { title: 'Own wish' })).body.wish;
  await owner.c('PUT', `/api/wishes/${own.id}/published`, { published: true });

  // bob adds an idea for owner (links work as for wishes)
  const made = await bob.c('POST', `/api/users/${owner.id}/ideas`, { title: 'Secret idea', links: ['https://x.io'], priority: 1 });
  assert.equal(made.status, 201);
  const idea = made.body.wish;
  assert.equal(idea.title, 'Secret idea');
  assert.equal(idea.links.length, 1);

  // carol sees it (marked with the suggester, claimable); bob too
  const seen = (await carol.c('GET', `/api/users/${owner.id}/wishes`)).body.wishes;
  assert.deepEqual(seen.map((w) => w.title).sort(), ['Own wish', 'Secret idea']);
  const seenIdea = seen.find((w) => w.id === idea.id);
  assert.equal(seenIdea.suggestedBy.id, bob.id);
  assert.equal(seen.find((w) => w.id === own.id).suggestedBy, null);
  assert.equal((await carol.c('PUT', `/api/wishes/${idea.id}/claim`, { type: 'gift' })).status, 204);
  assert.equal((await bob.c('GET', `/api/users/${owner.id}/wishes`)).body.wishes.find((w) => w.id === idea.id).claims[0].username, 'carol');

  // the owner never sees it, in no way
  const mine = await owner.c('GET', '/api/wishes/mine');
  assert.deepEqual(mine.body.wishes.map((w) => w.title), ['Own wish']);
  assert.ok(!/Secret|carol|bobby/.test(JSON.stringify(mine.body)));
  assert.equal(s.repo.getOwnWish(idea.id, owner.id), null);
  assert.equal((await owner.c('PUT', `/api/wishes/${idea.id}`, { title: 'hijack' })).status, 404);
  assert.equal((await owner.c('PUT', `/api/wishes/${idea.id}/published`, { published: false })).status, 404);
  assert.equal((await owner.c('DELETE', `/api/wishes/${idea.id}`)).status, 404);
  assert.equal((await owner.c('PUT', `/api/ideas/${idea.id}`, { title: 'hijack' })).status, 404);
  assert.equal((await owner.c('DELETE', `/api/ideas/${idea.id}`)).status, 404);
  assert.equal((await owner.c('GET', `/api/users/${owner.id}/wishes`)).status, 404);
  assert.equal((await owner.c('PUT', `/api/wishes/${idea.id}/claim`, { type: 'gift' })).status, 404);
  assert.equal(s.repo.getIdea(idea.id, bob.id).title, 'Secret idea');
});

test('ideas: only the suggester edits / deletes; not for yourself; users without wishes are listed', async (t) => {
  const s = await start(); t.after(s.close);
  const [owner, bob, carol] = [await member(s, 'owner1'), await member(s, 'bobby'), await member(s, 'carol')];
  assert.equal((await owner.c('POST', `/api/users/${owner.id}/ideas`, { title: 'self' })).status, 404);
  assert.equal((await bob.c('POST', '/api/users/9999/ideas', { title: 'x' })).status, 404);
  assert.equal((await bob.c('POST', `/api/users/${owner.id}/ideas`, { title: '' })).status, 400);
  // owner has no wishes at all but can still be given ideas -> listed, with the idea counted
  const idea = (await bob.c('POST', `/api/users/${owner.id}/ideas`, { title: 'I' })).body.wish;
  assert.equal((await carol.c('GET', '/api/users')).body.users.find((u) => u.id === owner.id).wishCount, 1);
  assert.equal((await carol.c('PUT', `/api/ideas/${idea.id}`, { title: 'hack' })).status, 404);
  assert.equal((await carol.c('DELETE', `/api/ideas/${idea.id}`)).status, 404);
  const up = await bob.c('PUT', `/api/ideas/${idea.id}`, { title: 'I2', description: 'd', priority: 3 });
  assert.equal(up.body.wish.title, 'I2');
  assert.equal((await bob.c('DELETE', `/api/ideas/${idea.id}`)).status, 204);
  assert.equal((await carol.c('GET', `/api/users/${owner.id}/wishes`)).body.wishes.length, 0);
  // deleting the suggester removes their ideas
  await bob.c('POST', `/api/users/${owner.id}/ideas`, { title: 'gone soon' });
  s.repo.deleteUser(bob.id);
  assert.equal((await carol.c('GET', `/api/users/${owner.id}/wishes`)).body.wishes.length, 0);
});

test('migration: wishes.suggested_by is added to existing databases', () => {
  const db = openDatabase(':memory:');
  assert.ok(db.prepare('PRAGMA table_info(wishes)').all().some((c) => c.name === 'suggested_by'));
});
