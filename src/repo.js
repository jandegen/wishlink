'use strict';

/**
 * Data access layer.
 *
 * PRIVACY INVARIANTS
 * - Functions that serve a wish OWNER (`listOwnWishes`, `getOwnWish`, update/publish/delete) never touch the
 *   `claims` table and only see rows with `suggested_by IS NULL`: an idea (`suggested_by` = another user) that
 *   someone added for the owner is invisible and untouchable for the owner.
 * - Claim data and ideas are only returned by `listWishesForViewer`, which refuses to serve a user's own list.
 * - Administrators have no wishes and cannot see anyone's: they are neither listed as owners nor allowed viewers.
 */
function createRepo(db) {
  const q = (sql) => db.prepare(sql);

  const userPublic = (u) => u && ({
    id: u.id, username: u.username, firstName: u.first_name, lastName: u.last_name, email: u.email || null,
    isAdmin: Boolean(u.is_admin), hasPassword: Boolean(u.password_hash),
  });

  const linkDto = (l) => ({
    id: l.id,
    url: l.url,
    status: l.preview_status,
    preview: l.preview_status === 'ok'
      ? { title: l.preview_title, description: l.preview_description, image: l.preview_image, siteName: l.preview_site }
      : null,
  });

  const wishDto = (w, links = []) => ({
    id: w.id,
    title: w.title,
    description: w.description,
    links: links.map(linkDto),
    priority: w.priority,
    published: Boolean(w.published),
    createdAt: w.created_at,
    updatedAt: w.updated_at,
  });

  const stmts = {
    insertUser: q(`INSERT INTO users (username, first_name, last_name, email, password_hash, oidc_sub, is_admin)
                   VALUES (?, ?, ?, ?, ?, ?, ?)`),
    setPassword: q('UPDATE users SET password_hash = ? WHERE id = ?'),
    setName: q('UPDATE users SET first_name = ?, last_name = ? WHERE id = ?'),
    deleteUser: q('DELETE FROM users WHERE id = ?'),
    adminUsers: q(`SELECT u.* FROM users u ORDER BY u.is_admin DESC, u.username COLLATE NOCASE`),
    deleteUserSessions: q('DELETE FROM sessions WHERE user_id = ?'),
    deleteOtherSessions: q('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
    userById: q('SELECT * FROM users WHERE id = ?'),
    userByLogin: q('SELECT * FROM users WHERE username = ? OR email = ?'),
    userByUsername: q('SELECT id FROM users WHERE username = ?'),
    userByEmail: q('SELECT * FROM users WHERE email = ?'),
    userBySub: q('SELECT * FROM users WHERE oidc_sub = ?'),
    setSub: q('UPDATE users SET oidc_sub = ? WHERE id = ?'),
    insertSession: q('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    sessionUser: q(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                    WHERE s.token_hash = ? AND s.expires_at > ?`),
    deleteSession: q('DELETE FROM sessions WHERE token_hash = ?'),
    purgeSessions: q('DELETE FROM sessions WHERE expires_at <= ?'),
    insertWish: q('INSERT INTO wishes (owner_id, title, description, priority) VALUES (?, ?, ?, ?)'),
    insertIdea: q('INSERT INTO wishes (owner_id, title, description, priority, published, suggested_by) VALUES (?, ?, ?, ?, 1, ?)'),
    ideaById: q('SELECT * FROM wishes WHERE id = ? AND suggested_by = ?'),
    updateIdea: q(`UPDATE wishes SET title = ?, description = ?, priority = ?, updated_at = datetime('now')
                   WHERE id = ? AND suggested_by = ?`),
    deleteIdea: q('DELETE FROM wishes WHERE id = ? AND suggested_by = ?'),
    linksOfWish: q('SELECT * FROM wish_links WHERE wish_id = ? ORDER BY position, id'),
    linksOfOwner: q(`SELECT l.* FROM wish_links l JOIN wishes w ON w.id = l.wish_id
                     WHERE w.owner_id = ? AND w.suggested_by IS NULL ORDER BY l.wish_id, l.position, l.id`),
    linksOfOwnerPublished: q(`SELECT l.* FROM wish_links l JOIN wishes w ON w.id = l.wish_id
                              WHERE w.owner_id = ? AND w.published = 1 ORDER BY l.wish_id, l.position, l.id`),
    insertLink: q('INSERT INTO wish_links (wish_id, url, position) VALUES (?, ?, ?)'),
    updateLinkPos: q('UPDATE wish_links SET position = ? WHERE id = ?'),
    deleteLink: q('DELETE FROM wish_links WHERE id = ?'),
    setLinkPreview: q(`UPDATE wish_links SET preview_status = ?, preview_title = ?, preview_description = ?,
                       preview_image = ?, preview_site = ? WHERE id = ?`),
    linkById: q('SELECT * FROM wish_links WHERE id = ?'),
    pendingLinks: q("SELECT id FROM wish_links WHERE preview_status = 'pending' LIMIT 200"),
    ownWishes: q(`SELECT * FROM wishes WHERE owner_id = ? AND suggested_by IS NULL
                  ORDER BY priority ASC, created_at DESC, id DESC`),
    ownWish: q('SELECT * FROM wishes WHERE id = ? AND owner_id = ? AND suggested_by IS NULL'),
    updateWish: q(`UPDATE wishes SET title = ?, description = ?, priority = ?,
                   updated_at = datetime('now') WHERE id = ? AND owner_id = ? AND suggested_by IS NULL`),
    setPublished: q(`UPDATE wishes SET published = ?, updated_at = datetime('now')
                     WHERE id = ? AND owner_id = ? AND suggested_by IS NULL`),
    deleteWish: q('DELETE FROM wishes WHERE id = ? AND owner_id = ? AND suggested_by IS NULL'),
    wishById: q('SELECT * FROM wishes WHERE id = ?'),
    // Everyone except the viewer and administrators (so that ideas can be added for people without published wishes).
    ownersWithPublished: q(`SELECT u.id, u.username, u.first_name, u.last_name, COUNT(w.id) AS wish_count
                            FROM users u LEFT JOIN wishes w ON w.owner_id = u.id AND w.published = 1
                            WHERE u.id != ? AND u.is_admin = 0 GROUP BY u.id ORDER BY u.first_name, u.last_name`),
    publishedWishesOf: q(`SELECT w.*, s.first_name AS s_first, s.last_name AS s_last, s.username AS s_user
                          FROM wishes w LEFT JOIN users s ON s.id = w.suggested_by
                          WHERE w.owner_id = ? AND w.published = 1
                          ORDER BY w.priority ASC, w.created_at DESC, w.id DESC`),
    claimsForWishes: q(`SELECT c.wish_id, c.user_id, c.type, c.created_at, u.username, u.first_name, u.last_name
                        FROM claims c JOIN users u ON u.id = c.user_id
                        WHERE c.wish_id IN (SELECT id FROM wishes WHERE owner_id = ? AND published = 1)
                        ORDER BY c.created_at ASC`),
    upsertClaim: q(`INSERT INTO claims (wish_id, user_id, type) VALUES (?, ?, ?)
                    ON CONFLICT(wish_id, user_id) DO UPDATE SET type = excluded.type`),
    deleteClaim: q('DELETE FROM claims WHERE wish_id = ? AND user_id = ?'),
  };

  const groupLinks = (rows) => {
    const m = new Map();
    for (const l of rows) {
      if (!m.has(l.wish_id)) m.set(l.wish_id, []);
      m.get(l.wish_id).push(l);
    }
    return m;
  };

  /** Reconciles a wish's links with `urls`: keeps rows (and their previews) for unchanged URLs. Returns ids needing a preview. */
  function syncLinks(wishId, urls) {
    const existing = stmts.linksOfWish.all(wishId);
    const byUrl = new Map(existing.map((l) => [l.url, l]));
    for (const l of existing) if (!urls.includes(l.url)) stmts.deleteLink.run(l.id);
    const pending = [];
    urls.forEach((url, i) => {
      const ex = byUrl.get(url);
      if (ex) {
        stmts.updateLinkPos.run(i, ex.id);
        if (ex.preview_status !== 'ok') pending.push(ex.id);
      } else {
        pending.push(Number(stmts.insertLink.run(wishId, url, i).lastInsertRowid));
      }
    });
    return pending;
  }

  return {
    getTheme: () => q("SELECT value FROM instance_settings WHERE key = 'theme'").get()?.value || 'default',
    setTheme: (theme) => q("INSERT INTO instance_settings (key, value) VALUES ('theme', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(theme),
    // ---- users ----
    createUser({ username, firstName, lastName, email = null, passwordHash = null, oidcSub = null, isAdmin = false }) {
      const r = stmts.insertUser.run(username, firstName, lastName, email || null, passwordHash, oidcSub, isAdmin ? 1 : 0);
      return Number(r.lastInsertRowid);
    },
    setPassword: (userId, passwordHash) => stmts.setPassword.run(passwordHash, userId).changes > 0,
    setName: (userId, firstName, lastName) => stmts.setName.run(firstName, lastName, userId).changes > 0,
    deleteUser: (userId) => stmts.deleteUser.run(userId).changes > 0,
    /** Admin overview. Deliberately contains NO wish contents and NO claim data. */
    listUsersForAdmin: () => stmts.adminUsers.all().map((u) => ({
      ...userPublic(u), oidc: Boolean(u.oidc_sub), createdAt: u.created_at,
    })),
    deleteSessionsOfUser: (userId, exceptHash = null) => (exceptHash
      ? stmts.deleteOtherSessions.run(userId, exceptHash) : stmts.deleteUserSessions.run(userId)),
    getUser: (id) => stmts.userById.get(id),
    findUserByLogin: (login) => stmts.userByLogin.get(login, login),
    findUserByEmail: (email) => stmts.userByEmail.get(email),
    findUserBySub: (sub) => stmts.userBySub.get(sub),
    linkOidcSub: (userId, sub) => stmts.setSub.run(sub, userId),
    usernameTaken: (username) => Boolean(stmts.userByUsername.get(username)),
    userPublic,

    // ---- sessions ----
    createSession: (tokenHash, userId, expiresAt) => stmts.insertSession.run(tokenHash, userId, expiresAt),
    getSessionUser: (tokenHash, now = Date.now()) => stmts.sessionUser.get(tokenHash, now),
    deleteSession: (tokenHash) => stmts.deleteSession.run(tokenHash),
    purgeSessions: (now = Date.now()) => stmts.purgeSessions.run(now),

    // ---- owner view (never exposes claims) ----
    /** Returns { id, pendingLinks }. */
    createWish(ownerId, w) {
      const id = Number(stmts.insertWish.run(ownerId, w.title, w.description, w.priority).lastInsertRowid);
      return { id, pendingLinks: syncLinks(id, w.links || []) };
    },
    listOwnWishes(ownerId) {
      const links = groupLinks(stmts.linksOfOwner.all(ownerId));
      return stmts.ownWishes.all(ownerId).map((w) => wishDto(w, links.get(w.id) || []));
    },
    getOwnWish(id, ownerId) {
      const w = stmts.ownWish.get(id, ownerId);
      return w ? wishDto(w, stmts.linksOfWish.all(id)) : null;
    },
    /** Returns null if not owned, else the ids of links that still need a preview. */
    updateWish(id, ownerId, w) {
      if (stmts.updateWish.run(w.title, w.description, w.priority, id, ownerId).changes === 0) return null;
      return syncLinks(id, w.links || []);
    },
    getLink: (id) => stmts.linkById.get(id),
    pendingLinkIds: () => stmts.pendingLinks.all().map((r) => r.id),
    setLinkPreview(id, preview) {
      if (preview) stmts.setLinkPreview.run('ok', preview.title, preview.description, preview.image, preview.siteName, id);
      else stmts.setLinkPreview.run('failed', null, null, null, null, id);
    },
    setPublished: (id, ownerId, published) => stmts.setPublished.run(published ? 1 : 0, id, ownerId).changes > 0,
    deleteWish: (id, ownerId) => stmts.deleteWish.run(id, ownerId).changes > 0,

    // ---- viewer side ----
    listOwnersWithPublished: (viewerId) => stmts.ownersWithPublished.all(viewerId).map((r) => ({
      id: r.id, username: r.username, firstName: r.first_name, lastName: r.last_name, wishCount: r.wish_count,
    })),

    /** Returns null if owner does not exist or is the viewer themself (owners must never see claims). */
    listWishesForViewer(ownerId, viewerId) {
      if (ownerId === viewerId) return null;
      const owner = stmts.userById.get(ownerId);
      if (!owner || owner.is_admin) return null;
      const links = groupLinks(stmts.linksOfOwnerPublished.all(ownerId));
      const claims = new Map();
      for (const c of stmts.claimsForWishes.all(ownerId)) {
        if (!claims.has(c.wish_id)) claims.set(c.wish_id, []);
        claims.get(c.wish_id).push({
          userId: c.user_id, username: c.username, firstName: c.first_name, lastName: c.last_name,
          type: c.type, createdAt: c.created_at,
        });
      }
      return {
        owner: { id: owner.id, username: owner.username, firstName: owner.first_name, lastName: owner.last_name },
        wishes: stmts.publishedWishesOf.all(ownerId).map((w) => ({
          ...wishDto(w, links.get(w.id) || []),
          suggestedBy: w.suggested_by
            ? { id: w.suggested_by, username: w.s_user, firstName: w.s_first, lastName: w.s_last } : null,
          claims: claims.get(w.id) || [],
        })),
      };
    },

    // ---- ideas (a wish suggested by `suggesterId` for another user; invisible to that user) ----
    /** Returns { id, pendingLinks }, or null if the target does not exist, is an admin or is the suggester. */
    createIdea(targetId, suggesterId, w) {
      const target = stmts.userById.get(targetId);
      if (!target || target.is_admin || targetId === suggesterId) return null;
      const id = Number(stmts.insertIdea.run(targetId, w.title, w.description, w.priority, suggesterId).lastInsertRowid);
      return { id, pendingLinks: syncLinks(id, w.links || []) };
    },
    getIdea(id, suggesterId) {
      const w = stmts.ideaById.get(id, suggesterId);
      return w ? wishDto(w, stmts.linksOfWish.all(id)) : null;
    },
    /** Only the suggester may change an idea. Returns null if not theirs, else the ids needing a preview. */
    updateIdea(id, suggesterId, w) {
      if (stmts.updateIdea.run(w.title, w.description, w.priority, id, suggesterId).changes === 0) return null;
      return syncLinks(id, w.links || []);
    },
    deleteIdea: (id, suggesterId) => stmts.deleteIdea.run(id, suggesterId).changes > 0,

    /** Claim a wish. Returns 'ok' | 'not_found'. Own and unpublished wishes count as not found. */
    setClaim(wishId, userId, type) {
      const w = stmts.wishById.get(wishId);
      if (!w || !w.published || w.owner_id === userId) return 'not_found';
      if (stmts.userById.get(w.owner_id)?.is_admin) return 'not_found';
      stmts.upsertClaim.run(wishId, userId, type);
      return 'ok';
    },
    removeClaim(wishId, userId) {
      const w = stmts.wishById.get(wishId);
      if (!w || w.owner_id === userId) return 'not_found';
      stmts.deleteClaim.run(wishId, userId);
      return 'ok';
    },
  };
}

module.exports = { createRepo };
