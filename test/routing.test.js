import { test } from 'node:test';
import assert from 'node:assert/strict';
import { viaPoints, isDuplicate } from '../src/routing.js';
import { haversine } from '../src/geo.js';

test('viaPoints sit on both sides of the trip, within range', () => {
  const from = [40.70, -74.0], to = [40.72, -74.0];
  const vias = viaPoints(from, to);
  assert.equal(vias.length, 8);
  assert.ok(vias.some((v) => v[1] > -74.0) && vias.some((v) => v[1] < -74.0));
  for (const v of vias) assert.ok(haversine(v, from) < haversine(from, to) + 800);
});

test('isDuplicate', () => {
  const a = { path: [[40.70, -74.0], [40.71, -74.0]] };
  const b = { path: [[40.70, -74.00005], [40.71, -74.00005]] }; // ~4 m away
  const c = { path: [[40.70, -73.998], [40.71, -73.998]] };     // ~170 m away
  assert.equal(isDuplicate(a, b), true);
  assert.equal(isDuplicate(a, c), false);
});
