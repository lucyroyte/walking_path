import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FloodNetCache } from './src/floodnet.js';
import { TreeStore } from './src/trees.js';
import { currentConditions } from './src/weather.js';
import { candidateRoutes, providerName } from './src/routing.js';
import { scoreRoutes } from './src/scoring.js';
import { bbox, samplePath } from './src/geo.js';
import { fetchJson } from './src/http.js';
import { RateLimiter, TtlCache } from './src/limits.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
// Behind a load balancer or CDN, set TRUST_PROXY=1 so rate limits use the
// visitor's address from X-Forwarded-For instead of the proxy's.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const NYC = { minLat: 40.49, maxLat: 40.92, minLng: -74.27, maxLng: -73.68 };
const MAX_TRIP_M = 15000;

const floodnet = new FloodNetCache();
const trees = new TreeStore();

class HttpError extends Error {
  constructor(status, message, headers = {}) { super(message); this.status = status; this.headers = headers; }
}

// Each route request makes about ten calls to the routing server, so limit it
// harder than the cheap endpoints.
const LIMITS = {
  '/api/route': new RateLimiter({ max: Number(process.env.ROUTE_LIMIT_PER_MIN) || 20, windowMs: 60_000 }),
  '/api/geocode': new RateLimiter({ max: 120, windowMs: 60_000 }),
  '/api/sensors': new RateLimiter({ max: 30, windowMs: 60_000 }),
};
const routeCache = new TtlCache({ ttlMs: 2 * 60_000 });
const geocodeCache = new TtlCache({ ttlMs: 24 * 3600_000, maxEntries: 2000 });

function clientIp(req) {
  const fwd = TRUST_PROXY && req.headers['x-forwarded-for'];
  return fwd ? fwd.split(',')[0].trim() : req.socket.remoteAddress;
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' https://unpkg.com",
    "style-src 'self' 'unsafe-inline' https://unpkg.com",
    "img-src 'self' data: https://*.tile.openstreetmap.org https://unpkg.com",
    "connect-src 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

function parsePoint(s, name) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s || '');
  if (!m) throw new HttpError(400, `"${name}" must be "lat,lng"`);
  const p = [Number(m[1]), Number(m[2])];
  if (p[0] < NYC.minLat || p[0] > NYC.maxLat || p[1] < NYC.minLng || p[1] > NYC.maxLng) {
    throw new HttpError(400, `"${name}" is outside New York City, where FloodNet and the tree data cover.`);
  }
  return p;
}

// Trees within a few meters of any candidate route, for drawing on the map.
function treesAlong(routes, treeIndex, limit = 6000) {
  const seen = new Set();
  const out = [];
  for (const r of routes) {
    for (const p of samplePath(r.path, 10)) {
      for (const { item } of treeIndex.near(p, 12)) {
        const k = `${item.lat},${item.lng}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push([+item.lat.toFixed(6), +item.lng.toFixed(6), item.r]);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

function handleRoute(q) {
  const from = parsePoint(q.get('from'), 'from');
  const to = parsePoint(q.get('to'), 'to');
  const heatMode = ['auto', 'on', 'off'].includes(q.get('heat')) ? q.get('heat') : 'auto';
  // ~1 m precision, so repeat clicks and shared links hit the cache.
  const key = [...from, ...to].map((n) => n.toFixed(5)).join(',') + heatMode;
  return routeCache.get(key, () => computeRoute(from, to, heatMode));
}

async function computeRoute(from, to, heatMode) {

  const [routes, flood, weather] = await Promise.all([
    candidateRoutes(from, to),
    floodnet.get(),
    currentConditions(from[0], from[1]).catch((err) => ({ error: err.message, heatWeight: 0 })),
  ]);
  if (routes[0].distanceM > MAX_TRIP_M) throw new HttpError(400, 'That walk is over 15 km; try a shorter trip.');

  const box = bbox(routes.flatMap((r) => r.path), 20);
  let treeIndex, treeError = null;
  try {
    treeIndex = await trees.indexFor(box);
  } catch (err) {
    treeError = err.message;
  }

  const heatWeight = heatMode === 'on' ? 1 : heatMode === 'off' ? 0 : weather.heatWeight;
  const scored = scoreRoutes(routes, { sensors: flood.sensors, treeIndex, heatWeight });

  return {
    from, to, provider: providerName(), heatMode, heatWeight,
    weather,
    floodnet: { updatedAt: flood.updatedAt, error: flood.error, sensorCount: flood.sensors.length },
    treeError,
    routes: scored.map(({ path: p, ...r }) => ({ ...r, path: p.map(([a, b]) => [+a.toFixed(6), +b.toFixed(6)]) })),
    trees: treeIndex ? treesAlong(scored, treeIndex) : [],
  };
}

async function handleSensors() {
  const { sensors, updatedAt, error } = await floodnet.get();
  return { updatedAt, error, sensors };
}

async function handleGeocode(q) {
  const text = (q.get('q') || '').trim().slice(0, 200);
  if (!text) throw new HttpError(400, 'Missing "q"');
  return geocodeCache.get(text.toLowerCase(), () => geocode(text));
}

async function geocode(text) {
  const data = await fetchJson(`https://geosearch.planninglabs.nyc/v2/autocomplete?text=${encodeURIComponent(text)}`);
  return {
    results: data.features.slice(0, 6).map((f) => ({
      label: f.properties.label,
      lat: f.geometry.coordinates[1],
      lng: f.geometry.coordinates[0],
    })),
  };
}

const API = { '/api/route': handleRoute, '/api/sensors': handleSensors, '/api/geocode': handleGeocode };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC + path.sep)) throw new HttpError(404, 'Not found');
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=300',
    });
    res.end(body);
  } catch {
    throw new HttpError(404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed', { Allow: 'GET, HEAD' });
    const handler = API[url.pathname];
    if (!handler) return await serveStatic(url.pathname, res);
    const wait = LIMITS[url.pathname].check(clientIp(req));
    if (wait) throw new HttpError(429, 'Too many requests; try again in a minute.', { 'Retry-After': String(wait) });
    const body = await handler(url.searchParams);
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  } catch (err) {
    const status = err.status || 502;
    if (status >= 500) console.error(req.url, err);
    res.writeHead(status, { ...SECURITY_HEADERS, ...err.headers, 'Content-Type': 'application/json' });
    // Upstream failures can carry third-party URLs and response bodies; keep those in the server log.
    res.end(JSON.stringify({ error: status >= 500 ? 'A data service is not responding. Please try again shortly.' : err.message }));
  }
});

floodnet.start();
server.listen(PORT, HOST, () => {
  console.log(`Walking Path running at http://localhost:${PORT} (routing: ${providerName()})`);
});
