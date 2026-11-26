'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { fetchPreview, parseMeta, isPrivateIp, absoluteHost } = require('../../src/preview');

test('isPrivateIp covers internal ranges', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.200', '172.16.0.1', '172.31.255.255', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
    assert.ok(isPrivateIp(ip), ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700::1111']) assert.ok(!isPrivateIp(ip), ip);
});

test('parseMeta prefers Open Graph, resolves relative images, decodes entities', () => {
  const html = `<html><head><title>Fallback</title>
    <meta property="og:title" content="Caf&eacute; &amp; Bar &#39;X&#39;">
    <meta property='og:description' content="Nice   place">
    <meta content="/img/a.png" property="og:image">
    <meta property="og:site_name" content="Shop"></head></html>`;
  const p = parseMeta(html, 'https://www.example.com/p/1');
  assert.equal(p.title, 'Caf&eacute; & Bar \'X\''); // unknown named entities are left as is
  assert.equal(p.description, 'Nice place');
  assert.equal(p.image, 'https://www.example.com/img/a.png');
  assert.equal(p.siteName, 'Shop');
});

test('parseMeta falls back to <title>/meta description/hostname; rejects non-http images; null if empty', () => {
  const p = parseMeta('<title> Hi </title><meta name="description" content="D"><meta property="og:image" content="javascript:x">', 'https://www.shop.de/x');
  assert.deepEqual(p, { title: 'Hi', description: 'D', image: null, siteName: 'shop.de' });
  assert.equal(parseMeta('<html></html>', 'https://a.b/'), null);
});

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test('fetchPreview blocks internal targets (SSRF) by default', async () => {
  let hit = false;
  await withServer((req, res) => { hit = true; res.end('<title>secret</title>'); }, async (base) => {
    assert.equal(await fetchPreview(`${base}/`), null);
    assert.equal(await fetchPreview('http://localhost:1/'), null);
    assert.equal(await fetchPreview('http://169.254.169.254/latest/meta-data/'), null);
  });
  assert.equal(hit, false);
});

test('fetchPreview fetches, follows redirects, enforces content type', async () => {
  await withServer((req, res) => {
    if (req.url === '/redir') { res.writeHead(302, { location: '/page' }); return res.end(); }
    if (req.url === '/json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<meta property="og:title" content="Hello"><meta property="og:image" content="https://i.example/x.jpg">');
  }, async (base) => {
    const p = await fetchPreview(`${base}/redir`, { allowPrivate: true });
    assert.equal(p.title, 'Hello');
    assert.equal(p.image, 'https://i.example/x.jpg');
    assert.equal(await fetchPreview(`${base}/json`, { allowPrivate: true }), null);
    assert.equal(await fetchPreview(`${base}/loop`, { allowPrivate: true }), null);
    assert.equal(await fetchPreview(`${base}/missing-port-test`.replace(/:\d+/, ':1'), { allowPrivate: true }), null);
  });
});

test('absoluteHost skips resolver search domains but leaves IPs and short names alone', () => {
  assert.equal(absoluteHost('www.shop.de'), 'www.shop.de.');
  assert.equal(absoluteHost('www.shop.de.'), 'www.shop.de.');
  assert.equal(absoluteHost('127.0.0.1'), '127.0.0.1');
  assert.equal(absoluteHost('localhost'), 'localhost');
});

test('fetchPreview works for hosts resolved via trailing-dot lookup (localhost fixture)', async () => {
  await withServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>ok</title>'); }, async (base) => {
    const p = await fetchPreview(base.replace('127.0.0.1', 'localhost'), { allowPrivate: true });
    assert.equal(p.title, 'ok');
  });
});
