import { describe, expect, it } from 'vitest';
import { FakeIngestProvider } from '../canon/fake-provider';
import { ingestSource } from '../canon/ingest';
import { InMemoryRepository } from '../canon/in-memory-repository';
import type { SearchPrinciplesResponse } from '../mcp/search-principles-tool';
import type { Source } from '../canon/types';
import { createWebApp } from './app';

const sermon: Source = {
  id: 'serm1',
  title: 'Grace and obedience',
  author: 'Pastor X',
  kind: 'sermon',
  date: '2026-05-15',
  text: 'Grace precedes obedience. We are loved first.',
  r2Key: null,
  structureMap: { kind: 'none' },
};

function fixtureDeps(): {
  provider: FakeIngestProvider;
  repository: InMemoryRepository;
} {
  const provider = new FakeIngestProvider(() => [
    { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
  ]);
  const repository = new InMemoryRepository();
  return { provider, repository };
}

describe('GET /api/search (core-direct, ADR-0015)', () => {
  it('returns SearchHitResponse hits for a matching query — no MCP hop', async () => {
    const deps = fixtureDeps();
    await ingestSource(sermon, deps);
    const app = createWebApp(deps);

    const res = await app.request('/api/search?q=grace+and+obedience');
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchPrinciplesResponse;
    expect(body.hits).toHaveLength(1);
    const hit = body.hits[0]!;
    expect(hit.claim).toBe('Grace precedes obedience.');
    expect(hit.quote.text).toBe('Grace precedes obedience.');
    expect(hit.source.title).toBe('Grace and obedience');
    expect(hit.source.kind).toBe('sermon');
  });

  it('returns { hits: [] } when nothing matches — same shape as hits', async () => {
    const deps = {
      provider: new FakeIngestProvider(() => []),
      repository: new InMemoryRepository(),
    };
    const app = createWebApp(deps);
    const res = await app.request('/api/search?q=anything');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hits: [] });
  });

  it('honours the ?limit= parameter', async () => {
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
      { claim: 'Loved first.', quote: 'We are loved first.' },
    ]);
    const repository = new InMemoryRepository();
    await ingestSource(sermon, { provider, repository });
    const app = createWebApp({ provider, repository });

    const res = await app.request('/api/search?q=grace&limit=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchPrinciplesResponse;
    expect(body.hits).toHaveLength(1);
  });

  it('rejects missing `q` with 400', async () => {
    const app = createWebApp({
      provider: new FakeIngestProvider(() => []),
      repository: new InMemoryRepository(),
    });
    const res = await app.request('/api/search');
    expect(res.status).toBe(400);
  });

  it('rejects `limit=0` and `limit=51` with 400', async () => {
    const app = createWebApp({
      provider: new FakeIngestProvider(() => []),
      repository: new InMemoryRepository(),
    });
    expect((await app.request('/api/search?q=x&limit=0')).status).toBe(400);
    expect((await app.request('/api/search?q=x&limit=51')).status).toBe(400);
    expect((await app.request('/api/search?q=x&limit=abc')).status).toBe(400);
  });
});

describe('GET / — public Canon search page (Slice W2, #47)', () => {
  it('renders the search page with a form when no query is given', async () => {
    const deps = fixtureDeps();
    const app = createWebApp(deps);
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<meta name="robots" content="noindex"');
    expect(body).toMatch(/<form\b[^>]*>/i);
    expect(body).toMatch(/action=["']\/["']/i);
    expect(body).toMatch(/method=["']get["']/i);
  });

  it('renders answer-shaped hits when a query returns results', async () => {
    const deps = fixtureDeps();
    await ingestSource(sermon, deps);
    const app = createWebApp(deps);
    const res = await app.request('/?q=grace+and+obedience');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Grace precedes obedience.');
    expect(body).toContain('Grace and obedience');
    expect(body).toContain('Pastor X');
  });

  it('renders an empty-state message when the query returns no hits', async () => {
    const deps = fixtureDeps();
    const app = createWebApp(deps);
    const res = await app.request('/?q=nothing');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.toLowerCase()).toContain('no results');
  });
});

describe('GET /api/related — on-demand relatedness for the search page (#47)', () => {
  it('returns related hits for a known seed principle', async () => {
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
      { claim: 'Obedience flows from grace.', quote: 'We are loved first.' },
    ]);
    const repository = new InMemoryRepository();
    const deps = { provider, repository };
    await ingestSource(sermon, deps);
    const app = createWebApp(deps);
    const search = await app.request('/api/search?q=grace');
    const searchBody = (await search.json()) as SearchPrinciplesResponse;
    const seedId = searchBody.hits[0]!.principleId;
    const res = await app.request(`/api/related?principleId=${encodeURIComponent(seedId)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { related: Array<{ claim: string }> };
    expect(body.related.length).toBeGreaterThan(0);
    expect(body.related[0]!.claim).not.toBe(searchBody.hits[0]!.claim);
  });

  it('rejects a missing `principleId` with 400', async () => {
    const deps = fixtureDeps();
    const app = createWebApp(deps);
    const res = await app.request('/api/related');
    expect(res.status).toBe(400);
  });
});

describe('GET /quote/:quoteId — the Reader page (Slice W3, #48)', () => {
  it('renders the highlighted quote plus the full source when the id resolves', async () => {
    const deps = fixtureDeps();
    await ingestSource(sermon, deps);
    const app = createWebApp(deps);
    const search = await app.request('/api/search?q=grace');
    const body = (await search.json()) as SearchPrinciplesResponse;
    const quoteId = body.hits[0]!.quote.id;

    const res = await app.request(`/quote/${encodeURIComponent(quoteId)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<mark id="quote">Grace precedes obedience.</mark>');
    expect(html).toContain('Grace and obedience');
    expect(html).toContain('Pastor X');
    expect(html).toContain('<meta name="robots" content="noindex"');
  });

  it('returns 404 with a shaped page for an unknown Quote id', async () => {
    const deps = fixtureDeps();
    const app = createWebApp(deps);
    const res = await app.request('/quote/nope');
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html.toLowerCase()).toContain('not be found');
  });
});

describe('GET/DELETE /mcp — 405 in stateless mode', () => {
  it('GET /mcp returns 405', async () => {
    const app = createWebApp({
      provider: new FakeIngestProvider(() => []),
      repository: new InMemoryRepository(),
    });
    const res = await app.request('/mcp');
    expect(res.status).toBe(405);
  });

  it('DELETE /mcp returns 405', async () => {
    const app = createWebApp({
      provider: new FakeIngestProvider(() => []),
      repository: new InMemoryRepository(),
    });
    const res = await app.request('/mcp', { method: 'DELETE' });
    expect(res.status).toBe(405);
  });
});

describe('POST /mcp — Origin validation (opt-in)', () => {
  it('rejects a disallowed Origin with 403 when allowedOrigins is set', async () => {
    const app = createWebApp(
      {
        provider: new FakeIngestProvider(() => []),
        repository: new InMemoryRepository(),
      },
      { allowedOrigins: ['https://principledb.example'] },
    );
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).toBe(403);
  });

  it('allows a missing Origin (server-to-server) even when allowedOrigins is set', async () => {
    const app = createWebApp(
      {
        provider: new FakeIngestProvider(() => []),
        repository: new InMemoryRepository(),
      },
      { allowedOrigins: ['https://principledb.example'] },
    );
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          clientInfo: { name: 'test', version: '0.0.0' },
          capabilities: {},
        },
      }),
    });
    expect(res.status).not.toBe(403);
  });
});
