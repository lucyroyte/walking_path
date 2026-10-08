import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRoutes, floodHits } from '../src/scoring.js';
import { GridIndex } from '../src/geo.js';
import { classifyDepth } from '../src/floodnet.js';
import { crownRadius } from '../src/trees.js';
import { heatWeight, heatIndexF } from '../src/weather.js';

// Two parallel north-south routes ~170 m apart.
const west = { path: [[40.70, -74.002], [40.71, -74.002]], distanceM: 1112, durationS: 800 };
const east = { path: [[40.70, -74.000], [40.71, -74.000]], distanceM: 1112, durationS: 840 };
const sensor = (status, lat, lng, depthMm = null) => ({ id: status, name: status, lat, lng, status, depthMm });

function shadeAlong(route, every = 0.0001) {
  const idx = new GridIndex(25);
  const [[lat0, lng], [lat1]] = route.path;
  for (let lat = lat0; lat <= lat1; lat += every) idx.insert([lat, lng + 0.00003], { lat, lng, r: 6 });
  return idx;
}

test('classifyDepth thresholds', () => {
  assert.equal(classifyDepth(null), 'unknown');
  assert.equal(classifyDepth(0), 'dry');
  assert.equal(classifyDepth(12), 'wet');
  assert.equal(classifyDepth(25), 'flooded');
});

test('floodHits only counts sensors next to the route', () => {
  const hits = floodHits(west.path, [sensor('flooded', 40.705, -74.002, 80), sensor('flooded', 40.705, -74.000, 80)]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].distanceM, 0);
});

test('a flooded route loses to a slower dry one', () => {
  const sensors = [sensor('flooded', 40.705, -74.002, 60)];
  const [best, worst] = scoreRoutes([west, east], { sensors });
  assert.equal(best.path, east.path);
  assert.equal(best.floodStatus, 'clear');
  assert.deepEqual(best.labels, ['recommended']);
  assert.equal(worst.floodStatus, 'flooded');
  assert.ok(worst.labels.includes('fastest'));
});

test('mild day: fastest wins even if the other is shadier', () => {
  const [best] = scoreRoutes([west, east], { sensors: [], treeIndex: shadeAlong(east), heatWeight: 0 });
  assert.equal(best.path, west.path);
});

test('hot day: shady route wins over a slightly faster sunny one', () => {
  const ranked = scoreRoutes([west, east], { sensors: [], treeIndex: shadeAlong(east), heatWeight: 1 });
  assert.equal(ranked[0].path, east.path);
  assert.ok(ranked[0].shadePct > 90);
  assert.equal(ranked[1].shadePct, 0);
  assert.ok(ranked[0].labels.includes('shadiest'));
});

test('crownRadius is bounded', () => {
  assert.equal(crownRadius(0), 1.5);
  assert.equal(crownRadius(100), 9);
  assert.ok(crownRadius(12) > 3 && crownRadius(12) < 5);
});

test('heat weighting', () => {
  assert.equal(heatWeight(null), 0);
  assert.equal(heatWeight(70), 0);
  assert.equal(heatWeight(82.5), 0.5);
  assert.equal(heatWeight(100), 1);
  assert.ok(Math.abs(heatIndexF(90, 60) - 100) < 2); // NWS table: 90°F/60% ≈ 100°F
});
