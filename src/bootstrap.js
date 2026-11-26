'use strict';
const { hashPassword } = require('./security');

/**
 * Creates the initial admin account from configuration.
 * - Only ever creates a NEW user; an existing user is never promoted and its password never reset
 *   (otherwise someone who registered the admin name first would become admin).
 * @returns {'disabled'|'created'|'exists'|'conflict'|'invalid'}
 */
function ensureAdmin(repo, admin, log = console) {
  if (!admin.password) return 'disabled';
  if (admin.password.length < 8 || !/^[A-Za-z0-9_.-]{3,32}$/.test(admin.username)) {
    log.error('ADMIN_USERNAME / ADMIN_PASSWORD invalid (username 3-32 chars [A-Za-z0-9_.-], password >= 8 chars)');
    return 'invalid';
  }
  const existing = repo.findUserByLogin(admin.username);
  if (existing) {
    if (existing.is_admin) return 'exists';
    log.error(`Admin bootstrap skipped: user "${admin.username}" already exists and is not an admin`);
    return 'conflict';
  }
  if (repo.findUserByEmail(admin.email)) {
    log.error(`Admin bootstrap skipped: email ${admin.email} is already in use`);
    return 'conflict';
  }
  repo.createUser({
    username: admin.username, firstName: 'Admin', lastName: 'WishLink', email: admin.email,
    passwordHash: hashPassword(admin.password), isAdmin: true,
  });
  log.log(`Admin account "${admin.username}" created`);
  return 'created';
}

module.exports = { ensureAdmin };
