// Small in-memory guards for running on the public internet: a per-client
// rate limit and a short-lived cache that also merges identical requests in
// flight. Both are per process; run one process or put a shared limiter in
// front if you scale out.

// Fixed-window limit: at most `max` hits per `windowMs` for each key.
export class RateLimiter {
  constructor({ max, windowMs }) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map(); // key -> { start, count }
  }
  // Returns 0 if allowed, otherwise seconds until the window resets.
  check(key, now = Date.now()) {
    let h = this.hits.get(key);
    if (!h || now - h.start >= this.windowMs) {
      if (this.hits.size > 10_000) this.sweep(now);
      h = { start: now, count: 0 };
      this.hits.set(key, h);
    }
    if (++h.count <= this.max) return 0;
    return Math.ceil((h.start + this.windowMs - now) / 1000);
  }
  sweep(now) {
    for (const [k, h] of this.hits) if (now - h.start >= this.windowMs) this.hits.delete(k);
  }
}

export class TtlCache {
  constructor({ ttlMs, maxEntries = 500 }) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map(); // key -> { at, promise }
  }
  get(key, compute, now = Date.now()) {
    const e = this.entries.get(key);
    if (e && now - e.at < this.ttlMs) return e.promise;
    if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    const promise = compute().catch((err) => { this.entries.delete(key); throw err; });
    this.entries.set(key, { at: now, promise });
    return promise;
  }
}
