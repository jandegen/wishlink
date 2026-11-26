'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../../src/db');
const { createRepo } = require('../../src/repo');

function setup() {
  const repo = createRepo(openDatabase(':memory:'));
  const mk = (n) => repo.createUser({ username: n, firstName: n, lastName: 'T', email: `${n}@x.io`, passwordHash: 'h' });
  return { repo, owner: mk('owner'), bob: mk('bob'), carol: mk('carol') };
}
const wish = { title: 'Bike', description: '', links: [], priority: 1 };

test('unpublished wishes are invisible and cannot be claimed', () => {
  const { repo, owner, bob } = setup();
  const { id } = repo.createWish(owner, wish);
  assert.deepEqual(repo.listWishesForViewer(owner, bob).wishes, []);
  assert.equal(repo.setClaim(id, bob, 'gift'), 'not_found');
  repo.setPublished(id, owner, true);
  assert.equal(repo.listWishesForViewer(owner, bob).wishes.length, 1);
  assert.equal(repo.setClaim(id, bob, 'gift'), 'ok');
});

test('owner can neither claim nor view claim data of own wishes', () => {
  const { repo, owner, bob } = setup();
  const { id } = repo.createWish(owner, wish);
  repo.setPublished(id, owner, true);
  repo.setClaim(id, bob, 'purchased');
  assert.equal(repo.setClaim(id, owner, 'gift'), 'not_found');
  assert.equal(repo.listWishesForViewer(owner, owner), null);
  const own = repo.listOwnWishes(owner);
  assert.equal(own.length, 1);
  assert.ok(!JSON.stringify(own).includes('claim'));
  assert.ok(!JSON.stringify(repo.getOwnWish(id, owner)).includes('bob'));
});

test('other users see all claims; claim upsert replaces type; removal works', () => {
  const { repo, owner, bob, carol } = setup();
  const { id } = repo.createWish(owner, wish);
  repo.setPublished(id, owner, true);
  repo.setClaim(id, bob, 'gift');
  repo.setClaim(id, carol, 'contribute');
  repo.setClaim(id, bob, 'purchased');
  const claims = repo.listWishesForViewer(owner, carol).wishes[0].claims;
  assert.deepEqual(claims.map((c) => [c.username, c.type]), [['bob', 'purchased'], ['carol', 'contribute']]);
  repo.removeClaim(id, bob);
  assert.equal(repo.listWishesForViewer(owner, carol).wishes[0].claims.length, 1);
});

test('unpublishing hides wish; only owner may modify/delete', () => {
  const { repo, owner, bob } = setup();
  const { id } = repo.createWish(owner, wish);
  assert.equal(repo.updateWish(id, bob, wish), null);
  assert.equal(repo.setPublished(id, bob, true), false);
  assert.equal(repo.deleteWish(id, bob), false);
  repo.setPublished(id, owner, true);
  repo.setPublished(id, owner, false);
  assert.deepEqual(repo.listOwnersWithPublished(bob), []);
  assert.equal(repo.deleteWish(id, owner), true);
});

test('own wishes sorted by priority', () => {
  const { repo, owner } = setup();
  repo.createWish(owner, { ...wish, title: 'low', priority: 3 });
  repo.createWish(owner, { ...wish, title: 'high', priority: 1 });
  assert.deepEqual(repo.listOwnWishes(owner).map((w) => w.title), ['high', 'low']);
});

test('sessions expire', () => {
  const { repo, owner } = setup();
  repo.createSession('h', owner, 1000);
  assert.ok(repo.getSessionUser('h', 999));
  assert.equal(repo.getSessionUser('h', 1000), undefined);
});

test('links: multiple per wish, order kept, previews survive unchanged edits', () => {
  const { repo, owner, bob } = setup();
  const { id, pendingLinks } = repo.createWish(owner, { ...wish, links: ['https://a.example/1', 'https://b.example/2'] });
  assert.equal(pendingLinks.length, 2);
  repo.setLinkPreview(pendingLinks[0], { title: 'A', description: 'd', image: 'https://a.example/i.png', siteName: 'a.example' });
  repo.setLinkPreview(pendingLinks[1], null);
  let links = repo.getOwnWish(id, owner).links;
  assert.deepEqual(links.map((l) => [l.url, l.status]), [['https://a.example/1', 'ok'], ['https://b.example/2', 'failed']]);
  assert.equal(links[0].preview.title, 'A');
  assert.equal(links[1].preview, null);
  // reorder + add + remove: A keeps preview, failed one is retried, removed one is gone
  const pending = repo.updateWish(id, owner, { ...wish, links: ['https://c.example/3', 'https://a.example/1'] });
  links = repo.getOwnWish(id, owner).links;
  assert.deepEqual(links.map((l) => l.url), ['https://c.example/3', 'https://a.example/1']);
  assert.equal(links[1].status, 'ok');
  assert.equal(pending.length, 1);
  // visible to viewers only when published
  repo.setPublished(id, owner, true);
  assert.equal(repo.listWishesForViewer(owner, bob).wishes[0].links.length, 2);
});
