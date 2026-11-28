'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase } = require('../../src/db');
const { createRepo } = require('../../src/repo');

test('migration: "purchased" claims become "gift" - same users, amounts, timestamps; nothing else changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-merge-'));
  const file = path.join(dir, 'w.db');
  // a database as the previous version left it (with all three claim types)
  const old = openDatabase(file);
  const repo = createRepo(old);
  const mk = (u) => repo.createUser({ username: u, firstName: u, lastName: 'T', passwordHash: 'h' });
  const [owner, a, b, c, d] = ['owner', 'anna', 'ben', 'cara', 'dan'].map(mk);
  const { id } = repo.createWish(owner, { title: 'Chairs', description: '', links: [], priority: 1, quantity: 6 });
  repo.setPublished(id, owner, true);
  old.exec(`INSERT INTO claims (wish_id, user_id, type, amount, created_at) VALUES
    (${id}, ${a}, 'purchased', 2, '2026-01-01 10:00:00'),
    (${id}, ${b}, 'gift', 1, '2026-01-02 10:00:00'),
    (${id}, ${c}, 'contribute', 1, '2026-01-03 10:00:00')`);
  old.exec(`UPDATE claims SET contribution_cents = 1500 WHERE user_id = ${c}`);
  const before = old.prepare('SELECT * FROM claims ORDER BY user_id').all().map((r) => ({ ...r }));
  old.close();

  const db = openDatabase(file); // start of the new version
  const after = db.prepare('SELECT * FROM claims ORDER BY user_id').all().map((r) => ({ ...r }));
  assert.equal(after.length, before.length, 'no claim lost');
  for (let i = 0; i < before.length; i++) {
    assert.deepEqual({ ...after[i], type: null }, { ...before[i], type: null }, 'everything but the type is untouched');
  }
  assert.deepEqual(after.map((r) => r.type), ['gift', 'gift', 'contribute']);
  // the stock stays the same: 'purchased' counted like 'gift' before
  const view = createRepo(db).listWishesForViewer(owner, d).wishes[0];
  assert.deepEqual([view.taken, view.remaining], [3, 3]);
  assert.equal(view.claims.find((x) => x.userId === c).contributionCents, 1500);
  db.close();

  const again = openDatabase(file); // idempotent
  assert.deepEqual(again.prepare('SELECT type FROM claims ORDER BY user_id').all().map((r) => r.type), ['gift', 'gift', 'contribute']);
  assert.equal(again.prepare('PRAGMA foreign_key_check').all().length, 0);
  again.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
