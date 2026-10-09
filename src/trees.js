// Street trees from NYC Parks Forestry Tree Points (NYC Open Data hn5i-inap),
// the continuously updated successor to the 2015 street tree census.
// Trees are fetched lazily in fixed lat/lng tiles and cached in memory and on
// disk, since the tree inventory changes slowly.

import { fetchJson, mapLimit } from './http.js';
import { GridIndex } from './geo.js';
import { env, IN_NODE } from './env.js';

const DATASET = 'https://data.cityofnewyork.us/resource/hn5i-inap.json';
const TILE_DEG = 0.01; // ~1.1 km north-south, ~0.85 km east-west in NYC
const CACHE_TTL_MS = 7 * 24 * 3600_000;

// Rough crown radius (m) from trunk diameter at breast height (inches).
// Urban street-tree allometry is roughly linear in DBH; this keeps young
// trees at ~1.5 m and caps mature London planes/oaks around 9 m.
export function crownRadius(dbhInches) {
  const dbh = Number(dbhInches) || 0;
  return Math.min(9, Math.max(1.5, 1 + 0.27 * dbh));
}

function tileKey(i, j) { return `${i}_${j}`; }

export class TreeStore {
  // The disk cache is only used in Node; in the browser tiles stay in memory.
  constructor({ cacheDir = IN_NODE ? '.cache/trees' : null, appToken = env.SOCRATA_APP_TOKEN } = {}) {
    this.cacheDir = cacheDir;
    this.appToken = appToken;
    this.tiles = new Map(); // key -> Promise<Array<{lat,lng,r}>>
  }

  async fetchTile(i, j) {
    let fs, file;
    if (this.cacheDir) {
      fs = await import('node:fs/promises');
      file = `${this.cacheDir}/${tileKey(i, j)}.json`;
      try {
        const stat = await fs.stat(file);
        if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) return JSON.parse(await fs.readFile(file, 'utf8'));
      } catch { /* not cached yet */ }
    }

    const south = i * TILE_DEG, west = j * TILE_DEG;
    const north = south + TILE_DEG, east = west + TILE_DEG;
    const where = `tpstructure='Full' AND within_box(location,${north},${west},${south},${east})`;
    const params = new URLSearchParams({ $select: 'dbh,location', $where: where, $limit: '50000' });
    const headers = this.appToken ? { 'X-App-Token': this.appToken } : {};
    const rows = await fetchJson(`${DATASET}?${params}`, { timeoutMs: 60000, headers });
    const trees = rows
      .filter((r) => r.location?.coordinates)
      .map((r) => ({ lat: r.location.coordinates[1], lng: r.location.coordinates[0], r: +crownRadius(r.dbh).toFixed(1) }));

    if (fs) {
      await fs.mkdir(this.cacheDir, { recursive: true });
      await fs.writeFile(file, JSON.stringify(trees));
    }
    return trees;
  }

  tile(i, j) {
    const k = tileKey(i, j);
    if (!this.tiles.has(k)) {
      const p = this.fetchTile(i, j).catch((err) => { this.tiles.delete(k); throw err; });
      this.tiles.set(k, p);
    }
    return this.tiles.get(k);
  }

  // Every tree inside the bounding box, fetching at most `maxTiles` tiles.
  async treesIn({ minLat, minLng, maxLat, maxLng }, maxTiles = 120) {
    const keys = [];
    for (let i = Math.floor(minLat / TILE_DEG); i <= Math.floor(maxLat / TILE_DEG); i++) {
      for (let j = Math.floor(minLng / TILE_DEG); j <= Math.floor(maxLng / TILE_DEG); j++) keys.push([i, j]);
    }
    if (keys.length > maxTiles) throw Object.assign(new Error('Area too large for a tree lookup; zoom in.'), { status: 400 });
    const tiles = await mapLimit(keys, 6, ([i, j]) => this.tile(i, j));
    return tiles.flat().filter((t) => t.lat >= minLat && t.lat <= maxLat && t.lng >= minLng && t.lng <= maxLng);
  }

  // Grid index of every tree inside the bounding box.
  async indexFor(box) {
    const index = new GridIndex(25);
    for (const t of await this.treesIn(box)) index.insert([t.lat, t.lng], t);
    return index;
  }
}
