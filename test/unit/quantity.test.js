'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../../src/db');
const { createApp } = require('../../src/app');
const { loadConfig } = require('../../src/config');
const { createRateLimiter } = require('../../src/security');

async function start() {
  const app = createApp({
    db: openDatabase(':memory:'), config: loadConfig({}),
    rateLimiter: createRateLimiter({ max: 1000, windowMs: 1000 }), previewFetcher: async () => null,
  });
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
  return { client, db: app.locals.repo, close: () => server.close() };
}
async function member(s, name) {
  const c = s.client();
  const id = (await c('POST', '/api/auth/register', { username: name, password: 'password1', firstName: name, lastName: 'T' })).body.user.id;
  return { c, id };
}

test('quantity: owner sets how many are needed (default 1); claimers share the remainder', async (t) => {
  const s = await start(); t.after(s.close);
  const [owner, bob, carol, dave] = [await member(s, 'owner1'), await member(s, 'bobby'), await member(s, 'carol'), await member(s, 'davey')];
  const dflt = (await owner.c('POST', '/api/wishes', { title: 'one' })).body.wish;
  assert.equal(dflt.quantity, 1);
  const w = (await owner.c('POST', '/api/wishes', { title: 'chairs', quantity: 4 })).body.wish;
  assert.equal(w.quantity, 4);
  assert.equal((await owner.c('POST', '/api/wishes', { title: 'x', quantity: 0 })).body.error, 'invalid_quantity');
  await owner.c('PUT', `/api/wishes/${w.id}/published`, { published: true });
  const view = async (c) => (await c.c('GET', `/api/users/${owner.id}/wishes`)).body.wishes.find((x) => x.id === w.id);

  assert.equal((await bob.c('PUT', `/api/wishes/${w.id}/claim`, { type: 'gift', amount: 3 })).status, 204);
  let v = await view(carol);
  assert.deepEqual([v.quantity, v.taken, v.remaining], [4, 3, 1]);
  assert.equal(v.claims[0].amount, 3);
  // more than free -> refused; exactly the rest is fine
  const over = await carol.c('PUT', `/api/wishes/${w.id}/claim`, { type: 'gift', amount: 2 });
  assert.deepEqual([over.status, over.body.error], [409, 'too_many']);
  assert.equal((await carol.c('PUT', `/api/wishes/${w.id}/claim`, { type: 'gift', amount: 1 })).status, 204);
  assert.equal((await view(dave)).remaining, 0);
  assert.equal((await dave.c('PUT', `/api/wishes/${w.id}/claim`, { type: 'gift' })).status, 409);
  // a contribution takes nothing, even when everything is taken
  assert.equal((await dave.c('PUT', `/api/wishes/${w.id}/claim`, { type: 'contribute' })).status, 204);
  assert.equal((await view(dave)).remaining, 0);
  // changing one's own amount only counts the others
  assert.equal((await bob.c('PUT', `/api/wishes/${w.id}/claim`, { type: 'gift', amount: 2 })).status, 204);
  assert.equal((await view(carol)).remaining, 1);
  assert.equal((await bob.c('PUT', `/api/wishes/${w.id}/claim`, { type: 'gift', amount: 4 })).status, 409);
  // removing frees the items
  await bob.c('DELETE', `/api/wishes/${w.id}/claim`);
  assert.equal((await view(carol)).remaining, 3);
  for (const amount of [0, -1, 1.5, 100, 'x']) {
    assert.equal((await bob.c('PUT', `/api/wishes/${w.id}/claim`, { type: 'gift', amount })).body.error, 'invalid_amount');
  }
  // the owner learns nothing about taken / remaining
  const mine = JSON.stringify((await owner.c('GET', '/api/wishes/mine')).body);
  assert.ok(!/taken|remaining|amount|claims/.test(mine));
  // lowering the quantity below what is taken is allowed (owner must not learn about claims) -> remaining 0
  await owner.c('PUT', `/api/wishes/${w.id}`, { title: 'chairs', quantity: 1 });
  assert.equal((await view(carol)).remaining, 0);
});

test('quantity: ideas support it too; migration adds the columns', async (t) => {
  const s = await start(); t.after(s.close);
  const [owner, bob] = [await member(s, 'owner1'), await member(s, 'bobby')];
  const idea = (await bob.c('POST', `/api/users/${owner.id}/ideas`, { title: 'I', quantity: 2 })).body.wish;
  assert.equal(idea.quantity, 2);
  assert.equal((await bob.c('PUT', `/api/ideas/${idea.id}`, { title: 'I', quantity: 5 })).body.wish.quantity, 5);
  const db = openDatabase(':memory:');
  assert.ok(db.prepare('PRAGMA table_info(wishes)').all().some((c) => c.name === 'quantity'));
  assert.ok(db.prepare('PRAGMA table_info(claims)').all().some((c) => c.name === 'amount'));
});
