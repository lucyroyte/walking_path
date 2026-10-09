import { IN_NODE } from './env.js';

// Browsers send their own User-Agent, and a custom one would force a CORS preflight.
const BASE_HEADERS = IN_NODE
  ? { 'User-Agent': 'walking-path (https://github.com/lucyroyte/walking_path)', Accept: 'application/json' }
  : { Accept: 'application/json' };

export async function fetchJson(url, { timeoutMs = 20000, headers = {}, ...init } = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { ...BASE_HEADERS, ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} from ${new URL(url).host}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// Run `fn` over `items` with at most `limit` in flight.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
