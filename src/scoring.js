// Turns raw candidate routes into ranked, explained options.
//
// Each route is sampled every SAMPLE_M meters. A sample is "shaded" if it falls
// under the estimated crown of at least one street tree. A route is "flooded"
// if it passes within FLOOD_RADIUS_M of a FloodNet sensor currently reading
// FLOODED_MM or more; "wet" sensors add a smaller penalty.
//
// The ranking cost is an effective walking time in seconds:
//   cost = duration * (1 + HEAT_PENALTY * heatWeight * unshadedShare)
//        + wet sensors * WET_PENALTY_S
//        + (flooded ? FLOOD_PENALTY_S : 0)
// so on a mild day it's simply the fastest dry route, and on a hot day an
// unshaded minute "feels" up to (1 + HEAT_PENALTY) minutes long.

import { samplePath, distanceToPath, bbox } from './geo.js';
import { GridIndex } from './geo.js';

export const SAMPLE_M = 10;
export const FLOOD_RADIUS_M = 50;
export const HEAT_PENALTY = 0.6;
export const WET_PENALTY_S = 120;
export const FLOOD_PENALTY_S = 3600;
const SHADE_SLACK_M = 2; // sidewalk is a few meters from the tree pit line

export function shadeShare(path, treeIndex) {
  const samples = samplePath(path, SAMPLE_M);
  if (samples.length === 0) return { share: 0, shadedM: 0 };
  let shaded = 0;
  for (const p of samples) {
    for (const { item, dist } of treeIndex.near(p, 11)) {
      if (dist <= item.r + SHADE_SLACK_M) { shaded++; break; }
    }
  }
  return { share: shaded / samples.length, samples: samples.length, shaded };
}

export function floodHits(path, sensors) {
  const box = bbox(path, FLOOD_RADIUS_M);
  return sensors
    .filter((s) => s.lat >= box.minLat && s.lat <= box.maxLat && s.lng >= box.minLng && s.lng <= box.maxLng)
    .map((s) => ({ sensor: s, dist: distanceToPath([s.lat, s.lng], path) }))
    .filter(({ dist }) => dist <= FLOOD_RADIUS_M)
    .map(({ sensor, dist }) => ({ ...sensor, distanceM: Math.round(dist) }));
}

export function scoreRoutes(routes, { sensors, treeIndex = new GridIndex(), heatWeight = 0 }) {
  const scored = routes.map((route) => {
    const shade = shadeShare(route.path, treeIndex);
    const nearby = floodHits(route.path, sensors);
    const flooded = nearby.filter((s) => s.status === 'flooded');
    const wet = nearby.filter((s) => s.status === 'wet');
    const unknown = nearby.filter((s) => s.status === 'unknown');
    const cost =
      route.durationS * (1 + HEAT_PENALTY * heatWeight * (1 - shade.share)) +
      wet.length * WET_PENALTY_S +
      (flooded.length ? FLOOD_PENALTY_S : 0);
    return {
      ...route,
      shadePct: Math.round(shade.share * 100),
      sensors: { flooded, wet, unknown, dryCount: nearby.filter((s) => s.status === 'dry').length },
      floodStatus: flooded.length ? 'flooded' : wet.length ? 'wet' : 'clear',
      cost: Math.round(cost),
    };
  });
  scored.sort((a, b) => a.cost - b.cost);

  const fastest = scored.reduce((m, r) => (r.durationS < m.durationS ? r : m), scored[0]);
  const shadiest = scored.reduce((m, r) => (r.shadePct > m.shadePct ? r : m), scored[0]);
  return scored.map((r, i) => ({
    ...r,
    rank: i + 1,
    labels: [
      i === 0 && 'recommended',
      r === fastest && 'fastest',
      r === shadiest && r.shadePct > 0 && 'shadiest',
    ].filter(Boolean),
    extraMinutes: Math.round((r.durationS - fastest.durationS) / 60),
  }));
}
