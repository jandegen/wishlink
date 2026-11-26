#!/usr/bin/env node
'use strict';
/**
 * Publishes release assets as a GitHub Release (CI job release-github).
 *
 * Every file is copied to a staging directory, text files get the MIRROR_REWRITES / --rewrite substitutions
 * (internal registry and host names become public ones), and the result is scanned by guard.js (secrets,
 * known secret values, MIRROR_FORBIDDEN_PATTERNS; .tar.gz contents too). A hit aborts before GitHub is contacted.
 * The release is created for an existing tag; a re-run replaces assets of the same name.
 *
 * Environment: GITHUB_MIRROR_URL (https://github.com/<owner>/<repo>.git), GITHUB_MIRROR_TOKEN (Contents: write),
 * MIRROR_FORBIDDEN_PATTERNS, optional MIRROR_REWRITES.
 * Usage: publish-github-release.js --tag vX.Y.Z [--name N] [--notes T] [--rewrite old=>new]... files...
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guard = require('./guard');

const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';

function repository(url) {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url || '');
  if (!m) throw new Error('GITHUB_MIRROR_URL must look like https://github.com/<owner>/<repo>.git');
  return m[1];
}

/** Copies files to `dir`, rewriting text files. Returns the staged paths. */
function stage(files, rewrites, dir) {
  return files.map((src) => {
    const target = path.join(dir, path.basename(src));
    const buf = fs.readFileSync(src);
    const ext = path.extname(src).toLowerCase();
    if (['.json', '.yml', '.yaml', '.md', '.txt', ''].includes(ext) && !buf.includes(0)) {
      let text = guard.applyRewrites(buf.toString('utf8'), rewrites);
      if (ext === '.json') JSON.parse(text); // must stay valid
      fs.writeFileSync(target, text);
    } else fs.writeFileSync(target, buf);
    return target;
  });
}

function client(repo, token, fetchImpl = fetch) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const call = async (url, { method = 'GET', json, body, type } = {}) => {
    const res = await fetchImpl(url, {
      method, body: json !== undefined ? JSON.stringify(json) : body,
      headers: { ...headers, ...(json !== undefined ? { 'Content-Type': 'application/json' } : type ? { 'Content-Type': type } : {}) },
    });
    if (res.status === 404 && method === 'GET') return null;
    if (!res.ok) throw new Error(`GitHub ${method} failed (HTTP ${res.status})`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
  return {
    async release(tag, name, notes) {
      return (await call(`${API}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`))
        || call(`${API}/repos/${repo}/releases`, { method: 'POST', json: { tag_name: tag, name, body: notes, draft: false, prerelease: false } });
    },
    async upload(release, file) {
      const name = path.basename(file);
      for (const a of release.assets || []) if (a.name === name) await call(`${API}/repos/${repo}/releases/assets/${a.id}`, { method: 'DELETE' });
      await call(`${UPLOADS}/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
        { method: 'POST', body: fs.readFileSync(file), type: 'application/octet-stream' });
    },
  };
}

async function main(argv, env = process.env, log = console) {
  const opts = { rewrites: [], files: [], notes: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tag') opts.tag = argv[++i];
    else if (a === '--name') opts.name = argv[++i];
    else if (a === '--notes') opts.notes = argv[++i];
    else if (a === '--rewrite') opts.rewrites.push(...guard.parseRewrites(argv[++i]));
    else opts.files.push(a);
  }
  if (!opts.tag || !opts.files.length) { log.error('usage: --tag vX.Y.Z [--name N] [--notes T] [--rewrite old=>new] files...'); return 2; }
  if (!env.GITHUB_MIRROR_TOKEN || !(env.MIRROR_FORBIDDEN_PATTERNS || '').trim()) {
    log.error('GITHUB_MIRROR_TOKEN and MIRROR_FORBIDDEN_PATTERNS are required'); return 1;
  }
  const repo = repository(env.GITHUB_MIRROR_URL);
  const rewrites = [...opts.rewrites, ...guard.parseRewrites(env.MIRROR_REWRITES)];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-release-'));
  try {
    const staged = stage(opts.files, rewrites, dir);
    const matcher = guard.buildMatcher({ forbidden: env.MIRROR_FORBIDDEN_PATTERNS, env });
    const hits = staged.filter((f) => matcher.test(path.basename(f), fs.readFileSync(f))).map((f) => path.basename(f));
    if (hits.length) { log.error(`Secrets or installation-specific data found, refusing to publish: ${hits.join(', ')}`); return 1; }
    const gh = client(repo, env.GITHUB_MIRROR_TOKEN);
    const release = await gh.release(opts.tag, opts.name || opts.tag, opts.notes);
    for (const f of staged) { log.log(`upload ${path.basename(f)}`); await gh.upload(release, f); }
    log.log(`Release: ${release.html_url || ''}`);
    return 0;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

module.exports = { repository, stage, client, main };
if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`GitHub release failed: ${e.message}`); process.exit(1); });
