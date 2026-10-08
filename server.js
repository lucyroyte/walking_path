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

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const NYC = { minLat: 40.49, maxLat: 40.92, minLng: -74.27, maxLng: -73.68 };
const MAX_TRIP_M = 15000;

const floodnet = new FloodNetCache();
const trees = new TreeStore();

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

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

async function handleRoute(q) {
  const from = parsePoint(q.get('from'), 'from');
  const to = parsePoint(q.get('to'), 'to');
  const heatMode = q.get('heat') || 'auto';

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
  const text = (q.get('q') || '').trim();
  if (!text) throw new HttpError(400, 'Missing "q"');
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
  if (!file.startsWith(PUBLIC)) throw new HttpError(404, 'Not found');
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    throw new HttpError(404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    const handler = API[url.pathname];
    if (!handler) return await serveStatic(url.pathname, res);
    const body = await handler(url.searchParams);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  } catch (err) {
    const status = err.status || 502;
    if (status >= 500) console.error(req.url, err);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

floodnet.start();
server.listen(PORT, () => {
  console.log(`Walking Path running at http://localhost:${PORT} (routing: ${providerName()})`);
});
