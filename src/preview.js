'use strict';
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');

const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const UA = 'Mozilla/5.0 (compatible; WishLinkPreview/1.0)';

/** True for loopback, private, link-local, CGNAT, multicast, reserved and unspecified addresses. */
function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return l === '::' || l === '::1' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff');
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && p[2] === 0)
    || (a === 198 && (b === 18 || b === 19));
}

/**
 * Makes a hostname absolute (trailing dot) so the resolver's search list is skipped. In clusters with
 * `ndots:5` and a wildcard record for the search domain (e.g. *.home.example.org) `www.shop.de` would
 * otherwise resolve to `www.shop.de.home.example.org` -> an internal IP.
 */
function absoluteHost(hostname) {
  return hostname.includes('.') && !hostname.endsWith('.') && !net.isIP(hostname) ? `${hostname}.` : hostname;
}

/** dns.lookup replacement that refuses to resolve to internal addresses (pins the checked IP). */
function guardedLookup(allowPrivate) {
  return (hostname, options, cb) => {
    dns.lookup(absoluteHost(hostname), { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      if (!allowPrivate && addrs.some((a) => isPrivateIp(a.address))) {
        return cb(new Error('blocked address'));
      }
      if (options && options.all) return cb(null, addrs);
      return cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

function request(url, { allowPrivate }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return reject(new Error('bad protocol'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !allowPrivate && isPrivateIp(host)) return reject(new Error('blocked address'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET',
      lookup: guardedLookup(allowPrivate),
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'de,en;q=0.8' },
      timeout: TIMEOUT_MS,
    }, resolve);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function fetchHtml(url, opts, redirects = 0) {
  const res = await request(url, opts);
  const status = res.statusCode || 0;
  if (status >= 300 && status < 400 && res.headers.location) {
    res.resume();
    if (redirects >= MAX_REDIRECTS) throw new Error('too many redirects');
    return fetchHtml(new URL(res.headers.location, url).toString(), opts, redirects + 1);
  }
  if (status < 200 || status >= 300) { res.resume(); throw new Error(`status ${status}`); }
  const type = String(res.headers['content-type'] || '');
  if (!/html/i.test(type)) { res.resume(); throw new Error('not html'); }
  const chunks = [];
  let size = 0;
  for await (const c of res) {
    size += c.length;
    chunks.push(c);
    if (size >= MAX_BYTES) { res.destroy(); break; }
  }
  const charset = (type.match(/charset=([\w-]+)/i) || [])[1] || 'utf-8';
  let text;
  try { text = new TextDecoder(charset).decode(Buffer.concat(chunks)); } catch { text = Buffer.concat(chunks).toString('utf8'); }
  return { html: text, finalUrl: url };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const clip = (s, n) => {
  const v = decodeEntities(String(s || '')).replace(/\s+/g, ' ').trim();
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
};

/** Extracts Open Graph / Twitter / basic meta information from HTML. */
function parseMeta(html, baseUrl) {
  const head = html.slice(0, MAX_BYTES);
  const meta = {};
  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = {};
    for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
    }
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (key && attrs.content !== undefined && !(key in meta)) meta[key] = attrs.content;
  }
  const titleTag = (head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  let image = null;
  const rawImage = meta['og:image'] || meta['og:image:url'] || meta['twitter:image'];
  if (rawImage) {
    try {
      const u = new URL(decodeEntities(rawImage).trim(), baseUrl);
      if (['http:', 'https:'].includes(u.protocol) && u.toString().length <= 2000) image = u.toString();
    } catch { /* ignore */ }
  }
  const host = new URL(baseUrl).hostname.replace(/^www\./, '');
  const preview = {
    title: clip(meta['og:title'] || meta['twitter:title'] || titleTag, 200),
    description: clip(meta['og:description'] || meta['twitter:description'] || meta.description, 300),
    image,
    siteName: clip(meta['og:site_name'], 80) || host,
  };
  return preview.title || preview.description || preview.image ? preview : null;
}

/** @returns {Promise<{title,description,image,siteName}|null>} null when no preview could be built. */
async function fetchPreview(url, { allowPrivate = false } = {}) {
  try {
    const { html, finalUrl } = await fetchHtml(url, { allowPrivate });
    return parseMeta(html, finalUrl);
  } catch {
    return null;
  }
}

module.exports = { fetchPreview, parseMeta, isPrivateIp, absoluteHost };
