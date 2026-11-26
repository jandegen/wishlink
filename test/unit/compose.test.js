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
