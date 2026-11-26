'use strict';
// Tiny shop used by the E2E tests as link target (Open Graph metadata).
const http = require('node:http');

const PORT = Number(process.env.FIXTURE_PORT || 3101);
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

http.createServer((req, res) => {
  if (req.url === '/img.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PIXEL); }
  if (req.url === '/health') return res.end('ok');
  const name = req.url.replace(/^\/|\?.*$/g, '') || 'item';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>ignored</title>
    <meta property="og:title" content="Produkt ${name}">
    <meta property="og:description" content="Beschreibung für ${name}">
    <meta property="og:site_name" content="Fixture Shop">
    <meta property="og:image" content="/img.png"></head><body>${name}</body></html>`);
}).listen(PORT, '127.0.0.1', () => console.log(`fixture shop on :${PORT}`));
