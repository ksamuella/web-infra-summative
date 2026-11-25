'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMockWeather, startApp, client, SECRETS } = require('./helpers');

let mock;
let app;
let base;

before(async () => {
  mock = await startMockWeather();
  app = await startApp({ apiBase: mock.url, authRateLimit: 100 });
  base = app.base;
});

after(async () => {
  await app.close();
  await mock.close();
});

/* ---------- weather API ---------- */

test('GET /api/cities returns advice for every city and uses the cache', async () => {
  const c = client(base);
  const before = mock.requests;
  const res = await c.request('GET', '/api/cities?crop=coffee');
  assert.equal(res.status, 200);
  assert.equal(res.json.crop, 'coffee');
  assert.equal(res.json.cities.length, 16);
  assert.equal(res.json.stale, false);
  const kigali = res.json.cities.find((x) => x.id === 'kigali');
  assert.ok(kigali.advice.score >= 0 && kigali.advice.items.length === 4);
  assert.equal(kigali.days.length, 5);
  assert.equal(mock.requests - before, 16);

  await c.request('GET', '/api/cities?crop=maize');
  assert.equal(mock.requests - before, 16, 'second call served from cache');
  assert.doesNotMatch(JSON.stringify(res.json), /test-key/, 'API key never leaves the server');
});

test('GET /api/cities rejects an invalid crop with 400', async () => {
  const res = await client(base).request('GET', '/api/cities?crop=rocks');
  assert.equal(res.status, 400);
});

test('GET /api/meta lists crops and cities', async () => {
  const res = await client(base).request('GET', '/api/meta');
  assert.equal(res.status, 200);
  assert.ok(res.json.crops.length >= 4 && res.json.cities.length === 16);
});

test('weather errors: missing key, rejected key, provider down, stale fallback', async () => {
  const noKey = await startApp({ apiBase: mock.url, apiKey: '' });
  const r1 = await client(noKey.base).request('GET', '/api/cities');
  assert.equal(r1.status, 503);
  assert.match(r1.json.error, /not configured/);
  await noKey.close();

  mock.mode = 'unauthorized';
  const badKey = await startApp({ apiBase: mock.url });
  const r2 = await client(badKey.base).request('GET', '/api/cities');
  assert.equal(r2.status, 503);
  assert.match(r2.json.error, /key was rejected/);
  await badKey.close();

  mock.mode = 'down';
  const cold = await startApp({ apiBase: mock.url });
  const r3 = await client(cold.base).request('GET', '/api/cities');
  assert.equal(r3.status, 502);
  await cold.close();

  mock.mode = 'ok';
  const warm = await startApp({ apiBase: mock.url, cacheTtlMs: 1 });
  const ok = await client(warm.base).request('GET', '/api/cities');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.stale, false);
  mock.mode = 'down';
  await new Promise((r) => setTimeout(r, 10));
  const stale = await client(warm.base).request('GET', '/api/cities');
  assert.equal(stale.status, 200);
  assert.equal(stale.json.stale, true, 'serves last good data when the provider is down');
  assert.equal(stale.json.cities.length, 16);
  await warm.close();
  mock.mode = 'ok';
});

/* ---------- accounts ---------- */

test('register, me, settings, logout, login flow', async () => {
  const c = client(base);
  assert.equal((await c.request('GET', '/api/me')).json.user, null);

  const reg = await c.request('POST', '/api/register', { body: { username: 'Amina', password: 'secret-pass-1' } });
  assert.equal(reg.status, 201);
  assert.equal(reg.json.user.username, 'amina');
  assert.equal(reg.json.user.pwHash, undefined, 'hash is never returned');
  const setCookie = reg.headers.getSetCookie()[0];
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);

  const me = await c.request('GET', '/api/me');
  assert.equal(me.json.user.username, 'amina');

  const put = await c.request('PUT', '/api/settings', { body: { units: 'imperial', crop: 'beans', favorites: ['kigali', 'nowhere'] } });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json.user.settings.favorites, ['kigali']);
  assert.equal((await c.request('GET', '/api/me')).json.user.settings.crop, 'beans');

  assert.equal((await c.request('POST', '/api/logout', { body: {} })).status, 200);
  assert.equal((await c.request('GET', '/api/me')).json.user, null);
  assert.equal((await c.request('PUT', '/api/settings', { body: { units: 'metric' } })).status, 401);

  const login = await c.request('POST', '/api/login', { body: { username: 'amina', password: 'secret-pass-1' } });
  assert.equal(login.status, 200);
  assert.equal(login.json.user.settings.units, 'imperial', 'settings persisted');
});

test('duplicate usernames, bad credentials and unknown users', async () => {
  const c = client(base);
  assert.equal((await c.request('POST', '/api/register', { body: { username: 'amina', password: 'another-pass-1' } })).status, 409);
  assert.equal((await c.request('POST', '/api/register', { body: { username: 'x', password: 'another-pass-1' } })).status, 400);
  const wrong = await c.request('POST', '/api/login', { body: { username: 'amina', password: 'wrong-password' } });
  const unknown = await c.request('POST', '/api/login', { body: { username: 'nobody', password: 'wrong-password' } });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrong.json.error, unknown.json.error, 'no user enumeration');
});

test('SQL injection payloads do not log in or damage the database', async () => {
  const c = client(base);
  for (const username of ["amina' --", "' OR '1'='1", "amina'; DROP TABLE users; --"]) {
    const res = await c.request('POST', '/api/login', { body: { username, password: "' OR '1'='1" } });
    assert.equal(res.status, 401);
  }
  assert.equal((await c.request('POST', '/api/login', { body: { username: 'amina', password: 'secret-pass-1' } })).status, 200);
  assert.ok(app.store.countUsers() >= 1);
});

test('forged and tampered session cookies are ignored', async () => {
  const c = client(base);
  c.cookie = 'hs_session=eyJ1IjoiYW1pbmEiLCJleHAiOjk5OTk5OTk5OTl9.invalidsignature';
  assert.equal((await c.request('GET', '/api/me')).json.user, null);
});

test('CSRF protections: JSON content type and same-origin required', async () => {
  const c = client(base);
  const form = await c.request('POST', '/api/login', {
    raw: 'username=amina&password=secret-pass-1', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(form.status, 415);
  const plain = await c.request('POST', '/api/login', { raw: '{}', headers: { 'content-type': 'text/plain' } });
  assert.equal(plain.status, 415);
  const cross = await c.request('POST', '/api/login', {
    body: { username: 'amina', password: 'secret-pass-1' }, headers: { origin: 'http://evil.example' },
  });
  assert.equal(cross.status, 403);
  const bad = await c.request('POST', '/api/login', { raw: '{not json', headers: { 'content-type': 'application/json' } });
  assert.equal(bad.status, 400);
  const big = await c.request('POST', '/api/login', { raw: JSON.stringify({ username: 'a'.repeat(20000) }), headers: { 'content-type': 'application/json' } });
  assert.equal(big.status, 413);
});

test('auth endpoints are rate limited', async () => {
  const limited = await startApp({ apiBase: mock.url, authRateLimit: 3 });
  const c = client(limited.base);
  const codes = [];
  for (let i = 0; i < 5; i += 1) {
    codes.push((await c.request('POST', '/api/login', { body: { username: 'nobody', password: 'wrong-password' } })).status);
  }
  assert.deepEqual(codes, [401, 401, 401, 429, 429]);
  await limited.close();
});

/* ---------- static, headers, misc ---------- */

test('health, whoami and security headers', async () => {
  const c = client(base);
  const health = await c.request('GET', '/health');
  assert.equal(health.json.status, 'ok');
  assert.equal(health.headers.get('x-served-by'), 'test');
  assert.equal((await c.request('GET', '/api/whoami')).json.server, 'test');
  assert.match(health.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
});

test('static files served; traversal and bad methods blocked', async () => {
  const c = client(base);
  const home = await c.request('GET', '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /HarvestSky/);
  for (const p of ['/..%2Fserver.js', '/%2e%2e/server.js', '/..%2F..%2Fetc%2Fpasswd', '/%00']) {
    const res = await c.request('GET', p);
    assert.ok([400, 403, 404].includes(res.status), `${p} -> ${res.status}`);
    assert.doesNotMatch(await res.text(), /createApp|root:/);
  }
  assert.equal((await c.request('POST', '/health', { body: {} })).status, 405);
  assert.equal((await c.request('DELETE', '/index.html')).status, 405);
  assert.equal((await c.request('GET', '/api/nothing')).status, 404);
});

test('internal sync endpoints are disabled without a secret and locked with one', async () => {
  assert.equal((await client(base).request('GET', '/internal/users')).status, 403);
  const noSync = await startApp({ syncSecret: '' });
  assert.equal((await client(noSync.base).request('GET', '/internal/users')).status, 404);
  await noSync.close();
});

/* ---------- two servers behind a load balancer ---------- */

test('accounts and sessions replicate between two servers', async () => {
  const a = await startApp({ apiBase: mock.url, serverName: 'web-01' });
  const b = await startApp({ apiBase: mock.url, serverName: 'web-02' });
  a.sync.peers.push(b.base);
  b.sync.peers.push(a.base);

  const onA = client(a.base);
  const reg = await onA.request('POST', '/api/register', { body: { username: 'farmer1', password: 'harvest-time-9' } });
  assert.equal(reg.status, 201);
  assert.equal(reg.headers.get('x-served-by'), 'web-01');

  // Same session cookie is accepted by the other server (shared AUTH_SECRET + replicated user).
  const onB = client(b.base);
  onB.cookie = onA.cookie;
  const me = await onB.request('GET', '/api/me');
  assert.equal(me.json.user.username, 'farmer1');
  assert.equal(me.headers.get('x-served-by'), 'web-02');

  // A fresh login on the second server works with the same password.
  const loginB = await client(b.base).request('POST', '/api/login', { body: { username: 'farmer1', password: 'harvest-time-9' } });
  assert.equal(loginB.status, 200);

  // Settings changed on B appear on A.
  await onB.request('PUT', '/api/settings', { body: { crop: 'potato', units: 'imperial' } });
  assert.equal(a.store.getUser('farmer1').settings.crop, 'potato');

  // A server that was offline catches up with a pull.
  const c = await startApp({ apiBase: mock.url, serverName: 'web-03' });
  c.sync.peers.push(a.base);
  assert.equal(c.store.getUser('farmer1'), null);
  assert.ok((await c.sync.pullAll()) >= 1);
  assert.equal(c.store.getUser('farmer1').settings.crop, 'potato');

  // Wrong secret cannot read or write accounts.
  const evil = await fetch(`${a.base}/internal/users`, { headers: { 'x-sync-secret': 'x'.repeat(24) } });
  assert.equal(evil.status, 403);
  const evilPush = await fetch(`${a.base}/internal/sync`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-sync-secret': 'x'.repeat(24) }, body: '{"users":[]}',
  });
  assert.equal(evilPush.status, 403);

  // Malformed replicated users are ignored.
  const junk = await fetch(`${a.base}/internal/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sync-secret': SECRETS.syncSecret },
    body: JSON.stringify({ users: [{ username: 'Bad Name', pwHash: 'x' }, null, 5] }),
  });
  assert.equal((await junk.json()).applied, 0);

  await a.close(); await b.close(); await c.close();
});
