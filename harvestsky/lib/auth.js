'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const COOKIE_NAME = 'hs_session';

/** Hash a password with scrypt and a random salt. Format: scrypt$N$r$p$salt$hash */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p),
  });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

/* Stateless signed session tokens: base64url(payload).base64url(HMAC-SHA256).
 * Any server that shares AUTH_SECRET accepts them, so logins work behind a load balancer. */

const sign = (payload, secret) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

function createToken(username, secret, ttlSeconds, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Math.floor(now / 1000) + ttlSeconds })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/** Returns the username, or null if the token is malformed, tampered with or expired. */
function verifyToken(token, secret, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const given = Buffer.from(parts[1]);
  const expected = Buffer.from(sign(parts[0], secret));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (typeof data.u !== 'string' || typeof data.exp !== 'number' || data.exp * 1000 <= now) return null;
    return data.u;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch { /* ignore malformed cookie */ }
  }
  return out;
}

function sessionCookie(value, { maxAge, secure }) {
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

/** Constant-time string comparison (hashes first so lengths do not leak). */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = {
  COOKIE_NAME, hashPassword, verifyPassword, createToken, verifyToken, parseCookies, sessionCookie, safeEqual,
};
