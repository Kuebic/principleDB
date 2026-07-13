import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createRequestLogger, type RequestLogEntry } from './request-logger';

function testApp(sink: RequestLogEntry[]) {
  const app = new Hono();
  app.use(
    '*',
    createRequestLogger({ log: (entry) => sink.push(entry) }),
  );
  app.get('/ping', (c) => c.text('ok'));
  app.post('/mcp', (c) => c.text('ok'));
  return app;
}

describe('createRequestLogger — per-request IP + UA logging (#49)', () => {
  it('logs one entry per request with method, path, status, ip, ua', async () => {
    const sink: RequestLogEntry[] = [];
    const app = testApp(sink);

    await app.request('/ping', {
      headers: {
        'cf-connecting-ip': '9.9.9.9',
        'user-agent': 'Mozilla/5.0 test',
      },
    });

    expect(sink).toHaveLength(1);
    const entry = sink[0]!;
    expect(entry.method).toBe('GET');
    expect(entry.path).toBe('/ping');
    expect(entry.status).toBe(200);
    expect(entry.ip).toBe('9.9.9.9');
    expect(entry.userAgent).toBe('Mozilla/5.0 test');
  });

  it('captures user-agent as "-" when missing so logs align', async () => {
    const sink: RequestLogEntry[] = [];
    const app = testApp(sink);

    await app.request('/ping');
    expect(sink[0]!.userAgent).toBe('-');
  });

  it('falls back to x-forwarded-for when cf-connecting-ip is absent', async () => {
    const sink: RequestLogEntry[] = [];
    const app = testApp(sink);

    await app.request('/ping', {
      headers: { 'x-forwarded-for': '4.4.4.4, 8.8.8.8' },
    });
    expect(sink[0]!.ip).toBe('4.4.4.4');
  });

  it('logs POST /mcp requests as well', async () => {
    const sink: RequestLogEntry[] = [];
    const app = testApp(sink);

    await app.request('/mcp', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '5.5.5.5', 'user-agent': 'mcp-client' },
    });
    expect(sink).toHaveLength(1);
    expect(sink[0]!.method).toBe('POST');
    expect(sink[0]!.path).toBe('/mcp');
    expect(sink[0]!.ip).toBe('5.5.5.5');
    expect(sink[0]!.userAgent).toBe('mcp-client');
  });
});
