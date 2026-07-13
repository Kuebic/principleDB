// In-app per-IP token-bucket rate limiter (issue #49, ADR-0016).
//
// Defense-in-depth behind Cloudflare's edge rate rules (deploy config, W6):
// even if a caller gets past the edge, this backstop caps request rate per IP
// on the Node process itself. 429 on exceed. In-memory, so buckets scale with
// a single process — the intended deploy shape is exactly one long-lived
// process behind Cloudflare (ADR-0016), so distributing the bucket store is
// out of scope.
//
// Bucket state is a Map<key, {tokens, last}>; each request refills up to
// capacity based on elapsed time, then subtracts one token or 429s. IP
// extraction (CF-Connecting-IP → X-Forwarded-For → 'unknown') is factored out
// so tests can inject a deterministic key.

import type { Context, MiddlewareHandler } from 'hono';

export interface RateLimitOptions {
  // Maximum burst size — the number of tokens a bucket holds at rest.
  capacity: number;
  // Refill rate, in tokens per millisecond. `capacity / windowMs` for a
  // classic "N requests per window" shape; 0 disables refill (test-only).
  refillPerMs: number;
  // Time source, in ms. Defaults to Date.now.
  now?: () => number;
  // Key extractor. Defaults to the standard IP-header chain — override in
  // tests to force a specific bucket.
  extractKey?: (c: Context) => string;
}

interface Bucket {
  tokens: number;
  last: number;
}

export function extractClientIp(c: Context): string {
  // Cloudflare sets CF-Connecting-IP unconditionally when the request comes
  // through the edge (ADR-0016 places Cloudflare in front of the origin).
  // On a direct hit or a non-CF proxy, fall back to the leftmost entry of
  // X-Forwarded-For (the original client per the reverse-proxy convention),
  // then to a fixed sentinel so all directly-connected callers share a
  // single bucket rather than being silently unlimited.
  const cf = c.req.header('cf-connecting-ip');
  if (cf && cf.length > 0) return cf;
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first && first.length > 0) return first;
  }
  const real = c.req.header('x-real-ip');
  if (real && real.length > 0) return real;
  return 'unknown';
}

export function createRateLimiter(options: RateLimitOptions): MiddlewareHandler {
  const { capacity, refillPerMs } = options;
  const now = options.now ?? Date.now;
  const extractKey = options.extractKey ?? extractClientIp;
  const buckets = new Map<string, Bucket>();

  return async (c, next) => {
    const key = extractKey(c);
    const t = now();
    const bucket = buckets.get(key) ?? { tokens: capacity, last: t };
    const elapsed = t - bucket.last;
    if (elapsed > 0 && refillPerMs > 0) {
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
    }
    bucket.last = t;
    buckets.set(key, bucket);
    if (bucket.tokens < 1) {
      return c.json({ error: 'Too many requests' }, 429);
    }
    bucket.tokens -= 1;
    await next();
  };
}
