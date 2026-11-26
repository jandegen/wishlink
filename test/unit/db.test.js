'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase } = require('../../src/db');
const { createRepo } = require('../../src/repo');

test('legacy wishes.url is migrated into wish_links exactly once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-db-'));
  const file = path.join(dir, 'legacy.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    first_name TEXT NOT NULL, last_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT,
    oidc_sub TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE wishes (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '', url TEXT, priority INTEGER NOT NULL DEFAULT 2, published INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO users (username, first_name, last_name, email) VALUES ('a','A','A','a@x.io');
    INSERT INTO wishes (owner_id, title, url) VALUES (1, 'With link', 'https://shop.example/x'), (1, 'No link', NULL);`);
  old.close();

  for (let i = 0; i < 2; i++) { // opening twice must not duplicate
    const db = openDatabase(file);
    const wishes = createRepo(db).listOwnWishes(1);
    assert.deepEqual(wishes.find((w) => w.title === 'With link').links.map((l) => [l.url, l.status]), [['https://shop.example/x', 'pending']]);
    assert.deepEqual(wishes.find((w) => w.title === 'No link').links, []);
    db.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pendingLinkIds lists links awaiting a preview', () => {
  const repo = createRepo(openDatabase(':memory:'));
  const u = repo.createUser({ username: 'p', firstName: 'P', lastName: 'P', email: 'p@x.io', passwordHash: 'h' });
  const { pendingLinks } = repo.createWish(u, { title: 't', description: '', priority: 2, links: ['https://a.b/1', 'https://a.b/2'] });
  repo.setLinkPreview(pendingLinks[0], null);
  assert.deepEqual(repo.pendingLinkIds(), [pendingLinks[1]]);
});
