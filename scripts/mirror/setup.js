#!/usr/bin/env node
'use strict';
/**
 * Configures the GitHub mirror of the release pipeline (jobs mirror-github, release-github-images, release-github).
 *
 * Uses your glab login. Writes these PROTECTED CI/CD variables (tokens additionally masked):
 *   GITHUB_MIRROR_URL          https://github.com/<owner>/<repo>.git
 *   GITHUB_MIRROR_TOKEN        fine-grained token, Contents: read & write  (secret)
 *   GITHUB_GHCR_TOKEN          classic token with write:packages           (secret, optional: no images without it)
 *   MIRROR_FORBIDDEN_PATTERNS  extended regex of installation-specific strings the mirror must never contain
 *   MIRROR_REWRITES            optional, one `internal=>public` rule per line (applied to everything published)
 * and protects the tags v* so that the variables are only exposed to release pipelines.
 *
 * Tokens come from the environment (GITHUB_MIRROR_TOKEN, GITHUB_GHCR_TOKEN) or a hidden prompt, never from an
 * argument, and are never printed. New tokens are checked against GitHub first (--skip-check disables that).
 * Only missing or wrongly flagged variables are written unless --force is given.
 *
 * usage: node scripts/mirror/setup.js [--project <group/project>] [--url URL] [--patterns RE] [--rewrites FILE]
 *                                    [--force] [--skip-check] [--dry-run]
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const URL_RE = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\.git$/;
const VARIABLES = { GITHUB_MIRROR_URL: false, GITHUB_MIRROR_TOKEN: true, GITHUB_GHCR_TOKEN: true,
  MIRROR_FORBIDDEN_PATTERNS: false, MIRROR_REWRITES: false }; // name: masked
const OPTIONAL = new Set(['GITHUB_GHCR_TOKEN', 'MIRROR_REWRITES']);

function glab(endpoint, { method, payload } = {}) {
  const args = ['api', endpoint];
  if (method) args.push('--method', method);
  if (payload) args.push('--input', '-', '--header', 'Content-Type: application/json');
  const out = execFileSync('glab', args, { input: payload ? JSON.stringify(payload) : undefined, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return out.trim() ? JSON.parse(out) : null;
}

async function github(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
  return { status: res.status, headers: res.headers, json: res.ok ? await res.json() : null };
}

function prompt(question, hidden) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve('');
    process.stdout.write(question);
    let value = '';
    const stdin = process.stdin;
    if (hidden) stdin.setRawMode(true);
    stdin.resume(); stdin.setEncoding('utf8');
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          if (hidden) stdin.setRawMode(false);
          stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); return resolve(value);
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f') value = value.slice(0, -1); else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

const stateOf = (existing, key) => {
  const v = existing[key];
  if (!v) return 'missing';
  return !v.protected || (VARIABLES[key] && !v.masked) ? 'flags' : 'ok';
};

async function main(argv) {
  const args = { project: undefined, force: false, skip: false, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') args.project = argv[++i];
    else if (a === '--url') args.url = argv[++i];
    else if (a === '--patterns') args.patterns = argv[++i];
    else if (a === '--rewrites') args.rewrites = fs.readFileSync(argv[++i], 'utf8');
    else if (a === '--force') args.force = true;
    else if (a === '--skip-check') args.skip = true;
    else if (a === '--dry-run') args.dry = true;
    else { console.error(`unknown argument ${a}`); return 2; }
  }
  args.url ||= process.env.GITHUB_MIRROR_URL;
  args.patterns ||= process.env.MIRROR_FORBIDDEN_PATTERNS;
  args.rewrites ??= process.env.MIRROR_REWRITES;
  // Default: the GitLab project of the `origin` remote of the current checkout.
  if (!args.project) {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    args.project = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?[^/:]+(?::\d+)?[/:](.+?)(?:\.git)?$/i.exec(remote)?.[1];
    if (!args.project) throw new Error('cannot derive the GitLab project from the origin remote; pass --project');
  }
  const project = encodeURIComponent(args.project);

  const existing = {};
  for (const v of glab(`projects/${project}/variables?per_page=100`)) if ((v.environment_scope || '*') === '*') existing[v.key] = v;
  console.log('Current project variables:');
  const states = {};
  for (const key of Object.keys(VARIABLES)) {
    states[key] = stateOf(existing, key);
    const label = { missing: 'missing', ok: 'set', flags: 'set, but not protected/masked' }[states[key]];
    console.log(`  ${key}: ${label}${OPTIONAL.has(key) && states[key] === 'missing' ? ' (optional)' : ''}`);
  }

  const wanted = {};
  const need = (k) => args.force || states[k] !== 'ok';
  const keep = (k) => states[k] === 'flags' && !args.force && existing[k]?.value;
  if (need('GITHUB_MIRROR_URL')) wanted.GITHUB_MIRROR_URL = keep('GITHUB_MIRROR_URL') ? existing.GITHUB_MIRROR_URL.value : args.url || await prompt('GitHub repository URL (https://github.com/<owner>/<repo>.git): ');
  if (need('MIRROR_FORBIDDEN_PATTERNS')) wanted.MIRROR_FORBIDDEN_PATTERNS = keep('MIRROR_FORBIDDEN_PATTERNS') ? existing.MIRROR_FORBIDDEN_PATTERNS.value : args.patterns || await prompt('Forbidden patterns (extended regex, e.g. example\\.internal|myuser): ');
  if (args.rewrites !== undefined && (need('MIRROR_REWRITES') || args.rewrites !== existing.MIRROR_REWRITES?.value)) wanted.MIRROR_REWRITES = args.rewrites;
  if (need('GITHUB_MIRROR_TOKEN')) wanted.GITHUB_MIRROR_TOKEN = process.env.GITHUB_MIRROR_TOKEN || await prompt('GitHub token (fine-grained, Contents: write; empty = skip for now): ', true);
  if (need('GITHUB_GHCR_TOKEN')) wanted.GITHUB_GHCR_TOKEN = process.env.GITHUB_GHCR_TOKEN || await prompt('ghcr.io token (classic PAT, write:packages; empty = no image publishing): ', true);
  for (const k of Object.keys(wanted)) if (!wanted[k]) delete wanted[k];

  const url = wanted.GITHUB_MIRROR_URL || existing.GITHUB_MIRROR_URL?.value;
  if (wanted.GITHUB_MIRROR_URL && !URL_RE.test(wanted.GITHUB_MIRROR_URL)) throw new Error('URL must look like https://github.com/<owner>/<repo>.git');
  if (wanted.MIRROR_FORBIDDEN_PATTERNS) new RegExp(wanted.MIRROR_FORBIDDEN_PATTERNS);
  for (const k of ['GITHUB_MIRROR_TOKEN', 'GITHUB_GHCR_TOKEN']) {
    if (wanted[k] && (/\s/.test(wanted[k]) || wanted[k].length < 8)) throw new Error(`${k} must be at least 8 characters without whitespace (needed for masking)`);
  }
  if (!args.skip) {
    if (wanted.GITHUB_MIRROR_TOKEN) {
      if (!URL_RE.test(url || '')) throw new Error('cannot check the token without a valid GITHUB_MIRROR_URL');
      const r = await github(`https://api.github.com/repos/${URL_RE.exec(url)[1]}`, wanted.GITHUB_MIRROR_TOKEN);
      if (r.status !== 200) throw new Error(`GITHUB_MIRROR_TOKEN cannot access the repository (HTTP ${r.status})`);
      if (!r.json.permissions?.push) throw new Error('GITHUB_MIRROR_TOKEN has no write access (needs Contents: Read and write)');
      console.log('GITHUB_MIRROR_TOKEN: write access to the repository confirmed');
    }
    if (wanted.GITHUB_GHCR_TOKEN) {
      const r = await github('https://api.github.com/user', wanted.GITHUB_GHCR_TOKEN);
      if (r.status !== 200) throw new Error(`GITHUB_GHCR_TOKEN is not valid (HTTP ${r.status})`);
      if (!(r.headers.get('x-oauth-scopes') || '').split(',').map((s) => s.trim()).includes('write:packages')) {
        throw new Error('GITHUB_GHCR_TOKEN needs a classic token with the scope write:packages (fine-grained tokens do not work with ghcr.io)');
      }
      console.log('GITHUB_GHCR_TOKEN: scope write:packages confirmed');
    }
  }
  for (const [key, value] of Object.entries(wanted)) {
    const masked = VARIABLES[key];
    const payload = { key, value, protected: true, masked, raw: true, environment_scope: '*', variable_type: 'env_var' };
    const exists = Boolean(existing[key]);
    console.log(`${exists ? 'update' : 'create'} protected variable ${key}${masked ? ' (masked)' : ''}`);
    if (args.dry) continue;
    if (exists) glab(`projects/${project}/variables/${key}?filter[environment_scope]=*`, { method: 'PUT', payload });
    else glab(`projects/${project}/variables`, { method: 'POST', payload });
  }
  const tags = glab(`projects/${project}/protected_tags?per_page=100`) || [];
  if (tags.some((t) => t.name === 'v*')) console.log('tag protection v* already present');
  else {
    console.log('protect tags v* (create: Maintainers)');
    if (!args.dry) glab(`projects/${project}/protected_tags`, { method: 'POST', payload: { name: 'v*', create_access_level: 40 } });
  }
  const missing = ['GITHUB_MIRROR_TOKEN', 'GITHUB_GHCR_TOKEN'].filter((k) => states[k] === 'missing' && !wanted[k]);
  if (missing.length) console.log(`\nStill missing: ${missing.join(', ')} – the GitHub jobs are skipped until GITHUB_MIRROR_TOKEN exists` +
    ' (without GITHUB_GHCR_TOKEN no images are published). Run this script again to add them.');
  console.log('Done. Test with a tag vX.Y.Z; see docs/release.md.');
  return 0;
}

module.exports = { stateOf, URL_RE };
if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`Release mirror setup failed: ${e.message}`); process.exit(1); });
