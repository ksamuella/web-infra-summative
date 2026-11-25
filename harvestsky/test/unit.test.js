'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const auth = require('../lib/auth');
const { parseCredentials, sanitizeSettings, validateWireUser } = require('../lib/validate');
const { computeAdvice, CROPS } = require('../lib/advice');
const { normalizeForecast, buildStats } = require('../lib/weather');
const { openStore } = require('../lib/db');
const { RateLimiter } = require('../lib/ratelimit');

const calm = { rain24: 0, popMax24: 0.1, windMax24: 2, rain48: 6, popMax48: 0.2, rain5d: 30, tmin5: 14, tmax5: 26 };

/* ---------- auth ---------- */

test('password hashing verifies the right password only', async () => {
  const hash = await auth.hashPassword('correct horse');
  assert.match(hash, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await auth.verifyPassword('correct horse', hash), true);
  assert.equal(await auth.verifyPassword('wrong horse', hash), false);
  assert.equal(await auth.verifyPassword('x', 'garbage'), false);
  assert.notEqual(hash, await auth.hashPassword('correct horse'), 'salt must differ per hash');
});

test('session tokens: valid, tampered, wrong secret and expired', () => {
  const secret = 'k'.repeat(40);
  const now = Date.now();
  const token = auth.createToken('amina', secret, 60, now);
  assert.equal(auth.verifyToken(token, secret, now), 'amina');
  assert.equal(auth.verifyToken(token, 'z'.repeat(40), now), null);
  assert.equal(auth.verifyToken(token, secret, now + 61000), null);

  const [payload, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ u: 'admin', exp: Math.floor(now / 1000) + 60 })).toString('base64url');
  assert.equal(auth.verifyToken(`${forged}.${sig}`, secret, now), null);
  assert.equal(auth.verifyToken(`${payload}.`, secret, now), null);
  assert.equal(auth.verifyToken(undefined, secret, now), null);
  assert.equal(auth.verifyToken('a.b.c', secret, now), null);
});

test('parseCookies handles normal and malformed input', () => {
  assert.equal(auth.parseCookies('a=1; hs_session=abc%20d; bad=%E0%A4%A')['hs_session'], 'abc d');
  assert.deepEqual({ ...auth.parseCookies('') }, {});
});

/* ---------- validation ---------- */

test('parseCredentials normalises and rejects bad input', () => {
  assert.deepEqual({ ...parseCredentials({ username: '  Amina_1 ', password: 'longenough' }) }, { username: 'amina_1', password: 'longenough' });
  for (const bad of [
    { username: 'ab', password: 'longenough' },
    { username: "x' OR '1'='1", password: 'longenough' },
    { username: 'a;DROP TABLE users;--', password: 'longenough' },
    { username: '<script>alert(1)</script>', password: 'longenough' },
    { username: 'valid_name', password: 'short' },
    { username: 'valid_name', password: 'x'.repeat(129) },
    { username: 123, password: 'longenough' },
    null, [], 'str',
  ]) {
    assert.throws(() => parseCredentials(bad), (e) => e.status === 400);
  }
});

test('sanitizeSettings keeps only whitelisted values', () => {
  const s = sanitizeSettings({
    units: 'kelvin', crop: '__proto__', favorites: ['kigali', 'kigali', 'atlantis', 5, 'nairobi'], admin: true,
  });
  assert.deepEqual({ ...s, favorites: [...s.favorites] }, { units: 'metric', crop: 'maize', favorites: ['kigali', 'nairobi'] });
  assert.equal(sanitizeSettings({ units: 'imperial', crop: 'coffee' }).crop, 'coffee');
  assert.equal(sanitizeSettings(undefined).units, 'metric');
});

test('validateWireUser rejects malformed replication records', () => {
  const good = { username: 'amina', pwHash: 'scrypt$16384$8$1$c2FsdA==$aGFzaA==', settings: {}, createdAt: 1, updatedAt: 2 };
  assert.equal(validateWireUser(good).username, 'amina');
  assert.equal(validateWireUser({ ...good, pwHash: 'plaintext' }), null);
  assert.equal(validateWireUser({ ...good, username: 'Bad Name' }), null);
  assert.equal(validateWireUser({ ...good, updatedAt: 'x' }), null);
  assert.equal(validateWireUser(null), null);
});

/* ---------- advice ---------- */

test('advice: calm, mild weather is good for field work', () => {
  const a = computeAdvice(calm, 'maize');
  assert.ok(a.score >= 90, `score ${a.score}`);
  const status = Object.fromEntries(a.items.map((i) => [i.task, i.status]));
  assert.deepEqual(status, { Planting: 'good', Spraying: 'good', Fertiliser: 'good', 'Harvest & drying': 'good' });
});

test('advice: rain and wind block spraying and lower the score', () => {
  const rainy = computeAdvice({ ...calm, popMax24: 0.8, rain24: 12 }, 'maize');
  assert.equal(rainy.items.find((i) => i.task === 'Spraying').status, 'wait');
  assert.ok(rainy.score < 60);
  const windy = computeAdvice({ ...calm, windMax24: 9 }, 'maize');
  assert.match(windy.items.find((i) => i.task === 'Spraying').text, /drift/);
});

test('advice: heavy rain holds fertiliser; dry spell warns', () => {
  assert.equal(computeAdvice({ ...calm, rain48: 40 }, 'beans').items.find((i) => i.task === 'Fertiliser').status, 'wait');
  assert.equal(computeAdvice({ ...calm, rain48: 0, rain5d: 3 }, 'beans').items.find((i) => i.task === 'Planting').status, 'warn');
});

test('advice: crop temperature limits and unknown crops', () => {
  assert.equal(computeAdvice({ ...calm, tmin5: 4 }, 'maize').items[0].status, 'wait');
  assert.equal(computeAdvice({ ...calm, tmax5: 31 }, 'coffee').items[0].status, 'wait');
  assert.ok(computeAdvice(calm, 'nonsense').items.length === 4);
  const s = computeAdvice({ ...calm, popMax24: 1, rain24: 50, windMax24: 40, tmax5: 60 }, 'maize').score;
  assert.ok(s >= 0 && s <= 100);
  assert.ok(Object.keys(CROPS).length >= 4);
});

/* ---------- weather normalisation ---------- */

test('normalizeForecast builds stats and days; rejects bad payloads', () => {
  const start = 1_700_000_000;
  const list = Array.from({ length: 40 }, (_, i) => ({
    dt: start + i * 10800, main: { temp: 20 + (i % 4), humidity: 50 }, weather: [{ main: 'Clouds', description: 'cloudy' }],
    wind: { speed: 3 }, pop: i === 2 ? 0.7 : 0, ...(i === 1 ? { rain: { '3h': 4.5 } } : {}),
  }));
  const city = { id: 'x', name: 'X', country: 'Y', lat: 0, lon: 0 };
  const out = normalizeForecast(city, { list, city: { timezone: 7200 } });
  assert.equal(out.stats.rain24, 4.5);
  assert.equal(out.stats.popMax24, 0.7);
  assert.equal(out.stats.tmax5, 23);
  assert.ok(out.days.length >= 5 || out.days.length === 5);
  assert.equal(out.now.condition, 'Clouds');
  assert.equal(normalizeForecast(city, { list: [] }), null);
  assert.equal(normalizeForecast(city, null), null);
  assert.equal(normalizeForecast(city, { list: Array(10).fill({ dt: 'x' }) }), null);
  assert.equal(buildStats([{ temp: 1, pop: 0, rain: 0, wind: 0 }]).tmin5, 1);
});

/* ---------- store (SQL safety) ---------- */

test('store: parameterised queries treat SQL injection strings as plain data', () => {
  const store = openStore(':memory:');
  const hash = 'scrypt$16384$8$1$c2FsdA==$aGFzaA==';
  assert.equal(store.createUser({ username: 'amina', pwHash: hash, settings: {} }), true);
  assert.equal(store.createUser({ username: 'amina', pwHash: hash, settings: {} }), false, 'duplicate rejected');
  assert.equal(store.getUser("amina' OR '1'='1"), null);
  assert.equal(store.getUser("'; DROP TABLE users; --"), null);
  assert.equal(store.countUsers(), 1, 'table intact');
  store.close();
});

test('store: settings update and last-write-wins replication', () => {
  const store = openStore(':memory:');
  const hash = 'scrypt$16384$8$1$c2FsdA==$aGFzaA==';
  store.createUser({ username: 'amina', pwHash: hash, settings: {}, now: 1000 });
  const updated = store.updateSettings('amina', { units: 'imperial', crop: 'coffee', favorites: ['kigali'] }, 2000);
  assert.equal(updated.settings.units, 'imperial');
  assert.equal(store.updateSettings('ghost', {}), null);

  const older = { username: 'amina', pwHash: hash, settings: { units: 'metric', crop: 'maize', favorites: [] }, createdAt: 1000, updatedAt: 1500 };
  assert.equal(store.upsertReplicated(older), false, 'older record ignored');
  assert.equal(store.getUser('amina').settings.units, 'imperial');
  assert.equal(store.upsertReplicated({ ...older, updatedAt: 9000 }), true, 'newer record applied');
  assert.equal(store.getUser('amina').settings.units, 'metric');
  assert.equal(store.upsertReplicated({ ...older, username: 'bola' }), true, 'new user inserted');
  store.close();
});

/* ---------- rate limiter ---------- */

test('rate limiter blocks after the limit and resets after the window', () => {
  const rl = new RateLimiter(2, 1000);
  assert.equal(rl.hit('a', 0), false);
  assert.equal(rl.hit('a', 1), false);
  assert.equal(rl.hit('a', 2), true);
  assert.equal(rl.hit('b', 2), false);
  assert.equal(rl.hit('a', 2000), false);
});
