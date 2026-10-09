// Runs the whole app in the browser, for static hosting such as GitHub Pages
// where there's no server.js. It calls FloodNet, OSRM, NYC Open Data, NWS and
// NYC GeoSearch directly, and only asks FloodNet about sensors near the routes.

import { planTrip, treesInView } from '../src/plan.js';
import { fetchSensors } from '../src/floodnet.js';
import { geocode } from '../src/geocode.js';
import { TtlCache } from '../src/limits.js';
import { TreeStore } from '../src/trees.js';

const trees = new TreeStore();
const sensorCache = new TtlCache({ ttlMs: 3 * 60_000, maxEntries: 50 });
const geocodeCache = new TtlCache({ ttlMs: 3600_000, maxEntries: 500 });
let lastSensors = { sensors: [], updatedAt: null, error: null };

async function getSensors(box) {
  const key = Object.values(box).map((n) => n.toFixed(3)).join(',');
  const result = await sensorCache.get(key, async () => ({ sensors: await fetchSensors(Date.now(), { box }), updatedAt: new Date(), error: null }));
  lastSensors = result;
  return result;
}

export const browserApi = {
  mode: 'browser',
  route: (from, to, heat) => planTrip(from, to, heat, { getSensors, trees }),
  trees: (box) => treesInView(box, trees),
  // Only the sensors checked for the last trip; there's no background poller here.
  sensors: async () => lastSensors,
  geocode: (q) => geocodeCache.get(q.trim().toLowerCase(), () => geocode(q.trim().slice(0, 200))),
};
