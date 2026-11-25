'use strict';

/**
 * QuakeWatch Africa - backend
 *
 * A zero-dependency Node.js server that:
 *   1. Serves the static frontend from ./public
 *   2. Proxies and normalises earthquake data from the USGS FDSN Event API
 *      (https://earthquake.usgs.gov/fdsnws/event/1/), with an in-memory cache,
 *      input validation, rate limiting and stale-cache fallback.
 *   3. Exposes /health (for load-balancer health checks) and /api/whoami
 *      (so you can prove which backend answered a request).
 *
 * The USGS API is public and needs no API key, so there are no secrets in this
 * project. Configuration is read from environment variables (see .env.example).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const SERVER_NAME = process.env.SERVER_NAME || os.hostname();
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_SECONDS) || 120) * 1000;
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN) || 300;
const USGS_TIMEOUT_MS = 8000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const USGS_URL = process.env.USGS_URL || 'https://earthquake.usgs.gov/fdsnws/event/1/query';

/** Bounding boxes (degrees) for the regions the UI offers. */
const REGIONS = {
  africa: { minlatitude: -35, maxlatitude: 38, minlongitude: -20, maxlongitude: 52 },
  east: { minlatitude: -12, maxlatitude: 15, minlongitude: 28, maxlongitude: 45 },
  north: { minlatitude: 15, maxlatitude: 38, minlongitude: -20, maxlongitude: 40 },
  southern: { minlatitude: -35, maxlatitude: -10, minlongitude: 10, maxlongitude: 42 },
};

/** Look-back windows in days. */
const PERIODS = { day: 1, week: 7, month: 30 };

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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

/* ------------------------------------------------------------------ */
/* Data helpers                                                        */
/* ------------------------------------------------------------------ */

/** Validate query parameters. Returns { region, period } or { error }. */
function validateParams(searchParams) {
  const region = searchParams.get('region') || 'africa';
  const period = searchParams.get('period') || 'week';
  if (!Object.hasOwn(REGIONS, region)) {
    return { error: `Invalid region. Use one of: ${Object.keys(REGIONS).join(', ')}` };
  }
  if (!Object.hasOwn(PERIODS, period)) {
    return { error: `Invalid period. Use one of: ${Object.keys(PERIODS).join(', ')}` };
  }
  return { region, period };
}

/** Build the USGS query URL for a region and period. */
function buildUsgsUrl(region, period, now = Date.now()) {
  const params = new URLSearchParams({
    format: 'geojson',
    orderby: 'time',
    limit: '2000',
    minmagnitude: '1',
    starttime: new Date(now - PERIODS[period] * 86400000).toISOString().slice(0, 19),
    ...Object.fromEntries(Object.entries(REGIONS[region]).map(([k, v]) => [k, String(v)])),
  });
  return `${USGS_URL}?${params}`;
}

/** Convert one USGS GeoJSON feature into the compact shape the UI uses. */
function normalizeFeature(feature) {
  const props = (feature && feature.properties) || {};
  const coords = (feature && feature.geometry && feature.geometry.coordinates) || [];
  if (typeof props.mag !== 'number' || typeof props.time !== 'number') return null;
  const [lon, lat, depth] = coords;
  const url = typeof props.url === 'string' && props.url.startsWith('https://earthquake.usgs.gov/')
    ? props.url
    : null;
  return {
    id: String(feature.id),
    time: props.time,
    mag: props.mag,
    place: String(props.place || 'Unknown location'),
    depth: typeof depth === 'number' ? depth : null,
    lat: typeof lat === 'number' ? lat : null,
    lon: typeof lon === 'number' ? lon : null,
    tsunami: props.tsunami === 1,
    url,
  };
}

const cache = new Map();

/** Fetch quakes with caching and graceful fallback to stale data. */
async function getQuakes(region, period) {
  const key = `${region}|${period}`;
  const now = Date.now();
  const hit = cache.get(key);

  if (hit && now - hit.at < CACHE_TTL_MS) {
    return { ...hit.payload, cached: true, stale: false };
  }

  try {
    const res = await fetch(buildUsgsUrl(region, period, now), {
      signal: AbortSignal.timeout(USGS_TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        'User-Agent': 'QuakeWatchAfrica/1.0 (student project)',
      },
    });
    if (!res.ok) throw new Error(`USGS responded with HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.features)) {
      throw new Error('Unexpected response format from USGS');
    }
    const quakes = data.features.map(normalizeFeature).filter(Boolean);
    const payload = {
      region,
      period,
      fetchedAt: new Date(now).toISOString(),
      count: quakes.length,
      quakes,
    };
    cache.set(key, { at: now, payload });
    return { ...payload, cached: false, stale: false };
  } catch (err) {
    if (hit) {
      // USGS is down or slow: serve the last good data instead of failing.
      return { ...hit.payload, cached: true, stale: true };
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Rate limiting (simple fixed window per client)                      */
/* ------------------------------------------------------------------ */

const hits = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now > entry.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + 60000 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_PER_MIN;
}

function clientIp(req) {
  const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

/* ------------------------------------------------------------------ */
/* HTTP handling                                                       */
/* ------------------------------------------------------------------ */

function sendJson(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Served-By': SERVER_NAME,
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(data);
}

async function serveStatic(pathname, res) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: 'Bad request' });
  }
  if (rel.includes('\0')) return sendJson(res, 400, { error: 'Bad request' });
  if (rel === '/') rel = '/index.html';

  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }

  try {
    const data = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'X-Served-By': SERVER_NAME,
      ...SECURITY_HEADERS,
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
  }

  if (url.pathname === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      server: SERVER_NAME,
      uptimeSeconds: Math.round(process.uptime()),
    });
  }

  if (url.pathname.startsWith('/api/')) {
    if (isRateLimited(clientIp(req))) {
      return sendJson(res, 429, { error: 'Too many requests. Please slow down.' }, { 'Retry-After': '60' });
    }

    if (url.pathname === '/api/whoami') {
      return sendJson(res, 200, {
        server: SERVER_NAME,
        pid: process.pid,
        time: new Date().toISOString(),
      });
    }

    if (url.pathname === '/api/quakes') {
      const params = validateParams(url.searchParams);
      if (params.error) return sendJson(res, 400, { error: params.error });
      try {
        const payload = await getQuakes(params.region, params.period);
        return sendJson(res, 200, { server: SERVER_NAME, ...payload });
      } catch (err) {
        console.error(`[${SERVER_NAME}] USGS request failed:`, err.message);
        return sendJson(res, 502, {
          error: 'The USGS earthquake service is unavailable right now. Please try again shortly.',
        });
      }
    }

    return sendJson(res, 404, { error: 'Unknown API endpoint' });
  }

  return serveStatic(url.pathname, res);
}

function createServer() {
  return http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error(`[${SERVER_NAME}] Unhandled error:`, err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
      else res.end();
    });
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`QuakeWatch Africa [${SERVER_NAME}] listening on http://${HOST}:${PORT}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer, validateParams, buildUsgsUrl, normalizeFeature, REGIONS, PERIODS };
