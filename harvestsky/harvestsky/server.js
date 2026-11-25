'use strict';

/**
 * HarvestSky - backend.
 *
 * Zero-dependency Node.js (>= 22.13) server that:
 *   - serves the static frontend from ./public
 *   - proxies the OpenWeather forecast API (the API key never reaches the browser),
 *     with caching, de-duplication and stale-data fallback
 *   - provides accounts: scrypt password hashing, signed session cookies, per-user settings
 *   - replicates accounts to the peer web server so logins work behind a load balancer
 *   - exposes /health (load-balancer checks) and /api/whoami (shows which server answered)
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { HttpError } = require('./lib/errors');
const auth = require('./lib/auth');
const { openStore } = require('./lib/db');
const { RateLimiter } = require('./lib/ratelimit');
const { createWeatherService, WeatherError } = require('./lib/weather');
const { createSync } = require('./lib/sync');
const { CROPS, computeAdvice } = require('./lib/advice');
const CITIES = require('./lib/cities');
const { parseCredentials, sanitizeSettings, validateWireUser } = require('./lib/validate');

const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_TTL_SECONDS = 7 * 24 * 3600;

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Read configuration from environment variables (see .env.example). */
function configFromEnv(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const authSecret = env.AUTH_SECRET || '';
  if (production && authSecret.length < 32) {
    throw new Error('AUTH_SECRET (at least 32 characters) is required in production. Generate one with: openssl rand -hex 32');
  }
  const peers = (env.PEERS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  if (peers.length && (env.SYNC_SECRET || '').length < 16) {
    throw new Error('SYNC_SECRET (at least 16 characters) is required when PEERS is set.');
  }
  return {
    port: Number(env.PORT) || 3000,
    host: env.HOST || '0.0.0.0',
    serverName: env.SERVER_NAME || os.hostname(),
    apiKey: env.OPENWEATHER_API_KEY || '',
    apiBase: env.OPENWEATHER_BASE_URL || 'https://api.openweathermap.org',
    cacheTtlMs: (Number(env.CACHE_TTL_SECONDS) || 1800) * 1000,
    dbPath: env.DB_PATH || path.join(__dirname, 'data', 'harvestsky.db'),
    authSecret: authSecret || crypto.randomBytes(32).toString('hex'),
    authSecretGenerated: !authSecret,
    syncSecret: env.SYNC_SECRET || '',
    peers,
    trustProxy: env.TRUST_PROXY === '1',
    cookieSecure: env.COOKIE_SECURE === '1',
    apiRateLimit: Number(env.RATE_LIMIT_PER_MIN) || 300,
    authRateLimit: Number(env.AUTH_RATE_LIMIT) || 20,
  };
}

function createApp(cfg) {
  const log = { warn: (...a) => console.warn(...a), error: (...a) => console.error(...a) };
  const store = openStore(cfg.dbPath);
  const weather = createWeatherService({
    apiKey: cfg.apiKey, apiBase: cfg.apiBase, ttlMs: cfg.cacheTtlMs, fetchImpl: cfg.fetchImpl || fetch,
  });
  const sync = createSync({ store, peers: cfg.peers, secret: cfg.syncSecret, log });
  const apiLimiter = new RateLimiter(cfg.apiRateLimit, 60 * 1000);
  const authLimiter = new RateLimiter(cfg.authRateLimit, 15 * 60 * 1000);
  const dummyHash = auth.hashPassword('not-a-real-password'); // equalises timing for unknown users

  /* ---------------- helpers ---------------- */

  function sendJson(res, status, body, extraHeaders = {}) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(data),
      'Cache-Control': 'no-store',
      'X-Served-By': cfg.serverName,
      ...SECURITY_HEADERS,
      ...extraHeaders,
    });
    res.end(data);
  }

  function clientIp(req) {
    // Only trust X-Real-IP when a reverse proxy we control sits in front of Node.
    if (cfg.trustProxy && req.headers['x-real-ip']) return String(req.headers['x-real-ip']);
    return req.socket.remoteAddress || 'unknown';
  }

  /** Reject browser requests that come from another origin. */
  function assertSameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return;
    let host = null;
    try {
      host = new URL(origin).host;
    } catch { /* invalid origin */ }
    if (host !== req.headers.host) throw new HttpError(403, 'Cross-origin request blocked.');
  }

  /** Read a JSON body. Requiring application/json also blocks simple cross-site form posts. */
  async function readJson(req, limit = 10 * 1024) {
    const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json.');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413, 'Request body too large.');
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      throw new HttpError(400, 'Invalid JSON.');
    }
  }

  function currentUser(req) {
    const token = auth.parseCookies(req.headers.cookie)[auth.COOKIE_NAME];
    const username = auth.verifyToken(token, cfg.authSecret);
    return username ? store.getUser(username) : null;
  }

  const publicUser = (u) => ({ username: u.username, settings: u.settings });

  function setSessionCookie(req, username) {
    const secure = cfg.cookieSecure || (cfg.trustProxy && req.headers['x-forwarded-proto'] === 'https');
    const token = auth.createToken(username, cfg.authSecret, SESSION_TTL_SECONDS);
    return { 'Set-Cookie': auth.sessionCookie(token, { maxAge: SESSION_TTL_SECONDS, secure }) };
  }

  /* ---------------- routes ---------------- */

  async function handleApi(req, res, url) {
    const ip = clientIp(req);
    if (apiLimiter.hit(ip)) throw new HttpError(429, 'Too many requests. Please slow down.', { 'Retry-After': '60' });

    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case 'GET /api/whoami':
        return sendJson(res, 200, { server: cfg.serverName, pid: process.pid, time: new Date().toISOString() });

      case 'GET /api/meta':
        return sendJson(res, 200, {
          crops: Object.entries(CROPS).map(([id, c]) => ({ id, label: c.label })),
          cities: CITIES.map((c) => ({ id: c.id, name: c.name, country: c.country })),
        });

      case 'GET /api/cities': {
        const crop = url.searchParams.get('crop') || 'maize';
        if (!Object.hasOwn(CROPS, crop)) throw new HttpError(400, `Invalid crop. Use one of: ${Object.keys(CROPS).join(', ')}`);
        let result;
        try {
          result = await weather.getAll();
        } catch (err) {
          if (err instanceof WeatherError) {
            log.error(`[${cfg.serverName}] weather error: ${err.message}`);
            throw new HttpError(err.status, err.userMessage);
          }
          throw err;
        }
        const fetchedAt = result.cities.map((c) => c.fetchedAt).sort()[0];
        return sendJson(res, 200, {
          server: cfg.serverName, crop, fetchedAt, stale: result.stale, failed: result.failed,
          cities: result.cities.map((c) => ({ ...c, advice: computeAdvice(c.stats, crop) })),
        });
      }

      case 'GET /api/me': {
        const user = currentUser(req);
        return sendJson(res, 200, { user: user ? publicUser(user) : null });
      }

      case 'POST /api/register': {
        assertSameOrigin(req);
        if (authLimiter.hit(ip)) throw new HttpError(429, 'Too many attempts. Please wait and try again.', { 'Retry-After': '900' });
        const { username, password } = parseCredentials(await readJson(req));
        const pwHash = await auth.hashPassword(password);
        if (!store.createUser({ username, pwHash, settings: {} })) throw new HttpError(409, 'That username is already taken.');
        const user = store.getUser(username);
        await sync.pushUsers([user]);
        return sendJson(res, 201, { user: publicUser(user) }, setSessionCookie(req, username));
      }

      case 'POST /api/login': {
        assertSameOrigin(req);
        if (authLimiter.hit(ip)) throw new HttpError(429, 'Too many attempts. Please wait and try again.', { 'Retry-After': '900' });
        const body = await readJson(req);
        let creds;
        try {
          creds = parseCredentials(body);
        } catch {
          throw new HttpError(401, 'Invalid username or password.');
        }
        const user = store.getUser(creds.username);
        const ok = await auth.verifyPassword(creds.password, user ? user.pwHash : await dummyHash);
        if (!user || !ok) throw new HttpError(401, 'Invalid username or password.');
        return sendJson(res, 200, { user: publicUser(user) }, setSessionCookie(req, user.username));
      }

      case 'POST /api/logout': {
        assertSameOrigin(req);
        await readJson(req);
        return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.sessionCookie('', { maxAge: 0, secure: false }) });
      }

      case 'PUT /api/settings': {
        assertSameOrigin(req);
        const user = currentUser(req);
        if (!user) throw new HttpError(401, 'Please log in first.');
        const body = await readJson(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid request.');
        const updated = store.updateSettings(user.username, sanitizeSettings({ ...user.settings, ...body }));
        await sync.pushUsers([updated]);
        return sendJson(res, 200, { user: publicUser(updated) });
      }

      default:
        throw new HttpError(url.pathname.startsWith('/api/') ? 404 : 405, 'Unknown API endpoint.');
    }
  }

  /** Server-to-server endpoints. Protected by a shared secret and blocked at the load balancer. */
  async function handleInternal(req, res, url) {
    if (!cfg.syncSecret) throw new HttpError(404, 'Not found.');
    if (!auth.safeEqual(req.headers['x-sync-secret'] || '', cfg.syncSecret)) throw new HttpError(403, 'Forbidden.');

    if (req.method === 'GET' && url.pathname === '/internal/users') {
      return sendJson(res, 200, { users: store.listUsers() });
    }
    if (req.method === 'POST' && url.pathname === '/internal/sync') {
      const body = await readJson(req, 1024 * 1024);
      const incoming = Array.isArray(body.users) ? body.users.slice(0, 1000) : [];
      let applied = 0;
      for (const raw of incoming) {
        const user = validateWireUser(raw);
        if (user && store.upsertReplicated(user)) applied += 1;
      }
      return sendJson(res, 200, { applied });
    }
    throw new HttpError(404, 'Not found.');
  }

  async function serveStatic(pathname, req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'Bad request.');
    }
    if (rel.includes('\0')) throw new HttpError(400, 'Bad request.');
    if (rel === '/') rel = '/index.html';

    const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Forbidden.');
    let data;
    try {
      data = await fs.promises.readFile(filePath);
    } catch {
      throw new HttpError(404, 'Not found.');
    }
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      'X-Served-By': cfg.serverName,
      ...SECURITY_HEADERS,
    });
    res.end(data);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      return sendJson(res, 200, {
        status: 'ok', server: cfg.serverName, uptimeSeconds: Math.round(process.uptime()), users: store.countUsers(),
      });
    }
    if (url.pathname.startsWith('/internal/')) return handleInternal(req, res, url);
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    return serveStatic(url.pathname, req, res);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message }, err.headers);
      log.error(`[${cfg.serverName}] Unhandled error:`, err);
      return sendJson(res, 500, { error: 'Internal server error.' });
    });
  });
  server.requestTimeout = 30000;

  return {
    server,
    store,
    sync,
    weather,
    listen: (port = cfg.port, host = cfg.host) => new Promise((resolve) => server.listen(port, host, () => resolve(server.address()))),
    close: () => new Promise((resolve) => {
      sync.stop();
      server.close(() => {
        store.close();
        resolve();
      });
      server.closeAllConnections();
    }),
  };
}

if (require.main === module) {
  const cfg = configFromEnv();
  if (cfg.authSecretGenerated) {
    console.warn('[warn] AUTH_SECRET is not set: using a random secret. Sessions will reset on restart and will not work across servers.');
  }
  if (!cfg.apiKey) console.warn('[warn] OPENWEATHER_API_KEY is not set: weather data will not load.');
  const app = createApp(cfg);
  app.listen().then(() => {
    console.log(`HarvestSky [${cfg.serverName}] listening on http://${cfg.host}:${cfg.port}`);
    if (cfg.peers.length) console.log(`Replicating accounts with: ${cfg.peers.join(', ')}`);
    app.sync.start(30000);
  });
  const shutdown = () => app.close().then(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createApp, configFromEnv };
