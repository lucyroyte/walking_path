import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, TtlCache } from '../src/limits.js';

test('rate limiter allows max hits per window, then resets', () => {
  const rl = new RateLimiter({ max: 2, windowMs: 60_000 });
  assert.equal(rl.check('a', 0), 0);
  assert.equal(rl.check('a', 1), 0);
  assert.equal(rl.check('a', 2), 60);
  assert.equal(rl.check('b', 2), 0);
  assert.equal(rl.check('a', 60_000), 0);
});

test('ttl cache merges calls, expires, and forgets failures', async () => {
  const c = new TtlCache({ ttlMs: 1000 });
  let calls = 0;
  const f = async () => ++calls;
  assert.equal(await c.get('k', f, 0), 1);
  assert.equal(await c.get('k', f, 500), 1);
  assert.equal(await c.get('k', f, 1500), 2);
  await assert.rejects(c.get('bad', async () => { throw new Error('x'); }, 0));
  assert.equal(await c.get('bad', f, 1), 3);
});
