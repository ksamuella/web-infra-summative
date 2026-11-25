'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer, validateParams, buildUsgsUrl, normalizeFeature } = require('../server');

let server;
let base;

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('normalizeFeature maps a USGS feature', () => {
  const q = normalizeFeature({
    id: 'us123',
    properties: { mag: 4.6, time: 1700000000000, place: '10 km N of Nairobi, Kenya', tsunami: 0, url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us123' },
    geometry: { coordinates: [36.8, -1.2, 10] },
  });
  assert.equal(q.id, 'us123');
  assert.equal(q.mag, 4.6);
  assert.equal(q.depth, 10);
  assert.equal(q.tsunami, false);
});

test('normalizeFeature drops events without a magnitude and untrusted URLs', () => {
  assert.equal(normalizeFeature({ id: 'x', properties: { mag: null, time: 1 }, geometry: {} }), null);
  const q = normalizeFeature({
    id: 'y',
    properties: { mag: 3, time: 1, place: 'p', url: 'javascript:alert(1)' },
    geometry: { coordinates: [0, 0, 1] },
  });
  assert.equal(q.url, null);
});

test('validateParams applies defaults and rejects bad input', () => {
  assert.deepEqual(validateParams(new URLSearchParams('')), { region: 'africa', period: 'week' });
  assert.ok(validateParams(new URLSearchParams('region=mars')).error);
  assert.ok(validateParams(new URLSearchParams('period=year')).error);
  assert.ok(validateParams(new URLSearchParams('region=__proto__')).error);
});

test('buildUsgsUrl includes bounding box and geojson format', () => {
  const url = new URL(buildUsgsUrl('east', 'day', Date.UTC(2026, 0, 2)));
  assert.equal(url.searchParams.get('format'), 'geojson');
  assert.equal(url.searchParams.get('minlatitude'), '-12');
  assert.equal(url.searchParams.get('starttime'), '2026-01-01T00:00:00');
});

test('GET /health returns ok', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'ok');
  assert.ok(res.headers.get('x-served-by'));
});

test('GET /api/whoami reports the server name', async () => {
  const res = await fetch(`${base}/api/whoami`);
  assert.equal(res.status, 200);
  assert.ok((await res.json()).server);
});

test('GET /api/quakes rejects an invalid region with 400', async () => {
  const res = await fetch(`${base}/api/quakes?region=nowhere`);
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error);
});

test('static files are served and path traversal is blocked', async () => {
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /QuakeWatch/);
  assert.ok(home.headers.get('content-security-policy'));

  const traversal = await fetch(`${base}/..%2Fserver.js`);
  assert.ok([403, 404].includes(traversal.status));
  assert.doesNotMatch(await traversal.text(), /createServer/);
});

test('non-GET methods are rejected', async () => {
  const res = await fetch(`${base}/health`, { method: 'POST' });
  assert.equal(res.status, 405);
});
