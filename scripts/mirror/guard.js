#!/usr/bin/env node
'use strict';
/**
 * Release mirror guard: sanitises and scans everything that is published to GitHub.
 *
 *  1. Rewrites installation-specific strings (MIRROR_REWRITES: one `old=>new` per line, applied top to bottom).
 *  2. Scans the result and REFUSES (exit 1) when it still contains
 *       - a built-in secret pattern (private keys, GitLab/GitHub/AWS/Slack tokens, kubeconfig credentials),
 *       - the literal value of a known secret CI/CD variable (ADMIN_PASSWORD, tokens, ...),
 *       - a match of MIRROR_FORBIDDEN_PATTERNS (extended regex with installation-specific terms).
 *     Only file names are reported, never the matched content (job logs are not a safe place for secrets).
 *
 * CLI:  node scripts/mirror/guard.js prepare <dir>    rewrite in place, then scan
 *       node scripts/mirror/guard.js scan <dir>       scan only
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SECRET_ENV = ['ADMIN_PASSWORD', 'OIDC_CLIENT_SECRET', 'GITHUB_MIRROR_TOKEN', 'GITHUB_GHCR_TOKEN',
  'CI_JOB_TOKEN', 'CI_REGISTRY_PASSWORD', 'REGISTRY_PULL_TOKEN'];
const TEXT_EXT = new Set(['.js', '.json', '.md', '.txt', '.yml', '.yaml', '.html', '.css', '.xml', '.sh', '.env',
  '.example', '.cjs', '.mjs', '.toml', '.cfg', '.conf', '.gitignore', '.dockerignore', '']);
const MAX_SCAN_DEPTH = 3;

function builtinPatterns(file = path.join(__dirname, 'secret-patterns.txt')) {
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

function parseRewrites(text = '') {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=>');
    if (i < 1) throw new Error(`invalid rewrite rule (expected old=>new): ${line.slice(0, 20)}…`);
    out.push([line.slice(0, i).trim(), line.slice(i + 2).trim()]);
  }
  return out;
}

const applyRewrites = (text, rewrites) => rewrites.reduce((t, [from, to]) => t.split(from).join(to), text);

/** @returns {{test(name: string, data: Buffer): boolean}} */
function buildMatcher({ forbidden = '', env = process.env, patterns = builtinPatterns() } = {}) {
  const secretRe = patterns.length ? new RegExp(patterns.map((p) => `(?:${p})`).join('|')) : null;
  const forbiddenRe = forbidden.trim() ? new RegExp(forbidden, 'i') : null;
  const literals = SECRET_ENV.map((k) => env[k]).filter((v) => typeof v === 'string' && v.length >= 8)
    .map((v) => Buffer.from(v));
  const check = (name, buf, depth) => {
    const text = buf.toString('latin1'); // 1:1 byte mapping, so regexes work on binary files too
    if (secretRe?.test(text) || forbiddenRe?.test(name) || forbiddenRe?.test(text)) return true;
    if (literals.some((l) => buf.includes(l))) return true;
    if (depth < MAX_SCAN_DEPTH && /\.(gz|tgz)$/.test(name)) {
      try { return check(`${name}!`, zlib.gunzipSync(buf), depth + 1); } catch { return false; }
    }
    return false;
  };
  return { test: (name, data) => check(name, data, 0) };
}

function* walk(root, rel = '') {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = path.join(rel, e.name);
    if (e.isDirectory()) yield* walk(root, p);
    else if (e.isFile()) yield p;
  }
}

function isText(file, buf) {
  return TEXT_EXT.has(path.extname(file).toLowerCase()) && !buf.includes(0);
}

/** Rewrites text files in place; returns the list of changed files. */
function rewriteTree(root, rewrites) {
  const changed = [];
  if (!rewrites.length) return changed;
  for (const rel of walk(root)) {
    const full = path.join(root, rel);
    const buf = fs.readFileSync(full);
    if (!isText(rel, buf)) continue;
    const before = buf.toString('utf8');
    const after = applyRewrites(before, rewrites);
    if (after !== before) { fs.writeFileSync(full, after); changed.push(rel); }
  }
  return changed;
}

/** Returns the relative paths of files (or file names) that must not be published. */
function scanTree(root, matcher) {
  const hits = [];
  for (const rel of walk(root)) if (matcher.test(rel, fs.readFileSync(path.join(root, rel)))) hits.push(rel);
  return hits;
}

function fromEnv(env = process.env) {
  return { rewrites: parseRewrites(env.MIRROR_REWRITES), forbidden: env.MIRROR_FORBIDDEN_PATTERNS || '' };
}

function main(argv, env = process.env, log = console) {
  const [cmd, dir] = argv;
  if (!['prepare', 'scan'].includes(cmd) || !dir) { log.error('usage: guard.js prepare|scan <dir>'); return 2; }
  const { rewrites, forbidden } = fromEnv(env);
  if (!forbidden.trim()) { log.error('MIRROR_FORBIDDEN_PATTERNS is required (refusing to mirror without a scan)'); return 1; }
  if (cmd === 'prepare') {
    const changed = rewriteTree(dir, rewrites);
    log.log(`rewrote ${changed.length} file(s)`);
  }
  const hits = scanTree(dir, buildMatcher({ forbidden, env }));
  if (hits.length) {
    log.error(`Secrets or installation-specific data found, refusing to publish:\n${hits.map((h) => `  ${h}`).join('\n')}`);
    return 1;
  }
  log.log('scan clean');
  return 0;
}

module.exports = { main, builtinPatterns, parseRewrites, applyRewrites, buildMatcher, rewriteTree, scanTree, walk, fromEnv, SECRET_ENV };
if (require.main === module) process.exit(main(process.argv.slice(2)));
