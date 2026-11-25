'use strict';

const http = require('node:http');
const { createApp } = require('../server');

/** A fake OpenWeather server. Set mock.mode to 'ok' | 'down' | 'unauthorized'. */
async function startMockWeather() {
  const mock = { mode: 'ok', requests: 0, server: null, url: '' };
  mock.server = http.createServer((req, res) => {
    mock.requests += 1;
    if (mock.mode === 'down') { res.writeHead(500); return res.end('boom'); }
    if (mock.mode === 'unauthorized') { res.writeHead(401); return res.end('{}'); }
    const start = Math.floor(Date.now() / 10800000) * 10800;
    const list = Array.from({ length: 40 }, (_, i) => ({
      dt: start + i * 10800,
      main: { temp: 18 + (i % 8), humidity: 60 },
      weather: [{ main: i % 5 === 0 ? 'Rain' : 'Clouds', description: i % 5 === 0 ? 'light rain' : 'scattered clouds' }],
      wind: { speed: 2 + (i % 3) },
      pop: i % 5 === 0 ? 0.6 : 0.1,
      ...(i % 5 === 0 ? { rain: { '3h': 2 } } : {}),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cod: '200', list, city: { timezone: 7200 } }));
  });
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  mock.url = `http://127.0.0.1:${mock.server.address().port}`;
  mock.close = () => new Promise((resolve) => { mock.server.closeAllConnections(); mock.server.close(resolve); });
  return mock;
}

const SECRETS = { authSecret: 'a'.repeat(40), syncSecret: 's'.repeat(24) };

/** Start an app on a random port with an in-memory database. */
async function startApp(overrides = {}) {
  const cfg = {
    port: 0, host: '127.0.0.1', serverName: 'test', apiKey: 'test-key', apiBase: 'http://127.0.0.1:1',
    cacheTtlMs: 60000, dbPath: ':memory:', ...SECRETS, peers: [], trustProxy: false, cookieSecure: false,
    apiRateLimit: 1000, authRateLimit: 100, ...overrides,
  };
  const app = createApp(cfg);
  const addr = await app.listen(0, '127.0.0.1');
  app.base = `http://127.0.0.1:${addr.port}`;
  return app;
}

/** Tiny HTTP client with a cookie jar. */
function client(base) {
  let cookie = '';
  async function request(method, path, { body, headers = {}, raw } = {}) {
    const init = { method, headers: { ...headers } };
    if (cookie) init.headers.cookie = cookie;
    if (raw !== undefined) init.body = raw;
    else if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(base + path, init);
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0];
      cookie = pair.endsWith('=') ? '' : pair;
    }
    let json = null;
    try { json = await res.clone().json(); } catch { /* not json */ }
    return { status: res.status, json, headers: res.headers, text: () => res.text() };
  }
  return { request, get cookie() { return cookie; }, set cookie(v) { cookie = v; } };
}

module.exports = { startMockWeather, startApp, client, SECRETS };
