import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversine, decodePolyline, samplePath, distanceToPath, GridIndex, pathLength } from '../src/geo.js';

test('haversine: one block of Manhattan avenue (~80 m)', () => {
  const d = haversine([40.7265, -73.9815], [40.7272, -73.9810]);
  assert.ok(d > 80 && d < 95, `got ${d}`);
});

test('decodePolyline matches Google reference example', () => {
  assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), [
    [38.5, -120.2], [40.7, -120.95], [43.252, -126.453],
  ]);
});

test('samplePath spaces points evenly and keeps endpoints', () => {
  const path = [[40.7, -74.0], [40.701, -74.0]]; // ~111 m
  const pts = samplePath(path, 10);
  assert.deepEqual(pts[0], path[0]);
  assert.deepEqual(pts.at(-1), path[1]);
  assert.ok(pts.length >= 12 && pts.length <= 13);
  assert.ok(Math.abs(pathLength(pts) - pathLength(path)) < 0.5);
});

test('distanceToPath measures to the segment, not just vertices', () => {
  const path = [[40.7, -74.0], [40.71, -74.0]];
  const d = distanceToPath([40.705, -73.9995], path); // ~42 m east of the midpoint
  assert.ok(d > 38 && d < 46, `got ${d}`);
});

test('GridIndex.near finds only points within radius', () => {
  const idx = new GridIndex(25);
  idx.insert([40.7, -74.0], 'a');
  idx.insert([40.7003, -74.0], 'b'); // ~33 m north
  idx.insert([40.701, -74.0], 'c');  // ~111 m north
  const found = [...idx.near([40.7, -74.0], 40)].map((e) => e.item).sort();
  assert.deepEqual(found, ['a', 'b']);
});
