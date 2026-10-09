// Candidate walking routes. Map providers return at most two or three
// alternatives, which often all share the one flooded block, so we also ask for
// routes through "via" points pushed off to either side of the straight line.
// Scoring (src/scoring.js) then picks among the candidates.

import { decodePolyline, haversine, samplePath, distanceToPath } from './geo.js';
import { fetchJson, mapLimit } from './http.js';
import { env } from './env.js';

const OSRM = env.OSRM_URL || 'https://routing.openstreetmap.de/routed-foot';
const GOOGLE_ROUTES = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const MAX_DETOUR = 1.5; // drop candidates more than 50% slower than the fastest

async function osrmRoutes(points, alternatives) {
  const coords = points.map(([lat, lng]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join(';');
  const url = `${OSRM}/route/v1/foot/${coords}?overview=full&geometries=polyline&alternatives=${alternatives ? 3 : false}`;
  const data = await fetchJson(url);
  if (data.code !== 'Ok') throw new Error(`OSRM: ${data.code} ${data.message || ''}`);
  return data.routes.map((r) => ({
    provider: 'osm',
    path: decodePolyline(r.geometry),
    distanceM: r.distance,
    durationS: r.duration,
  }));
}

async function googleRoutes(points, alternatives) {
  const latLng = ([latitude, longitude]) => ({ location: { latLng: { latitude, longitude } } });
  const body = {
    origin: latLng(points[0]),
    destination: latLng(points[points.length - 1]),
    intermediates: points.slice(1, -1).map((p) => ({ ...latLng(p), via: true })),
    travelMode: 'WALK',
    computeAlternativeRoutes: alternatives && points.length === 2,
  };
  const data = await fetchJson(GOOGLE_ROUTES, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline',
    },
    body: JSON.stringify(body),
  });
  return (data.routes || []).map((r) => ({
    provider: 'google',
    path: decodePolyline(r.polyline.encodedPolyline),
    distanceM: r.distanceMeters,
    durationS: parseFloat(r.duration),
  }));
}

export function providerName() {
  return env.GOOGLE_MAPS_API_KEY ? 'google' : 'osm';
}

function fetchRoutes(points, alternatives) {
  return providerName() === 'google' ? googleRoutes(points, alternatives) : osrmRoutes(points, alternatives);
}

// Points offset perpendicular to the origin→destination line, at the midpoint
// and at the thirds, so detours can bend around a problem anywhere along the way.
export function viaPoints(from, to) {
  const dist = haversine(from, to);
  const mLat = 1 / 111320;
  const mLng = 1 / (111320 * Math.cos((from[0] * Math.PI) / 180));
  // Unit vector perpendicular to the trip, in meters.
  const dx = (to[1] - from[1]) / mLng, dy = (to[0] - from[0]) / mLat;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len, py = dx / len;
  const out = [];
  for (const f of [0.5, 0.33, 0.67]) {
    const base = [from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f];
    const offsets = f === 0.5 ? [0.12, 0.25] : [0.15];
    for (const k of offsets) {
      const off = Math.min(800, Math.max(120, dist * k));
      for (const side of [1, -1]) {
        out.push([base[0] + side * py * off * mLat, base[1] + side * px * off * mLng]);
      }
    }
  }
  return out;
}

// True if `a` mostly retraces `b`.
export function isDuplicate(a, b, toleranceM = 20) {
  const samples = samplePath(a.path, 40);
  const close = samples.filter((p) => distanceToPath(p, b.path) <= toleranceM).length;
  return close / samples.length > 0.9;
}

export async function candidateRoutes(from, to) {
  const direct = await fetchRoutes([from, to], true);
  if (direct.length === 0) throw Object.assign(new Error('No walking route found between those points.'), { status: 422 });
  const detours = await mapLimit(viaPoints(from, to), 4, (via) =>
    fetchRoutes([from, via, to], false).catch(() => []),
  );

  const fastest = Math.min(...direct.map((r) => r.durationS));
  const all = [...direct, ...detours.flat()].filter((r) => r.durationS <= fastest * MAX_DETOUR);
  const unique = [];
  for (const r of all) {
    if (!unique.some((u) => isDuplicate(r, u))) unique.push(r);
  }
  return unique;
}
