'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const guard = require('../../scripts/mirror/guard');
const publish = require('../../scripts/mirror/publish-github-release');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wl-mirror-'));
const write = (dir, rel, content) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); };
const quiet = { log() {}, error() {} };
// Secret-looking fixtures are assembled at runtime: this file is part of the mirrored source and is scanned itself.
const PEM = ['-----BEGIN ', 'OPENSSH PRIVATE KEY', '-----'].join('');
const GLPAT = ['glpat', '-', 'abcdefghij0123456789'].join('');
const REWRITES = 'wishlink.home.example.org=>wishlink.example.com\nregistry.home.example.org:5001/me/wishlink=>ghcr.io/me/wishlink\nregistry.home.example.org:5001=>registry.example.com';

test('parseRewrites: rules in order, comments and blanks ignored, invalid rules rejected', () => {
  assert.deepEqual(guard.parseRewrites('# c\n\na=>b\n x => y \n'), [['a', 'b'], ['x', 'y']]);
  assert.throws(() => guard.parseRewrites('no-arrow'), /invalid rewrite rule/);
});

test('prepare: rewrites internal names (specific rules first) and leaves a clean tree', () => {
  const dir = tmp();
  write(dir, 'k8s/kustomization.yaml', 'newName: registry.home.example.org:5001/me/wishlink\nhost: wishlink.home.example.org\n');
  write(dir, '.gitlab-ci.yml', '--insecure-registry=registry.home.example.org:5001\n');
  const env = { MIRROR_REWRITES: REWRITES, MIRROR_FORBIDDEN_PATTERNS: 'example\\.org' };
  assert.equal(guard.main(['prepare', dir], env, quiet), 0);
  assert.equal(fs.readFileSync(path.join(dir, 'k8s/kustomization.yaml'), 'utf8'), 'newName: ghcr.io/me/wishlink\nhost: wishlink.example.com\n');
  assert.match(fs.readFileSync(path.join(dir, '.gitlab-ci.yml'), 'utf8'), /registry\.example\.com/);
});

test('scan refuses secrets: private keys, tokens, kubeconfig data, known secret values, forbidden patterns', () => {
  const cases = {
    key: `${PEM}\nabc`,
    gitlab: `token: ${GLPAT}`,
    github: `x = ${['gh', 'p_'].join('')}${'a1'.repeat(20)}`,
    pat: `${['github', 'pat_'].join('_')}${'A'.repeat(40)}`,
    aws: ['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join(''),
    kube: ['client-key-', 'data: LS0tLS1CRUdJTi'].join(''),
    internal: 'see https://git.my-secret-corp.internal/x',
  };
  for (const [name, content] of Object.entries(cases)) {
    const dir = tmp();
    write(dir, 'ok.txt', 'fine');
    write(dir, `sub/${name}.txt`, content);
    const logged = [];
    const code = guard.main(['scan', dir], { MIRROR_FORBIDDEN_PATTERNS: 'my-secret-corp' }, { log() {}, error: (m) => logged.push(m) });
    assert.equal(code, 1, name);
    assert.match(logged.join(''), new RegExp(`${name}\\.txt`));
    assert.ok(!logged.join('').includes(content), 'the matched content must never be logged');
  }
});

test('scan refuses literal values of secret CI variables (even without a recognisable format)', () => {
  const dir = tmp();
  write(dir, 'docs.md', 'login with Zx9kP2mQ7vLw4Rt8Nb3Y');
  const env = { MIRROR_FORBIDDEN_PATTERNS: 'nothing-here', ADMIN_PASSWORD: 'Zx9kP2mQ7vLw4Rt8Nb3Y' };
  assert.equal(guard.main(['scan', dir], env, quiet), 1);
  assert.equal(guard.main(['scan', dir], { ...env, ADMIN_PASSWORD: 'short' }, quiet), 0); // < 8 chars is not treated as a secret
});

test('scan looks inside .tar.gz files and requires MIRROR_FORBIDDEN_PATTERNS', () => {
  const dir = tmp();
  write(dir, 'bundle.tar.gz', zlib.gzipSync(Buffer.from(`some tar bytes ... ${PEM} ...`)));
  assert.equal(guard.main(['scan', dir], { MIRROR_FORBIDDEN_PATTERNS: 'x' }, quiet), 1);
  assert.equal(guard.main(['scan', dir], {}, quiet), 1); // refuses to run without patterns
});

test('this repository: every internal string is rewritten and the snapshot passes the scan', () => {
  // Simulates mirror-github on the working tree (tracked + new files, like the tagged tree). The internal names are
  // assembled here so this very file does not contain them and would not be blocked by the scan itself.
  const { execFileSync } = require('node:child_process');
  const root = path.join(__dirname, '..', '..');
  const domain = ['die', 'degens'].join('-');
  const user = ['jan', 'degen'].join('.');
  const issuer = ['homelab', 'ca'].join('-');
  const registry = `container.home.${domain}.eu:5001`;
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const dir = tmp();
  for (const f of files) if (fs.existsSync(path.join(root, f))) write(dir, f, fs.readFileSync(path.join(root, f)));
  const env = {
    MIRROR_FORBIDDEN_PATTERNS: `${domain}|${user.replace('.', '\\.')}|${issuer}`,
    MIRROR_REWRITES: [
      `${registry}/${user}/wishlink=>ghcr.io/example/wishlink`,
      `${registry}=>registry.example.com`,
      `wishlink.home.${domain}.eu=>wishlink.example.com`,
      `${issuer}-issuer=>my-cluster-issuer`,
    ].join('\n'),
  };
  const logged = [];
  assert.equal(guard.main(['prepare', dir], env, { log() {}, error: (m) => logged.push(m) }), 0, logged.join('\n'));
});

test('publish: stage rewrites text, keeps JSON valid, refuses on a hit before any request', async () => {
  const dir = tmp();
  write(dir, 'sbom.json', JSON.stringify({ image: 'registry.home.example.org:5001/me/wishlink:1.0.0' }));
  write(dir, 'compose.yml', 'image: registry.home.example.org:5001/me/wishlink:1.0.0\n');
  const out = tmp();
  const staged = publish.stage([path.join(dir, 'sbom.json'), path.join(dir, 'compose.yml')], guard.parseRewrites(REWRITES), out);
  assert.equal(JSON.parse(fs.readFileSync(staged[0], 'utf8')).image, 'ghcr.io/me/wishlink:1.0.0');
  assert.equal(fs.readFileSync(staged[1], 'utf8'), 'image: ghcr.io/me/wishlink:1.0.0\n');

  const bad = tmp();
  write(bad, 'notes.txt', `password ${GLPAT}`);
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (...a) => { calls.push(a); throw new Error('network must not be used'); };
  try {
    const code = await publish.main(['--tag', 'v1.0.0', path.join(bad, 'notes.txt')], {
      GITHUB_MIRROR_URL: 'https://github.com/me/wishlink.git', GITHUB_MIRROR_TOKEN: 'tok-12345678', MIRROR_FORBIDDEN_PATTERNS: 'zzz',
    }, quiet);
    assert.equal(code, 1);
    assert.equal(calls.length, 0);
  } finally { global.fetch = realFetch; }
});

test('publish: creates the release, replaces assets of the same name, sends the token only to GitHub', async () => {
  const dir = tmp();
  write(dir, 'SHA256SUMS', 'abc  file\n');
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push([opts.method, url, opts.headers.Authorization]);
    const json = (o, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(o) });
    if (opts.method === 'GET') return json({ id: 7, html_url: 'u', assets: [{ id: 99, name: 'SHA256SUMS' }] });
    return json({});
  };
  const real = global.fetch; global.fetch = fakeFetch;
  try {
    const code = await publish.main(['--tag', 'v1.0.0', path.join(dir, 'SHA256SUMS')], {
      GITHUB_MIRROR_URL: 'https://github.com/me/wishlink.git', GITHUB_MIRROR_TOKEN: 'tok-12345678', MIRROR_FORBIDDEN_PATTERNS: 'zzz',
    }, quiet);
    assert.equal(code, 0);
  } finally { global.fetch = real; }
  assert.deepEqual(calls.map((c) => c[0]), ['GET', 'DELETE', 'POST']);
  assert.ok(calls.every((c) => /^https:\/\/(api|uploads)\.github\.com\//.test(c[1]) && c[2] === 'Bearer tok-12345678'));
  assert.match(calls[2][1], /releases\/7\/assets\?name=SHA256SUMS$/);
});

test('publish: repository() accepts only github.com URLs', () => {
  assert.equal(publish.repository('https://github.com/jandegen/wishlink.git'), 'jandegen/wishlink');
  assert.throws(() => publish.repository('https://evil.example/x/y.git'));
});

test('build-release-assets pins image and version in compose and k8s manifests', () => {
  const { execFileSync } = require('node:child_process');
  const root = path.join(__dirname, '..', '..');
  const out = tmp();
  execFileSync('sh', [path.join(root, 'scripts/mirror/build-release-assets.sh'), root, out, '2.3.4', 'ghcr.io/me/wishlink']);
  assert.match(fs.readFileSync(path.join(out, 'docker-compose.yml'), 'utf8'), /image: "ghcr\.io\/me\/wishlink:2\.3\.4"/);
  const tar = zlib.gunzipSync(fs.readFileSync(path.join(out, 'wishlink-2.3.4-k8s.tar.gz'))).toString('latin1');
  assert.match(tar, /newName: ghcr\.io\/me\/wishlink/);
  assert.match(tar, /newTag: "2\.3\.4"/);
});
