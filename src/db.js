'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  oidc_sub TEXT UNIQUE,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wishes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  url TEXT,
  priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wishes_owner ON wishes(owner_id);
CREATE TABLE IF NOT EXISTS wish_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wish_id INTEGER NOT NULL REFERENCES wishes(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  preview_status TEXT NOT NULL DEFAULT 'pending' CHECK (preview_status IN ('pending','ok','failed')),
  preview_title TEXT,
  preview_description TEXT,
  preview_image TEXT,
  preview_site TEXT
);
CREATE INDEX IF NOT EXISTS idx_wish_links_wish ON wish_links(wish_id);
CREATE TABLE IF NOT EXISTS claims (
  wish_id INTEGER NOT NULL REFERENCES wishes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('gift','contribute','purchased')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (wish_id, user_id)
);
`;

const USER_COLUMNS = 'id, username, first_name, last_name, email, password_hash, oidc_sub, is_admin, created_at';

/**
 * Migration: the e-mail address became optional (registration no longer asks for it). SQLite cannot drop a NOT NULL
 * constraint, so the table is rebuilt (the documented 12-step procedure): foreign keys are switched off while the old
 * table is replaced, otherwise dropping it would cascade-delete every wish, claim and session. ids and the AUTOINCREMENT
 * counter are preserved, existing e-mail addresses stay (they still work as a login name).
 */
function migrateEmailOptional(db) {
  const col = db.prepare('PRAGMA table_info(users)').all().find((c) => c.name === 'email');
  if (!col || !col.notnull) return;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'users'").get();
    db.exec(`CREATE TABLE users_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT UNIQUE COLLATE NOCASE,
      password_hash TEXT,
      oidc_sub TEXT UNIQUE,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.exec(`INSERT INTO users_new (${USER_COLUMNS}) SELECT ${USER_COLUMNS} FROM users`);
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_new RENAME TO users');
    if (seq) {
      db.exec("DELETE FROM sqlite_sequence WHERE name = 'users'");
      db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('users', ?)").run(seq.seq);
    }
    const broken = db.prepare('PRAGMA foreign_key_check').all();
    if (broken.length) throw new Error(`foreign key check failed after users migration (${broken.length} rows)`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // Migration: admin flag for databases created before admin support.
  if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'is_admin')) {
    db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
  }
  migrateEmailOptional(db);
  // Migration: ideas. A wish with `suggested_by` set is an idea someone else added FOR the owner (owner_id);
  // the owner never sees it. (Deleting the suggester removes their ideas.)
  if (!db.prepare('PRAGMA table_info(wishes)').all().some((c) => c.name === 'suggested_by')) {
    db.exec('ALTER TABLE wishes ADD COLUMN suggested_by INTEGER REFERENCES users(id) ON DELETE CASCADE');
  }
  // Migrate the legacy single `wishes.url` into wish_links (idempotent).
  db.exec(`INSERT INTO wish_links (wish_id, url, position)
           SELECT id, url, 0 FROM wishes WHERE url IS NOT NULL AND url != '';
           UPDATE wishes SET url = NULL WHERE url IS NOT NULL;`);
  return db;
}

module.exports = { openDatabase };
