'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../../src/db');
const { createRepo } = require('../../src/repo');
const { createApp } = require('../../src/app');
const { loadConfig } = require('../../src/config');
const { ensureAdmin } = require('../../src/bootstrap');
const { hashPassword, verifyPassword, createRateLimiter } = require('../../src/security');

const quiet = { log() {}, error() {} };
const adminCfg = { username: 'admin', email: 'admin@x.io', password: 'admin-pass-1' };

test('bootstrap: disabled without password, creates once, never promotes or resets existing users', () => {
  const repo = createRepo(openDatabase(':memory:'));
  assert.equal(ensureAdmin(repo, { ...adminCfg, password: '' }, quiet), 'disabled');
  assert.equal(ensureAdmin(repo, { ...adminCfg, password: 'short' }, quiet), 'invalid');
  assert.equal(ensureAdmin(repo, adminCfg, quiet), 'created');
  const admin = repo.findUserByLogin('admin');
  assert.equal(admin.is_admin, 1);
  assert.ok(verifyPassword('admin-pass-1', admin.password_hash));
  // second start: untouched, even when the configured password changed
  assert.equal(ensureAdmin(repo, { ...adminCfg, password: 'different-pass' }, quiet), 'exists');
  assert.ok(verifyPassword('admin-pass-1', repo.findUserByLogin('admin').password_hash));

  // somebody registered "boss" first -> must NOT become admin
  repo.createUser({ username: 'boss', firstName: 'B', lastName: 'B', email: 'b@x.io', passwordHash: hashPassword('pw123456') });
  assert.equal(ensureAdmin(repo, { ...adminCfg, username: 'boss', email: 'new@x.io' }, quiet), 'conflict');
  assert.equal(repo.findUserByLogin('boss').is_admin, 0);
});

test('bootstrap: the admin e-mail is optional', () => {
  const repo = createRepo(openDatabase(':memory:'));
  assert.equal(ensureAdmin(repo, { username: 'root', email: '', password: 'admin-pass-1' }, quiet), 'created');
  assert.equal(repo.findUserByLogin('root').email, null);
});

test('migration adds is_admin to legacy databases', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-adm-'));
  const file = path.join(dir, 'l.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    first_name TEXT NOT NULL, last_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT,
    oidc_sub TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO users (username, first_name, last_name, email) VALUES ('a','A','A','a@x.io');`);
  old.close();
  const db = openDatabase(file);
  assert.equal(createRepo(db).findUserByLogin('a').is_admin, 0);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function start() {
  const db = openDatabase(':memory:');
  const repo = createRepo(db);
  ensureAdmin(repo, adminCfg, quiet);
  const app = createApp({
    db, config: loadConfig({}), rateLimiter: createRateLimiter({ max: 1000, windowMs: 1000 }), previewFetcher: async () => null,
  });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
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
  return { client, repo, close: () => server.close() };
}
const reg = (n) => ({ username: n, firstName: n, lastName: 'T', password: 'password1' });

test('admin endpoints: only admins; users list has no wish/claim data', async (t) => {
  const s = await start(); t.after(s.close);
  const [admin, bob, anon] = [s.client(), s.client(), s.client()];
  assert.equal((await anon('GET', '/api/admin/users')).status, 401);
  await bob('POST', '/api/auth/register', reg('bobby'));
  assert.equal((await bob('GET', '/api/admin/users')).status, 403);
  assert.equal((await bob('DELETE', '/api/admin/users/1')).status, 403);
  assert.equal((await bob('POST', '/api/admin/users/1/password', { password: 'hacked-pass' })).status, 403);

  const login = await admin('POST', '/api/auth/login', { login: 'admin', password: 'admin-pass-1' });
  assert.equal(login.body.user.isAdmin, true);
  assert.equal((await bob('GET', '/api/auth/me')).body.user.isAdmin, false);
  const list = (await admin('GET', '/api/admin/users')).body.users;
  assert.deepEqual(list.map((u) => u.username), ['admin', 'bobby']);
  assert.ok(!/claim|password_hash|hash/i.test(JSON.stringify(list)));
});

test('admin resets passwords (given or generated) and signs the user out', async (t) => {
  const s = await start(); t.after(s.close);
  const [admin, bob] = [s.client(), s.client()];
  const bobId = (await bob('POST', '/api/auth/register', reg('bobby'))).body.user.id;
  await admin('POST', '/api/auth/login', { login: 'admin', password: 'admin-pass-1' });

  assert.equal((await admin('POST', `/api/admin/users/${bobId}/password`, { password: 'x' })).status, 400);
  assert.equal((await admin('POST', '/api/admin/users/999/password', {})).status, 404);
  const gen = await admin('POST', `/api/admin/users/${bobId}/password`, {});
  assert.equal(gen.status, 200);
  assert.equal(gen.body.password.length, 12);
  assert.equal((await bob('GET', '/api/auth/me')).status, 401); // old session is gone
  assert.equal((await bob('POST', '/api/auth/login', { login: 'bobby', password: 'password1' })).status, 401);
  assert.equal((await bob('POST', '/api/auth/login', { login: 'bobby', password: gen.body.password })).status, 200);

  const set = await admin('POST', `/api/admin/users/${bobId}/password`, { password: 'chosen-pass-1' });
  assert.deepEqual(set.body, {}); // chosen passwords are never echoed back
  assert.equal((await bob('POST', '/api/auth/login', { login: 'bobby', password: 'chosen-pass-1' })).status, 200);
});

test('admin deletes users incl. their wishes and claims, but not themself', async (t) => {
  const s = await start(); t.after(s.close);
  const [admin, bob, carol, dave] = [s.client(), s.client(), s.client(), s.client()];
  const bobId = (await bob('POST', '/api/auth/register', reg('bobby'))).body.user.id;
  const carolId = (await carol('POST', '/api/auth/register', reg('carol'))).body.user.id;
  const daveId = (await dave('POST', '/api/auth/register', reg('davey'))).body.user.id;
  const wish = (await bob('POST', '/api/wishes', { title: 'W' })).body.wish;
  await bob('PUT', `/api/wishes/${wish.id}/published`, { published: true });
  await carol('PUT', `/api/wishes/${wish.id}/claim`, { type: 'gift' });
  await admin('POST', '/api/auth/login', { login: 'admin', password: 'admin-pass-1' });
  const adminId = (await admin('GET', '/api/auth/me')).body.user.id;

  assert.equal((await admin('DELETE', `/api/admin/users/${adminId}`)).body.error, 'cannot_delete_self');
  assert.equal((await admin('DELETE', '/api/admin/users/999')).status, 404);
  assert.equal((await admin('DELETE', `/api/admin/users/${bobId}`)).status, 204);
  assert.equal((await bob('GET', '/api/auth/me')).status, 401);
  assert.equal((await carol('GET', `/api/users/${bobId}/wishes`)).status, 404);
  assert.ok(!(await carol('GET', '/api/users')).body.users.some((u) => u.id === bobId));
  // deleting the claimer removes the claim only
  const w2 = (await dave('POST', '/api/wishes', { title: 'A' })).body.wish;
  await dave('PUT', `/api/wishes/${w2.id}/published`, { published: true });
  await carol('PUT', `/api/wishes/${w2.id}/claim`, { type: 'gift' });
  assert.equal((await admin('DELETE', `/api/admin/users/${carolId}`)).status, 204);
  assert.deepEqual(s.repo.listWishesForViewer(daveId, 9999).wishes[0].claims, []); // carol's claim was removed with her
  assert.equal(s.repo.getOwnWish(w2.id, daveId).title, 'A');
});

test('change own password: needs current password, signs out other sessions', async (t) => {
  const s = await start(); t.after(s.close);
  const [a1, a2] = [s.client(), s.client()];
  await a1('POST', '/api/auth/register', reg('anna'));
  await a2('POST', '/api/auth/login', { login: 'anna', password: 'password1' });
  assert.equal((await a1('POST', '/api/auth/password', { currentPassword: 'nope', newPassword: 'new-password-1' })).body.error, 'wrong_password');
  assert.equal((await a1('POST', '/api/auth/password', { currentPassword: 'password1', newPassword: 'short' })).body.error, 'password_too_short');
  assert.equal((await a1('POST', '/api/auth/password', { currentPassword: 'password1', newPassword: 'new-password-1' })).status, 204);
  assert.equal((await a1('GET', '/api/auth/me')).status, 200); // current session stays
  assert.equal((await a2('GET', '/api/auth/me')).status, 401); // other session is gone
  assert.equal((await a2('POST', '/api/auth/login', { login: 'anna', password: 'new-password-1' })).status, 200);
});

test('instance theme: public read, admin-only writes and strict validation', async (t) => {
  const s = await start(); t.after(s.close);
  const [admin, member, anon] = [s.client(), s.client(), s.client()];
  assert.deepEqual((await anon('GET', '/api/settings')).body, { theme: 'default' });
  assert.equal((await anon('PUT', '/api/admin/settings', { theme: 'christmas' })).status, 401);
  await member('POST', '/api/auth/register', reg('member'));
  assert.equal((await member('PUT', '/api/admin/settings', { theme: 'christmas' })).status, 403);
  await admin('POST', '/api/auth/login', { login: 'admin', password: 'admin-pass-1' });
  for (const theme of ['', null, true, {}, 'unknown']) {
    assert.equal((await admin('PUT', '/api/admin/settings', { theme })).status, 400);
  }
  assert.deepEqual((await admin('PUT', '/api/admin/settings', { theme: 'christmas' })).body, { theme: 'christmas' });
  assert.deepEqual((await anon('GET', '/api/settings')).body, { theme: 'christmas' });
  assert.equal((await admin('PUT', '/api/admin/settings', {})).status, 400);
  assert.deepEqual((await anon('GET', '/api/settings')).body, { theme: 'christmas' });
  assert.deepEqual((await admin('PUT', '/api/admin/settings', { theme: 'default' })).body, { theme: 'default' });
});

test('instance theme survives database reopening and schema migration', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-theme-'));
  const file = path.join(dir, 'theme.db');
  let db;
  try {
    db = openDatabase(file);
    createRepo(db).setTheme('christmas');
    db.close();
    db = openDatabase(file);
    assert.equal(createRepo(db).getTheme(), 'christmas');
  } finally { db?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
