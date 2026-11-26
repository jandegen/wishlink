'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');

test('docker-compose.yml always runs the published release (latest, pulled), never a local build', () => {
  const c = read('docker-compose.yml');
  assert.match(c, /image: \$\{WISHLINK_IMAGE:-ghcr\.io\/[\w.-]+\/wishlink:latest\}/);
  assert.match(c, /pull_policy: always/);
  assert.ok(!/^\s+build:/m.test(c), 'the default compose file must not build from source');
});

test('docker-compose.dev.yml overrides it with a local build', () => {
  const d = read('docker-compose.dev.yml');
  assert.match(d, /build: \./);
  assert.match(d, /pull_policy: never/);
});

test('release compose template keeps the version placeholder for the release pipeline', () => {
  assert.match(read('docker-compose.release.yml'), /image: "@IMAGE@"/);
});

test('docker-compose.traefik.yml: attached to the proxy network, unique names, no dangling middleware, TLS + proxy settings', () => {
  const t = read('docker-compose.traefik.yml');
  // pitfalls that end in Traefik's plain "404 page not found"
  assert.match(t, /networks:\n\s+- proxy/, 'the service must join the proxy network, declaring it is not enough');
  assert.match(t, /name: \$\{TRAEFIK_NETWORK:-web\}\n\s+external: true/);
  assert.match(t, /traefik\.docker\.network=\$\{TRAEFIK_NETWORK:-web\}/);
  for (const [, mw] of t.matchAll(/middlewares=([\w-]+)/g)) {
    assert.match(t, new RegExp(`traefik\\.http\\.middlewares\\.${mw}\\.`), `middleware ${mw} must be defined: a router referencing an undefined middleware is dropped by Traefik`);
  }
  for (const [, name] of t.matchAll(/traefik\.http\.(?:routers|services|middlewares)\.([\w-]+)\./g)) assert.match(name, /^wishlink/, 'router/service/middleware names must be unique');
  // plain http must not end in Traefik's 404: a router on the port-80 entrypoint redirects to https
  assert.match(t, /routers\.wishlink-http\.entrypoints=\$\{TRAEFIK_HTTP_ENTRYPOINT:-web\}/);
  assert.match(t, /redirectscheme\.scheme=https/);
  assert.match(t, /Host\(`\$\{WISHLINK_HOST\}`\)/);
  assert.match(t, /PUBLIC_URL: https:\/\/\$\{WISHLINK_HOST:\?/);
  assert.match(t, /TRUST_PROXY: "true"/);
  assert.match(t, /ports: !reset \[\]/);
});
