// Live street-flood readings from FloodNet NYC (https://www.floodnet.nyc).
// The API has one endpoint for the sensor list and one per sensor for depth
// readings (about one per minute), so we poll every sensor on an interval and
// keep only its latest reading in memory.

import { fetchJson, mapLimit } from './http.js';

const API = 'https://api.floodnet.nyc/api/rest';
const LOOKBACK_MIN = 30;     // window of readings to ask each sensor for
const STALE_MIN = 60;        // a reading older than this means "unknown"
const DEAD_STATUSES = new Set(['retired', 'dead', 'removal_requested', 'needs_sensor']);

// Depth thresholds in millimeters. FloodNet's own dashboard treats a few mm as
// sensor noise; ~1 inch of water over a sidewalk or crosswalk is a real problem
// for someone walking.
export const WET_MM = 10;
export const FLOODED_MM = 25;

export function classifyDepth(depthMm) {
  if (depthMm == null) return 'unknown';
  if (depthMm >= FLOODED_MM) return 'flooded';
  if (depthMm >= WET_MM) return 'wet';
  return 'dry';
}

function isoNoMs(d) {
  return d.toISOString().slice(0, 19);
}

async function fetchLatestDepth(id, now) {
  const start = isoNoMs(new Date(now - LOOKBACK_MIN * 60_000));
  const end = isoNoMs(new Date(now));
  const url = `${API}/deployments/flood/${encodeURIComponent(id)}/depth?start_time=${start}&end_time=${end}`;
  try {
    const { depth_data: rows = [] } = await fetchJson(url, { timeoutMs: 15000 });
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].depth_proc_mm != null) return { depthMm: rows[i].depth_proc_mm, time: rows[i].time };
    }
    return { depthMm: null, time: null };
  } catch (err) {
    return { depthMm: null, time: null, error: err.message };
  }
}

export async function fetchSensors(now = Date.now()) {
  const { deployments } = await fetchJson(`${API}/deployments/flood`);
  const active = deployments.filter(
    (d) => !d.date_down && !DEAD_STATUSES.has(d.sensor_status) && d.location?.coordinates,
  );
  const readings = await mapLimit(active, 16, (d) => fetchLatestDepth(d.deployment_id, now));
  return active.map((d, i) => {
    const r = readings[i];
    const ageMin = r.time ? (now - Date.parse(r.time)) / 60_000 : null;
    const fresh = ageMin != null && ageMin <= STALE_MIN;
    const depthMm = fresh ? r.depthMm : null;
    const [lng, lat] = d.location.coordinates;
    return {
      id: d.deployment_id,
      name: d.name,
      lat,
      lng,
      depthMm,
      readingTime: r.time,
      status: classifyDepth(depthMm),
    };
  });
}

// Background poller so route requests never wait on ~400 sensor calls.
export class FloodNetCache {
  constructor({ refreshMs = 3 * 60_000, fetcher = fetchSensors } = {}) {
    this.refreshMs = refreshMs;
    this.fetcher = fetcher;
    this.sensors = [];
    this.updatedAt = null;
    this.error = null;
    this.inflight = null;
  }
  refresh() {
    if (!this.inflight) {
      this.inflight = this.fetcher()
        .then((s) => { this.sensors = s; this.updatedAt = new Date(); this.error = null; })
        .catch((err) => { this.error = err.message; console.error('FloodNet refresh failed:', err.message); })
        .finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }
  start() {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.refreshMs);
    this.timer.unref?.();
  }
  async get() {
    if (!this.updatedAt) await this.refresh();
    return { sensors: this.sensors, updatedAt: this.updatedAt, error: this.error };
  }
}
