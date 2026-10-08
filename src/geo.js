// Small geometry helpers. Coordinates are [lat, lng] pairs throughout.

const R = 6371008.8; // mean Earth radius, meters
const toRad = (d) => (d * Math.PI) / 180;

export function haversine([lat1, lng1], [lat2, lng2]) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Decode a Google-style encoded polyline (used by OSRM and Google Routes).
export function decodePolyline(str, precision = 5) {
  const factor = 10 ** precision;
  const coords = [];
  let index = 0, lat = 0, lng = 0;
  while (index < str.length) {
    for (const which of [0, 1]) {
      let result = 0, shift = 0, byte;
      do {
        byte = str.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lng += delta;
    }
    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}

export function pathLength(path) {
  let d = 0;
  for (let i = 1; i < path.length; i++) d += haversine(path[i - 1], path[i]);
  return d;
}

// Points every `step` meters along a path, including both endpoints.
export function samplePath(path, step = 15) {
  if (path.length === 0) return [];
  const out = [path[0]];
  let carry = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const seg = haversine(a, b);
    let t = step - carry;
    while (t <= seg) {
      const f = t / seg;
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
      t += step;
    }
    carry = seg - (t - step);
  }
  const last = path[path.length - 1];
  if (haversine(out[out.length - 1], last) > 1) out.push(last);
  return out;
}

// Local equirectangular projection to meters; accurate enough at city scale.
function project([lat, lng], lat0) {
  return [toRad(lng) * R * Math.cos(toRad(lat0)), toRad(lat) * R];
}

export function pointToSegmentDistance(p, a, b) {
  const lat0 = p[0];
  const [px, py] = project(p, lat0);
  const [ax, ay] = project(a, lat0);
  const [bx, by] = project(b, lat0);
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function distanceToPath(p, path) {
  if (path.length === 1) return haversine(p, path[0]);
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    best = Math.min(best, pointToSegmentDistance(p, path[i - 1], path[i]));
  }
  return best;
}

export function bbox(path, padMeters = 0) {
  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
  for (const [lat, lng] of path) {
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
  }
  const dLat = padMeters / 111320;
  const dLng = padMeters / (111320 * Math.cos(toRad((minLat + maxLat) / 2)));
  return { minLat: minLat - dLat, minLng: minLng - dLng, maxLat: maxLat + dLat, maxLng: maxLng + dLng };
}

// Uniform grid of points for fast "what's within r meters" lookups.
export class GridIndex {
  constructor(cellMeters = 50) {
    this.cellLat = cellMeters / 111320;
    this.cellLng = cellMeters / (111320 * Math.cos(toRad(40.7)));
    this.cells = new Map();
    this.size = 0;
  }
  key(i, j) { return `${i}:${j}`; }
  cellOf([lat, lng]) { return [Math.floor(lat / this.cellLat), Math.floor(lng / this.cellLng)]; }
  insert(point, item) {
    const [i, j] = this.cellOf(point);
    const k = this.key(i, j);
    if (!this.cells.has(k)) this.cells.set(k, []);
    this.cells.get(k).push({ point, item });
    this.size++;
  }
  // Yields { point, item, dist } for entries within `radius` meters of p.
  *near(p, radius) {
    const [ci, cj] = this.cellOf(p);
    const ri = Math.ceil(radius / 111320 / this.cellLat);
    const rj = Math.ceil(radius / (111320 * Math.cos(toRad(p[0]))) / this.cellLng);
    for (let i = ci - ri; i <= ci + ri; i++) {
      for (let j = cj - rj; j <= cj + rj; j++) {
        const cell = this.cells.get(this.key(i, j));
        if (!cell) continue;
        for (const e of cell) {
          const dist = haversine(p, e.point);
          if (dist <= radius) yield { ...e, dist };
        }
      }
    }
  }
}
