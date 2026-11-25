'use strict';

const { HttpError } = require('./errors');
const { CROPS } = require('./advice');
const CITIES = require('./cities');

const CITY_IDS = new Set(CITIES.map((c) => c.id));
const USERNAME_RE = /^[a-z0-9_]{3,24}$/;
const HASH_RE = /^scrypt\$\d{1,6}\$\d{1,3}\$\d{1,3}\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/;

const DEFAULT_SETTINGS = Object.freeze({ units: 'metric', crop: 'maize', favorites: [] });

/** Validate a username/password pair from a request body. */
function parseCredentials(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid request.');
  const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!USERNAME_RE.test(username)) {
    throw new HttpError(400, 'Username must be 3 to 24 characters: letters, numbers or underscore.');
  }
  if (password.length < 8 || password.length > 128) {
    throw new HttpError(400, 'Password must be 8 to 128 characters.');
  }
  return { username, password };
}

/** Whitelist-based settings cleaner: unknown keys and bad values are dropped. */
function sanitizeSettings(raw) {
  const settings = { units: DEFAULT_SETTINGS.units, crop: DEFAULT_SETTINGS.crop, favorites: [] };
  if (raw && typeof raw === 'object') {
    if (raw.units === 'metric' || raw.units === 'imperial') settings.units = raw.units;
    if (typeof raw.crop === 'string' && Object.hasOwn(CROPS, raw.crop)) settings.crop = raw.crop;
    if (Array.isArray(raw.favorites)) {
      settings.favorites = [...new Set(raw.favorites.filter((id) => typeof id === 'string' && CITY_IDS.has(id)))].slice(0, 20);
    }
  }
  return settings;
}

/** Validate a user record received from a peer server. Returns a clean record or null. */
function validateWireUser(u) {
  if (!u || typeof u !== 'object') return null;
  if (typeof u.username !== 'string' || !USERNAME_RE.test(u.username)) return null;
  if (typeof u.pwHash !== 'string' || u.pwHash.length > 400 || !HASH_RE.test(u.pwHash)) return null;
  if (!Number.isSafeInteger(u.createdAt) || !Number.isSafeInteger(u.updatedAt) || u.createdAt < 0 || u.updatedAt < 0) return null;
  return {
    username: u.username,
    pwHash: u.pwHash,
    settings: sanitizeSettings(u.settings),
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

module.exports = { parseCredentials, sanitizeSettings, validateWireUser, DEFAULT_SETTINGS, CITY_IDS };
