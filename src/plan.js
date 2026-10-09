// One trip request, start to finish: candidate routes, live flood readings,
// tree shade and weather, then ranking. Used by server.js and, for static
// hosting, by public/engine.js in the browser.

import { TreeStore } from './trees.js';
import { currentConditions } from './weather.js';
import { candidateRoutes, providerName } from './routing.js';
import { scoreRoutes, FLOOD_RADIUS_M } from './scoring.js';
import { bbox, samplePath } from './geo.js';

export const NYC = { minLat: 40.49, maxLat: 40.92, minLng: -74.27, maxLng: -73.68 };
const MAX_TRIP_M = 15000;

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

// Trees in the visible map area, as [lat, lng, crownRadiusM]. Kept to a few
// tiles so a zoomed-out map doesn't pull hundreds of thousands of trees.
export const MAX_VIEW_TILES = 12;
export async function treesInView(box, trees) {
  if (![box.minLat, box.minLng, box.maxLat, box.maxLng].every(Number.isFinite)) throw badRequest('"bbox" must be 4 numbers');
  const list = await trees.treesIn(box, MAX_VIEW_TILES);
  return { trees: list.map((t) => [+t.lat.toFixed(6), +t.lng.toFixed(6), t.r]) };
}

export function checkPoint(p, name) {
  if (!p.every(Number.isFinite)) throw badRequest(`"${name}" must be "lat,lng"`);
  if (p[0] < NYC.minLat || p[0] > NYC.maxLat || p[1] < NYC.minLng || p[1] > NYC.maxLng) {
    throw badRequest(`"${name}" is outside New York City, where FloodNet and the tree data cover.`);
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

// `getSensors(box)` resolves to { sensors, updatedAt, error } for FloodNet
// sensors in (at least) that box.
export async function planTrip(from, to, heatMode, { getSensors, trees = new TreeStore() }) {
  checkPoint(from, 'from');
  checkPoint(to, 'to');
  const [routes, weather] = await Promise.all([
    candidateRoutes(from, to),
    currentConditions(from[0], from[1]).catch((err) => ({ error: err.message, heatWeight: 0 })),
  ]);
  if (routes[0].distanceM > MAX_TRIP_M) throw badRequest('That walk is over 15 km; try a shorter trip.');

  const allPoints = routes.flatMap((r) => r.path);
  const [flood, tree] = await Promise.all([
    getSensors(bbox(allPoints, FLOOD_RADIUS_M + 10))
      .catch((err) => ({ sensors: [], updatedAt: null, error: err.message })),
    trees.indexFor(bbox(allPoints, 20))
      .then((index) => ({ index, error: null }), (err) => ({ index: undefined, error: err.message })),
  ]);

  const heatWeight = heatMode === 'on' ? 1 : heatMode === 'off' ? 0 : weather.heatWeight;
  const scored = scoreRoutes(routes, { sensors: flood.sensors, treeIndex: tree.index, heatWeight });

  return {
    from, to, provider: providerName(), heatMode, heatWeight,
    weather,
    floodnet: { updatedAt: flood.updatedAt, error: flood.error, sensorCount: flood.sensors.length },
    treeError: tree.error,
    routes: scored.map(({ path: p, ...r }) => ({ ...r, path: p.map(([a, b]) => [+a.toFixed(6), +b.toFixed(6)]) })),
    trees: tree.index ? treesAlong(scored, tree.index) : [],
  };
}
