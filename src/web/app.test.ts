import { describe, expect, it } from 'vitest';
import { FakeIngestProvider } from '../canon/fake-provider';
import { ingestSource } from '../canon/ingest';
import { InMemoryRepository } from '../canon/in-memory-repository';
import type { SearchPrinciplesResponse } from '../mcp/search-principles-tool';
import type { Edition, Source } from '../canon/types';
import { createWebApp } from './app';

function mkEdition(id: string, workId: string, label = id): Edition {
  return {
    id,
    workId,
    label,
    recension: 'ffwpu-post-2012',
    language: 'en',
    publishedDate: null,
    publisher: null,
    notes: null,
  };
}

const sermon: Source = {
  id: 'serm1',
  title: 'Grace and obedience',
  author: 'Pastor X',
  kind: 'sermon',
  date: '2026-05-15',
  text: 'Grace precedes obedience. We are loved first.',
  r2Key: null,
  structureMap: { kind: 'none' },
  editionId: 'ed_seed',
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

describe('GET / — URL-param scope for Work/Figure filtering (Slice W57, ADR-0017)', () => {
  // A miniature scoped Canon: two core Works under different Figures + one
  // opt-in extra Work — mirrors the ADR-0017 split so repeated ?work=/?figure=
  // params can be exercised end-to-end through the route.
  async function seedScopedApp(): Promise<{
    deps: ReturnType<typeof fixtureDeps>;
    app: ReturnType<typeof createWebApp>;
  }> {
    const provider = new FakeIngestProvider((input) => [
      { claim: `Teaching from ${input.title}.`, quote: input.text.trim() },
    ]);
    const repository = new InMemoryRepository();
    const deps = { provider, repository };

    await repository.upsertFigure({ id: 'fig_smm', slug: 'sun-myung-moon', displayName: 'Sun Myung Moon' });
    await repository.upsertFigure({ id: 'fig_hjh', slug: 'hak-ja-han', displayName: 'Hak Ja Han' });
    await repository.upsertWork({ id: 'work_csg', title: 'Cheon Seong Gyeong', figureId: 'fig_smm', tier: 'core' });
    await repository.upsertWork({ id: 'work_tm', title: 'True Mother Anthology', figureId: 'fig_hjh', tier: 'core' });
    await repository.upsertWork({ id: 'work_extra', title: 'Later Speeches', figureId: 'fig_hjh', tier: 'extra' });
    await repository.upsertEdition(mkEdition('ed_csg', 'work_csg'));
    await repository.upsertEdition(mkEdition('ed_tm', 'work_tm'));
    await repository.upsertEdition(mkEdition('ed_extra', 'work_extra'));

    const mkSource = (id: string, editionId: string, label: string): Source => ({
      id,
      title: `${label} chapter`,
      author: 'ingest-slug-should-not-surface',
      kind: 'book',
      date: '2026-01-01',
      text: `Grace shines through ${label}.`,
      r2Key: null,
      structureMap: { kind: 'none' },
      editionId,
    });
    await ingestSource(mkSource('s_csg', 'ed_csg', 'CSG'), deps);
    await ingestSource(mkSource('s_tm', 'ed_tm', 'TM Anthology'), deps);
    await ingestSource(mkSource('s_extra', 'ed_extra', 'Later Speeches'), deps);

    const app = createWebApp(deps);
    return { deps, app };
  }

  it('no work= / figure= params → all core Works (extras excluded) — the dynamic default', async () => {
    const { app } = await seedScopedApp();
    const res = await app.request('/?q=grace+shines');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('CSG chapter');
    expect(body).toContain('TM Anthology chapter');
    expect(body).not.toContain('Later Speeches chapter');
  });

  it('repeated work= params scope the search to just those Works', async () => {
    const { app } = await seedScopedApp();
    const res = await app.request('/?q=grace+shines&work=work_csg');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('CSG chapter');
    expect(body).not.toContain('TM Anthology chapter');
    expect(body).not.toContain('Later Speeches chapter');
  });

  it('figure= expands to every Work under that Figure (including extras of that Figure)', async () => {
    const { app } = await seedScopedApp();
    const res = await app.request('/?q=grace+shines&figure=fig_hjh');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('CSG chapter');
    expect(body).toContain('TM Anthology chapter');
    expect(body).toContain('Later Speeches chapter');
  });

  it('naming an extra Work explicitly opts it in', async () => {
    const { app } = await seedScopedApp();
    const res = await app.request('/?q=grace+shines&work=work_extra');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Later Speeches chapter');
    expect(body).not.toContain('CSG chapter');
    expect(body).not.toContain('TM Anthology chapter');
  });

  it('renders the picker on the landing page (no query) so members see what is searchable', async () => {
    const { app } = await seedScopedApp();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.text();
    // The Figure display names appear in the picker.
    expect(body).toContain('Sun Myung Moon');
    expect(body).toContain('Hak Ja Han');
    // Work titles appear in the picker.
    expect(body).toContain('Cheon Seong Gyeong');
    expect(body).toContain('True Mother Anthology');
    expect(body).toContain('Later Speeches');
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

describe('GET /api/quotes — extra Sources per Principle (Slice T2, #65, PRD #63)', () => {
  // Seed a Principle attested by MANY Sources so paging is meaningful: the
  // host Source distils the claim; each companion re-states it and dedup
  // attaches the companion's Quote to the same Principle. Extras = quotes[1..].
  async function seedMultiQuotePrinciple(extras: number): Promise<{
    app: ReturnType<typeof createWebApp>;
    principleId: string;
  }> {
    const provider = new FakeIngestProvider(
      (input) => [{ claim: 'Grace precedes obedience.', quote: input.text.trim() }],
      undefined,
      undefined,
      () => ({ same: true, rationale: 'test — treat as identical' }),
    );
    const repository = new InMemoryRepository();
    const deps = { provider, repository };

    const host: Source = {
      id: 'host',
      title: 'Host sermon',
      author: 'Pastor Host',
      kind: 'sermon',
      date: '2026-05-15',
      text: 'Grace precedes obedience.',
      r2Key: null,
      structureMap: { kind: 'none' },
      editionId: 'ed_seed',
    };
    await ingestSource(host, deps);

    for (let i = 0; i < extras; i++) {
      const companion: Source = {
        id: `extra${i}`,
        title: `Extra sermon ${i}`,
        author: `Pastor E${i}`,
        kind: 'sermon',
        date: '2026-06-01',
        text: `Grace precedes obedience ${i}.`,
        r2Key: null,
        structureMap: { kind: 'none' },
        editionId: 'ed_seed',
      };
      await ingestSource(companion, deps);
    }

    const app = createWebApp(deps);
    const search = await app.request('/api/search?q=grace');
    const searchBody = (await search.json()) as SearchPrinciplesResponse;
    const principleId = searchBody.hits[0]!.principleId;
    return { app, principleId };
  }

  it('offset=0 returns the first 3 extras (skipping the lead) and hasMore when more remain', async () => {
    const { app, principleId } = await seedMultiQuotePrinciple(5);
    const res = await app.request(`/api/quotes?principleId=${encodeURIComponent(principleId)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      quotes: Array<{ id: string; text: string; label: string; source: { title: string } }>;
      hasMore: boolean;
    };
    expect(body.quotes).toHaveLength(3);
    expect(body.hasMore).toBe(true);
    // Extras only — the host Quote (lead) is not in this batch.
    for (const q of body.quotes) {
      expect(q.source.title).not.toBe('Host sermon');
    }
    // Each quote carries snapped text + a derived label (structure=none → "~% in").
    for (const q of body.quotes) {
      expect(q.text.length).toBeGreaterThan(0);
      expect(q.label).toMatch(/% in$/);
    }
  });

  it('paging by offset returns disjoint, ordered batches and the final page reports hasMore=false', async () => {
    const { app, principleId } = await seedMultiQuotePrinciple(5);
    const page1 = (await (await app.request(
      `/api/quotes?principleId=${encodeURIComponent(principleId)}&offset=0`,
    )).json()) as { quotes: Array<{ id: string }>; hasMore: boolean };
    const page2 = (await (await app.request(
      `/api/quotes?principleId=${encodeURIComponent(principleId)}&offset=3`,
    )).json()) as { quotes: Array<{ id: string }>; hasMore: boolean };
    expect(page1.quotes).toHaveLength(3);
    expect(page1.hasMore).toBe(true);
    expect(page2.quotes).toHaveLength(2);
    expect(page2.hasMore).toBe(false);
    const seen = new Set(page1.quotes.map((q) => q.id));
    for (const q of page2.quotes) expect(seen.has(q.id)).toBe(false);
  });

  it('each enriched quote carries Work + Figure + Edition attribution when the Source is assigned', async () => {
    const provider = new FakeIngestProvider(
      (input) => [{ claim: 'Grace precedes obedience.', quote: input.text.trim() }],
      undefined,
      undefined,
      () => ({ same: true, rationale: 'test — treat as identical' }),
    );
    const repository = new InMemoryRepository();
    const deps = { provider, repository };
    await repository.upsertFigure({ id: 'fig_smm', slug: 'sun-myung-moon', displayName: 'Sun Myung Moon' });
    await repository.upsertWork({ id: 'work_csg', title: 'Cheon Seong Gyeong', figureId: 'fig_smm', tier: 'core' });
    await repository.upsertEdition(mkEdition('ed_csg', 'work_csg', '2013 Revised'));
    await ingestSource(
      {
        id: 'host',
        title: 'Host chapter',
        author: 'ingest-slug',
        kind: 'book',
        date: '2026-01-01',
        text: 'Grace precedes obedience.',
        r2Key: null,
        structureMap: { kind: 'none' },
        editionId: 'ed_csg',
      },
      deps,
    );
    await ingestSource(
      {
        id: 'extra0',
        title: 'Extra chapter',
        author: 'ingest-slug',
        kind: 'book',
        date: '2026-02-01',
        text: 'Grace precedes obedience too.',
        r2Key: null,
        structureMap: { kind: 'none' },
        editionId: 'ed_csg',
      },
      deps,
    );
    const app = createWebApp(deps);
    const search = await app.request('/api/search?q=grace');
    const searchBody = (await search.json()) as SearchPrinciplesResponse;
    const principleId = searchBody.hits[0]!.principleId;
    const res = await app.request(
      `/api/quotes?principleId=${encodeURIComponent(principleId)}`,
    );
    const body = (await res.json()) as {
      quotes: Array<{
        source: {
          work: { title: string } | null;
          figure: { displayName: string } | null;
          edition: { label: string } | null;
        };
      }>;
    };
    expect(body.quotes).toHaveLength(1);
    expect(body.quotes[0]!.source.work).toEqual({ title: 'Cheon Seong Gyeong' });
    expect(body.quotes[0]!.source.figure).toEqual({ displayName: 'Sun Myung Moon' });
    // #62: revealed extras carry the Edition label too — the "N more sources"
    // reveal must not drop the recension when the lead card has it.
    expect(body.quotes[0]!.source.edition).toEqual({ label: '2013 Revised' });
  });

  it('rejects a missing or blank `principleId` with 400', async () => {
    const deps = fixtureDeps();
    const app = createWebApp(deps);
    expect((await app.request('/api/quotes')).status).toBe(400);
    expect((await app.request('/api/quotes?principleId=')).status).toBe(400);
    expect((await app.request('/api/quotes?principleId=%20')).status).toBe(400);
  });

  it('unknown `principleId` yields an empty result (not an error)', async () => {
    const deps = fixtureDeps();
    const app = createWebApp(deps);
    const res = await app.request('/api/quotes?principleId=nope');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ quotes: [], hasMore: false });
  });

  it('rejects a negative `offset` with 400', async () => {
    const deps = fixtureDeps();
    const app = createWebApp(deps);
    const res = await app.request('/api/quotes?principleId=p&offset=-1');
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

describe('GET /connect — "connect your AI" page (Slice W5, #50)', () => {
  it('renders a noindex page with the request-derived /mcp URL', async () => {
    const deps = fixtureDeps();
    const app = createWebApp(deps);
    const res = await app.request('http://principledb.example.com/connect');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<meta name="robots" content="noindex"');
    expect(body).toContain('http://principledb.example.com/mcp');
  });

  it('honours X-Forwarded-Proto/Host so the printed URL is the public one', async () => {
    const deps = fixtureDeps();
    const app = createWebApp(deps);
    const res = await app.request('http://internal.local/connect', {
      headers: {
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'principledb.example.com',
      },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('https://principledb.example.com/mcp');
    expect(body).not.toContain('http://internal.local/mcp');
  });

  it('names each supported client on the page', async () => {
    const deps = fixtureDeps();
    const app = createWebApp(deps);
    const res = await app.request('http://principledb.example.com/connect');
    const body = await res.text();
    expect(body).toMatch(/claude\.ai/i);
    expect(body).toMatch(/claude code/i);
    expect(body).toMatch(/chatgpt/i);
    expect(body).toMatch(/cursor/i);
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

describe('Rate limiting — /api/search + /mcp return 429 on exceed (Slice W4, #49)', () => {
  it('exceeding capacity on /api/search returns HTTP 429', async () => {
    const deps = fixtureDeps();
    const app = createWebApp(deps, {
      rateLimit: {
        capacity: 2,
        refillPerMs: 0,
        now: () => 0,
        extractKey: () => 'test-ip',
      },
    });
    expect((await app.request('/api/search?q=x')).status).toBe(200);
    expect((await app.request('/api/search?q=x')).status).toBe(200);
    const denied = await app.request('/api/search?q=x');
    expect(denied.status).toBe(429);
  });

  it('exceeding capacity on POST /mcp returns HTTP 429', async () => {
    const deps = fixtureDeps();
    const app = createWebApp(deps, {
      rateLimit: {
        capacity: 1,
        refillPerMs: 0,
        now: () => 0,
        extractKey: () => 'test-ip',
      },
    });
    const first = await app.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          clientInfo: { name: 't', version: '0' },
          capabilities: {},
        },
      }),
    });
    expect(first.status).not.toBe(429);
    const second = await app.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    });
    expect(second.status).toBe(429);
  });
});

describe('Request logging — IP + UA per request (Slice W4, #49)', () => {
  it('emits one log entry per request with IP and user-agent', async () => {
    const deps = fixtureDeps();
    const entries: Array<{ ip: string; userAgent: string; path: string; status: number }> = [];
    const app = createWebApp(deps, {
      requestLog: {
        log: (entry) => entries.push(entry),
      },
    });

    await app.request('/api/search?q=grace', {
      headers: {
        'cf-connecting-ip': '10.0.0.1',
        'user-agent': 'w4-test/0.1',
      },
    });

    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry!.path).toBe('/api/search');
    expect(entry!.status).toBe(200);
    expect(entry!.ip).toBe('10.0.0.1');
    expect(entry!.userAgent).toBe('w4-test/0.1');
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
