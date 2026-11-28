'use strict';

class ValidationError extends Error {
  constructor(code, field) {
    super(code);
    this.status = 400;
    this.code = code;
    this.field = field;
  }
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

function requireText(v, field, { min = 1, max }) {
  const s = str(v);
  if (s.length < min) throw new ValidationError('required', field);
  if (s.length > max) throw new ValidationError('too_long', field);
  return s;
}

function optionalUrl(v) {
  const s = str(v);
  if (!s) return null;
  if (s.length > 2000) throw new ValidationError('too_long', 'url');
  let u;
  try { u = new URL(s); } catch { throw new ValidationError('invalid_url', 'url'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new ValidationError('invalid_url', 'url');
  return u.toString();
}

const MAX_LINKS = 6;
const MAX_QUANTITY = 99;
function validateLinks(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ValidationError('invalid_url', 'links');
  const out = [];
  for (const raw of v) {
    const u = optionalUrl(raw);
    if (u && !out.includes(u)) out.push(u);
  }
  if (out.length > MAX_LINKS) throw new ValidationError('too_many_links', 'links');
  return out;
}

function validateRegistration(b = {}) {
  const username = requireText(b.username, 'username', { min: 3, max: 32 });
  if (!/^[A-Za-z0-9_.-]+$/.test(username)) throw new ValidationError('invalid_username', 'username');
  const password = typeof b.password === 'string' ? b.password : '';
  if (password.length < 8) throw new ValidationError('password_too_short', 'password');
  if (password.length > 200) throw new ValidationError('too_long', 'password');
  return {
    username,
    password,
    firstName: requireText(b.firstName, 'firstName', { max: 80 }),
    lastName: requireText(b.lastName, 'lastName', { max: 80 }),
  };
}

function validateWish(b = {}) {
  const priority = b.priority === undefined ? 2 : Number(b.priority);
  if (![1, 2, 3].includes(priority)) throw new ValidationError('invalid_priority', 'priority');
  const quantity = b.quantity === undefined || b.quantity === null || b.quantity === '' ? 1 : Number(b.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) throw new ValidationError('invalid_quantity', 'quantity');
  return {
    quantity,
    title: requireText(b.title, 'title', { max: 200 }),
    description: str(b.description).slice(0, 5000),
    links: validateLinks(b.links),
    priority,
  };
}

function validateName(b = {}) {
  return { firstName: requireText(b.firstName, 'firstName', { max: 80 }), lastName: requireText(b.lastName, 'lastName', { max: 80 }) };
}

const CLAIM_TYPES = ['gift', 'contribute'];
function validateAmount(v) {
  if (v === undefined || v === null || v === '') return 1;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_QUANTITY) throw new ValidationError('invalid_amount', 'amount');
  return n;
}
/** Optional money amount in EUR ("20", "20,5", 12.34) -> cents, or null when empty. */
function validateContribution(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).trim().replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0 || n > 100000) throw new ValidationError('invalid_contribution', 'contribution');
  return Math.round(n * 100);
}

function validateComment(b = {}) {
  return requireText(b.body, 'comment', { max: 1000 });
}

function validateClaimType(v) {
  if (v === 'purchased') return 'gift'; // legacy: "already bought" was merged into "gift" (old browser tabs may still send it)
  if (!CLAIM_TYPES.includes(v)) throw new ValidationError('invalid_claim_type', 'type');
  return v;
}

module.exports = { MAX_LINKS, validateLinks, optionalUrl, ValidationError, validateRegistration, validateName, validateWish, validateClaimType, validateAmount, validateContribution, validateComment, MAX_QUANTITY, CLAIM_TYPES };
