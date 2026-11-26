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
  const email = requireText(b.email, 'email', { max: 254 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError('invalid_email', 'email');
  const password = typeof b.password === 'string' ? b.password : '';
  if (password.length < 8) throw new ValidationError('password_too_short', 'password');
  if (password.length > 200) throw new ValidationError('too_long', 'password');
  return {
    username,
    email,
    password,
    firstName: requireText(b.firstName, 'firstName', { max: 80 }),
    lastName: requireText(b.lastName, 'lastName', { max: 80 }),
  };
}

function validateWish(b = {}) {
  const priority = b.priority === undefined ? 2 : Number(b.priority);
  if (![1, 2, 3].includes(priority)) throw new ValidationError('invalid_priority', 'priority');
  return {
    title: requireText(b.title, 'title', { max: 200 }),
    description: str(b.description).slice(0, 5000),
    links: validateLinks(b.links),
    priority,
  };
}

const CLAIM_TYPES = ['gift', 'contribute', 'purchased'];
function validateClaimType(v) {
  if (!CLAIM_TYPES.includes(v)) throw new ValidationError('invalid_claim_type', 'type');
  return v;
}

module.exports = { MAX_LINKS, validateLinks, optionalUrl, ValidationError, validateRegistration, validateWish, validateClaimType, CLAIM_TYPES };
