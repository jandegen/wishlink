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

// ---- e-mail became optional: table rebuild must not lose anything ----
const LEGACY_SCHEMA = `
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  first_name TEXT NOT NULL, last_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT,
  oidc_sub TEXT UNIQUE, is_admin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE wishes (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', url TEXT, priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
  published INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE wish_links (id INTEGER PRIMARY KEY AUTOINCREMENT, wish_id INTEGER NOT NULL REFERENCES wishes(id) ON DELETE CASCADE, url TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0, preview_status TEXT NOT NULL DEFAULT 'pending', preview_title TEXT, preview_description TEXT, preview_image TEXT, preview_site TEXT);
CREATE TABLE claims (wish_id INTEGER NOT NULL REFERENCES wishes(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (wish_id, user_id));
INSERT INTO users (id, username, first_name, last_name, email, password_hash, oidc_sub, is_admin) VALUES
  (1, 'jan', 'Jan', 'D', 'Jan@Example.com', 'scrypt$aa$bb', NULL, 1),
  (2, 'test', 'Te', 'St', 'test@example.com', 'scrypt$cc$dd', 'kc-sub-2', 0),
  (7, 'gone', 'Go', 'Ne', 'gone@example.com', NULL, NULL, 0);
DELETE FROM users WHERE id = 7;                    -- AUTOINCREMENT counter is now ahead of max(id)
INSERT INTO sessions VALUES ('hash1', 1, 9999999999999), ('hash2', 2, 9999999999999);
INSERT INTO wishes (id, owner_id, title, published) VALUES (10, 1, 'Fahrrad', 1), (11, 2, 'Buch', 0);
INSERT INTO wish_links (wish_id, url, position, preview_status, preview_title) VALUES (10, 'https://shop.example/bike', 0, 'ok', 'Bike');
INSERT INTO claims (wish_id, user_id, type) VALUES (10, 2, 'gift');`;

function legacyDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-mig-'));
  const file = path.join(dir, 'legacy.db');
  const old = new DatabaseSync(file);
  old.exec(LEGACY_SCHEMA);
  old.close();
  return { dir, file };
}

test('migration (e-mail optional): every user, session, wish, link and claim survives; ids and relations intact', () => {
  const { dir, file } = legacyDb();
  const db = openDatabase(file);
  const rows = (sql) => db.prepare(sql).all();
  assert.deepEqual(rows('SELECT id, username, email, is_admin, oidc_sub FROM users ORDER BY id').map((u) => [u.id, u.username, u.email, u.is_admin, u.oidc_sub]),
    [[1, 'jan', 'Jan@Example.com', 1, null], [2, 'test', 'test@example.com', 0, 'kc-sub-2']]);
  assert.deepEqual(rows('SELECT token_hash, user_id FROM sessions ORDER BY token_hash').map((r) => [r.token_hash, r.user_id]), [['hash1', 1], ['hash2', 2]]);
  assert.deepEqual(rows('SELECT id, owner_id, title FROM wishes ORDER BY id').map((r) => [r.id, r.owner_id, r.title]), [[10, 1, 'Fahrrad'], [11, 2, 'Buch']]);
  assert.equal(rows('SELECT * FROM claims').length, 1);
  assert.equal(rows('SELECT preview_title FROM wish_links')[0].preview_title, 'Bike'); // cached previews kept
  assert.equal(rows('PRAGMA foreign_key_check').length, 0);
  assert.equal(rows('PRAGMA foreign_keys')[0].foreign_keys, 1, 'foreign keys are switched back on');
  assert.ok(!rows('PRAGMA table_info(users)').find((c) => c.name === 'email').notnull, 'e-mail is nullable now');

  // the application layer still works on the migrated data
  const repo = createRepo(db);
  assert.equal(repo.findUserByLogin('jan@example.com').id, 1);          // legacy login by e-mail (case-insensitive)
  assert.equal(repo.findUserByLogin('TEST').id, 2);                       // and by username
  assert.equal(repo.getSessionUser('hash1', 1).username, 'jan');
  assert.equal(repo.listWishesForViewer(1, 2).wishes[0].claims[0].username, 'test'); // claim relation intact

  // new users need no e-mail, several can have none, ids continue after the old counter (no id re-use)
  const a = repo.createUser({ username: 'n1', firstName: 'N', lastName: '1', passwordHash: 'h' });
  const b = repo.createUser({ username: 'n2', firstName: 'N', lastName: '2', passwordHash: 'h' });
  assert.ok(a >= 8 && b === a + 1, `ids ${a},${b} must continue after the old AUTOINCREMENT counter`);
  assert.equal(repo.getUser(a).email, null);
  assert.throws(() => repo.createUser({ username: 'dup', firstName: 'D', lastName: 'D', email: 'jan@example.com', passwordHash: 'h' }), /UNIQUE/); // e-mail still unique

  // ON DELETE CASCADE still works after the rebuild
  repo.deleteUser(2);
  assert.equal(rows('SELECT * FROM claims').length, 0);
  assert.equal(rows('SELECT * FROM sessions WHERE user_id = 2').length, 0);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migration (e-mail optional) is idempotent and leaves a fresh database alone', () => {
  const { dir, file } = legacyDb();
  openDatabase(file).close();
  const again = openDatabase(file);                                     // second start: nothing to do
  assert.equal(createRepo(again).listOwnWishes(1).length, 1);
  assert.equal(again.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
  again.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const fresh = openDatabase(':memory:');
  assert.ok(!fresh.prepare('PRAGMA table_info(users)').all().find((c) => c.name === 'email').notnull);
});

test('migration (e-mail optional) rolls back completely on failure', () => {
  const { dir, file } = legacyDb();
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE users_new (x INTEGER)');                       // blocks the rebuild: name already taken
  old.close();
  assert.throws(() => openDatabase(file));
  const check = new DatabaseSync(file);
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2, 'users untouched');
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM wishes').get().n, 2, 'wishes untouched');
  check.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
