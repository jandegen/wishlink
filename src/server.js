'use strict';
const { loadConfig } = require('./config');
const { openDatabase } = require('./db');
const { createApp } = require('./app');
const { createRepo } = require('./repo');
const { ensureAdmin } = require('./bootstrap');

const config = loadConfig();
const db = openDatabase(config.databasePath);
ensureAdmin(createRepo(db), config.admin);
const app = createApp({ db, config });

const server = app.listen(config.port, () => {
  console.log(`WishLink listening on :${config.port} (OIDC ${config.oidc.enabled ? 'enabled' : 'disabled'})`);
});

// Fetch previews for links that are still pending (e.g. migrated from the single-URL schema).
app.locals.previews.schedule(app.locals.repo.pendingLinkIds());

const purge = setInterval(() => app.locals.repo.purgeSessions(), 3600_000);
purge.unref();

function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
