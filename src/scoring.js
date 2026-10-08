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
    decidedBy: explain(r, scored, heatWeight),
    labels: [
      i === 0 && 'recommended',
      r === fastest && 'fastest',
      r === shadiest && r.shadePct > 0 && 'shadiest',
    ].filter(Boolean),
    extraMinutes: Math.round((r.durationS - fastest.durationS) / 60),
  }));
}

const SOURCES = { flood: 'FloodNet', shade: 'Street trees + NWS heat', time: 'Walk time' };
const describe = (s) => `${s.name}${s.depthMm != null ? ` (${s.depthMm} mm)` : ''}`;

// Names the one data source that put this route where it is in the ranking,
// with a short reason. `ranked` is sorted best first.
export function explain(r, ranked, heatWeight) {
  const best = ranked[0];
  const severity = { clear: 0, wet: 1, flooded: 2 };
  if (r === best) {
    if (r.floodStatus === 'flooded') {
      return { source: SOURCES.flood, text: 'Every route passes a flooded sensor; this one has the lowest cost.' };
    }
    const faster = ranked.filter((o) => o.durationS < r.durationS);
    if (faster.some((o) => severity[o.floodStatus] > severity[r.floodStatus])) {
      const hit = faster.flatMap((o) => [...o.sensors.flooded, ...o.sensors.wet])[0];
      return { source: SOURCES.flood, text: `Faster routes pass water at ${describe(hit)}; this one avoids it.` };
    }
    if (faster.length && heatWeight > 0) {
      const quickest = faster.reduce((m, o) => (o.durationS < m.durationS ? o : m));
      return { source: SOURCES.shade, text: `${r.shadePct}% shaded vs ${quickest.shadePct}% on the fastest route, and it's warm out.` };
    }
    return { source: SOURCES.time, text: r.floodStatus === 'wet' ? 'Quickest option; minor standing water nearby.' : 'Quickest route with no flooding reported.' };
  }
  if (severity[r.floodStatus] > severity[best.floodStatus]) {
    const hit = r.sensors.flooded[0] || r.sensors.wet[0];
    return { source: SOURCES.flood, text: `${r.floodStatus === 'flooded' ? 'Flooding' : 'Standing water'} at ${describe(hit)}.` };
  }
  if (heatWeight > 0 && r.shadePct < best.shadePct && r.durationS <= best.durationS) {
    return { source: SOURCES.shade, text: `Only ${r.shadePct}% shaded vs ${best.shadePct}% on the recommended route.` };
  }
  const slowerMin = Math.round((r.durationS - best.durationS) / 60);
  return {
    source: SOURCES.time,
    text: slowerMin >= 1 ? `${slowerMin} min slower than the recommended route.` : 'Within a minute of the recommended route.',
  };
}
