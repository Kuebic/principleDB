import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createRateLimiter } from './rate-limit';

function testApp(options: Parameters<typeof createRateLimiter>[0]) {
  const app = new Hono();
  app.use('*', createRateLimiter(options));
  app.get('/ping', (c) => c.text('ok'));
  app.post('/mcp', (c) => c.text('ok'));
  return app;
}

describe('createRateLimiter — in-app per-IP token bucket (#49)', () => {
  it('returns 429 once a single IP exhausts its bucket capacity', async () => {
    let now = 0;
    const app = testApp({
      capacity: 3,
      refillPerMs: 0, // no refill during the test window
      now: () => now,
      extractKey: () => '1.1.1.1',
    });

    for (let i = 0; i < 3; i++) {
      const res = await app.request('/ping');
      expect(res.status).toBe(200);
    }
    const denied = await app.request('/ping');
    expect(denied.status).toBe(429);
  });

  it('refills tokens over time', async () => {
    let now = 0;
    const app = testApp({
      capacity: 2,
      refillPerMs: 2 / 1000, // 2 tokens per second
      now: () => now,
      extractKey: () => '2.2.2.2',
    });

    // Drain the bucket.
    expect((await app.request('/ping')).status).toBe(200);
    expect((await app.request('/ping')).status).toBe(200);
    expect((await app.request('/ping')).status).toBe(429);

    // Wait one second — 2 tokens refilled.
    now += 1000;
    expect((await app.request('/ping')).status).toBe(200);
    expect((await app.request('/ping')).status).toBe(200);
    expect((await app.request('/ping')).status).toBe(429);
  });

  it('counts different IPs against separate buckets', async () => {
    let now = 0;
    let currentIp = 'a';
    const app = testApp({
      capacity: 1,
      refillPerMs: 0,
      now: () => now,
      extractKey: () => currentIp,
    });

    expect((await app.request('/ping')).status).toBe(200);
    expect((await app.request('/ping')).status).toBe(429); // 'a' now empty
    currentIp = 'b';
    expect((await app.request('/ping')).status).toBe(200);
    expect((await app.request('/ping')).status).toBe(429); // 'b' now empty
    currentIp = 'a';
    expect((await app.request('/ping')).status).toBe(429); // 'a' still empty
  });

  it('rejects with HTTP 429 on POST /mcp too', async () => {
    let now = 0;
    const app = testApp({
      capacity: 1,
      refillPerMs: 0,
      now: () => now,
      extractKey: () => '3.3.3.3',
    });
    expect((await app.request('/mcp', { method: 'POST' })).status).toBe(200);
    const res = await app.request('/mcp', { method: 'POST' });
    expect(res.status).toBe(429);
  });
});

describe('createRateLimiter — IP extraction (production headers)', () => {
  it('prefers CF-Connecting-IP (Cloudflare) over other headers', async () => {
    let now = 0;
    const buckets = new Set<string>();
    const app = new Hono();
    app.use(
      '*',
      createRateLimiter({
        capacity: 1,
        refillPerMs: 0,
        now: () => now,
        extractKey: (c) => {
          const cf = c.req.header('cf-connecting-ip');
          const xff = c.req.header('x-forwarded-for');
          const key = cf ?? xff?.split(',')[0]?.trim() ?? 'unknown';
          buckets.add(key);
          return key;
        },
      }),
    );
    app.get('/ping', (c) => c.text('ok'));

    await app.request('/ping', {
      headers: {
        'cf-connecting-ip': '9.9.9.9',
        'x-forwarded-for': '4.4.4.4',
      },
    });
    expect(buckets.has('9.9.9.9')).toBe(true);
    expect(buckets.has('4.4.4.4')).toBe(false);
  });
});
