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

test('comments: visible to everybody except the owner; only the author deletes', async (t) => {
  const s = await start(); t.after(s.close);
  const [owner, bob, carol] = [await member(s, 'owner1'), await member(s, 'bobby'), await member(s, 'carol')];
  const w = (await owner.c('POST', '/api/wishes', { title: 'Bike' })).body.wish;
  // unpublished: nobody can comment
  assert.equal((await bob.c('POST', `/api/wishes/${w.id}/comments`, { body: 'hi' })).status, 404);
  await owner.c('PUT', `/api/wishes/${w.id}/published`, { published: true });

  const made = await bob.c('POST', `/api/wishes/${w.id}/comments`, { body: '  Ich frage mal nach der Größe.  ' });
  assert.equal(made.status, 201);
  assert.equal(made.body.comment.body, 'Ich frage mal nach der Größe.');
  await carol.c('POST', `/api/wishes/${w.id}/comments`, { body: 'Gute Idee' });
  assert.equal((await bob.c('POST', `/api/wishes/${w.id}/comments`, { body: '   ' })).body.error, 'required');
  assert.equal((await bob.c('POST', `/api/wishes/${w.id}/comments`, { body: 'x'.repeat(1001) })).body.error, 'too_long');

  const seen = (await carol.c('GET', `/api/users/${owner.id}/wishes`)).body.wishes[0].comments;
  assert.deepEqual(seen.map((m) => [m.username, m.body]), [['bobby', 'Ich frage mal nach der Größe.'], ['carol', 'Gute Idee']]);

  // the owner: no comments, in no response, and cannot add or delete any
  const mine = JSON.stringify([(await owner.c('GET', '/api/wishes/mine')).body,
    (await owner.c('PUT', `/api/wishes/${w.id}`, { title: 'Bike 2' })).body]);
  assert.ok(!/comment|Größe|Gute Idee|bobby|carol/i.test(mine));
  assert.equal((await owner.c('POST', `/api/wishes/${w.id}/comments`, { body: 'self' })).status, 404);
  assert.equal((await owner.c('DELETE', `/api/comments/${made.body.comment.id}`)).status, 404);

  // only the author may delete
  assert.equal((await carol.c('DELETE', `/api/comments/${made.body.comment.id}`)).status, 404);
  assert.equal((await bob.c('DELETE', `/api/comments/${made.body.comment.id}`)).status, 204);
  assert.equal((await carol.c('GET', `/api/users/${owner.id}/wishes`)).body.wishes[0].comments.length, 1);
  // unpublishing hides the comments with the wish; deleting the author removes theirs
  s.db.deleteUser(carol.id);
  assert.equal((await bob.c('GET', `/api/users/${owner.id}/wishes`)).body.wishes[0].comments.length, 0);
  assert.equal((await owner.c('DELETE', `/api/wishes/${w.id}`)).status, 204);
});

test('comments: work on ideas; admin cannot comment', async (t) => {
  const s = await start(); t.after(s.close);
  const [owner, bob, carol] = [await member(s, 'owner1'), await member(s, 'bobby'), await member(s, 'carol')];
  const idea = (await bob.c('POST', `/api/users/${owner.id}/ideas`, { title: 'I' })).body.wish;
  assert.equal((await carol.c('POST', `/api/wishes/${idea.id}/comments`, { body: 'nice' })).status, 201);
  assert.equal((await owner.c('POST', `/api/wishes/${idea.id}/comments`, { body: 'peek' })).status, 404);
  const { ensureAdmin } = require('../../src/bootstrap');
  ensureAdmin(s.db, { username: 'admin', password: 'admin-pass-1' }, { log() {}, error() {} });
  const admin = s.client();
  await admin('POST', '/api/auth/login', { login: 'admin', password: 'admin-pass-1' });
  assert.equal((await admin('POST', `/api/wishes/${idea.id}/comments`, { body: 'x' })).body.error, 'admin_no_wishes');
});

test('contribution: "I contribute" can state how much; shown to others, never to the owner', async (t) => {
  const s = await start(); t.after(s.close);
  const [owner, bob, carol] = [await member(s, 'owner1'), await member(s, 'bobby'), await member(s, 'carol')];
  const w = (await owner.c('POST', '/api/wishes', { title: 'Bike', quantity: 2 })).body.wish;
  await owner.c('PUT', `/api/wishes/${w.id}/published`, { published: true });
  const claims = async () => (await carol.c('GET', `/api/users/${owner.id}/wishes`)).body.wishes[0].claims;

  assert.equal((await bob.c('PUT', `/api/wishes/${w.id}/claim`, { type: 'contribute', contribution: '20,5' })).status, 204);
  assert.equal((await claims())[0].contributionCents, 2050);
  assert.equal((await claims())[0].amount, 1);
  // optional
  assert.equal((await carol.c('PUT', `/api/wishes/${w.id}/claim`, { type: 'contribute' })).status, 204);
  assert.equal((await claims()).find((c) => c.username === 'carol').contributionCents, null);
  // taking nothing away from the stock
  assert.equal((await carol.c('GET', `/api/users/${owner.id}/wishes`)).body.wishes[0].remaining, 2);
  // switching to gift drops the amount of money
  await bob.c('PUT', `/api/wishes/${w.id}/claim`, { type: 'gift' });
  assert.equal((await claims()).find((c) => c.username === 'bobby').contributionCents, null);
  for (const contribution of [0, -5, 'abc', 100001]) {
    assert.equal((await bob.c('PUT', `/api/wishes/${w.id}/claim`, { type: 'contribute', contribution })).body.error, 'invalid_contribution');
  }
  assert.ok(!/contribution|cent/i.test(JSON.stringify((await owner.c('GET', '/api/wishes/mine')).body)));
});

test('migration adds comments table and contribution column', () => {
  const db = openDatabase(':memory:');
  assert.ok(db.prepare('PRAGMA table_info(claims)').all().some((c) => c.name === 'contribution_cents'));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'wish_comments'").get().n, 1);
});
