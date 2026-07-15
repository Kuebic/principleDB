import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { FakeIngestProvider } from '../canon/fake-provider';
import { ingestSource } from '../canon/ingest';
import { InMemoryRepository } from '../canon/in-memory-repository';
import type { Source } from '../canon/types';
import type { GetQuoteInContextResponse } from './get-quote-in-context-tool';
import type { ReviewQueueListing } from './list-review-queue-tool';
import type { RelatedPrinciplesResponse } from './related-principles-tool';
import type { ListWorksResponse } from './list-works-tool';
import type { ReviewResolution } from './resolve-review-item-tool';
import type { SearchPrinciplesResponse } from './search-principles-tool';
import { createPrincipleDbServer } from './server';

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

async function wireClient(
  deps: {
    provider: FakeIngestProvider;
    repository: InMemoryRepository;
  },
  options?: { readOnly?: boolean },
): Promise<Client> {
  const server = createPrincipleDbServer(deps, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('MCP server wiring (search_principles over JSON-RPC)', () => {
  it('advertises search_principles in tools/list', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => []);
    const client = await wireClient({ provider, repository });
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'search_principles');
    expect(tool).toBeDefined();
    expect(tool!.description).toMatch(/principle/i);
    expect(tool!.inputSchema.type).toBe('object');
    expect((tool!.inputSchema.properties as Record<string, unknown>).query).toBeDefined();
    await client.close();
  });

  it("tools/call returns the source's own words at the snapped span (golden test)", async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
    ]);
    await ingestSource(sermon, { provider, repository });
    const client = await wireClient({ provider, repository });

    const result = await client.callTool({
      name: 'search_principles',
      arguments: { query: 'grace and obedience' },
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as unknown as SearchPrinciplesResponse;
    expect(structured.hits).toHaveLength(1);
    const hit = structured.hits[0]!;
    expect(hit.principleId).toMatch(/^serm1#[0-9a-f]{8}#p0$/);
    expect(hit.claim).toBe('Grace precedes obedience.');
    expect(hit.quote.text).toBe('Grace precedes obedience.');
    expect(hit.source.title).toBe('Grace and obedience');
    expect(hit.source.kind).toBe('sermon');
    await client.close();
  });

  it('returns a well-shaped empty case ({ hits: [] }) when nothing matches', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => []);
    const client = await wireClient({ provider, repository });
    const result = await client.callTool({
      name: 'search_principles',
      arguments: { query: 'anything' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ hits: [] });
    await client.close();
  });

  it('rejects a malformed call (missing query) with isError, not a crash', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => []);
    const client = await wireClient({ provider, repository });
    const result = await client.callTool({
      name: 'search_principles',
      arguments: {},
    });
    expect(result.isError).toBe(true);
    await client.close();
  });
});

describe('MCP server wiring (get_quote_in_context over JSON-RPC)', () => {
  it('advertises get_quote_in_context in tools/list', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => []);
    const client = await wireClient({ provider, repository });
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'get_quote_in_context');
    expect(tool).toBeDefined();
    expect(tool!.description).toMatch(/quote/i);
    expect(tool!.inputSchema.type).toBe('object');
    expect((tool!.inputSchema.properties as Record<string, unknown>).quoteId).toBeDefined();
    await client.close();
  });

  it("tools/call returns the source's own words at the quote's span plus surrounding context", async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
    ]);
    await ingestSource(sermon, { provider, repository });
    const hits = await repository.searchByEmbedding((await provider.embed(['x']))[0]!, 1);
    const quoteId = hits[0]!.principle.quotes[0]!.id;

    const client = await wireClient({ provider, repository });
    const result = await client.callTool({
      name: 'get_quote_in_context',
      arguments: { quoteId },
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as unknown as GetQuoteInContextResponse;
    expect(structured.found).toBe(true);
    if (!structured.found) return;
    expect(structured.quote.text).toBe('Grace precedes obedience.');
    expect(structured.quote.contextAfter).toContain('loved first');
    expect(structured.principle.claim).toBe('Grace precedes obedience.');
    expect(structured.source.kind).toBe('sermon');
    await client.close();
  });

  it('returns { found: false } for an unknown Quote id (predictable empty shape)', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => []);
    const client = await wireClient({ provider, repository });
    const result = await client.callTool({
      name: 'get_quote_in_context',
      arguments: { quoteId: 'does-not-exist' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ found: false });
    await client.close();
  });

  it('rejects a malformed call (missing quoteId) with isError', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => []);
    const client = await wireClient({ provider, repository });
    const result = await client.callTool({
      name: 'get_quote_in_context',
      arguments: {},
    });
    expect(result.isError).toBe(true);
    await client.close();
  });
});

describe('MCP server wiring (Review queue tools — slice 6)', () => {
  it('advertises list_review_queue and resolve_review_item in tools/list', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => []);
    const client = await wireClient({ provider, repository });
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'list_review_queue')).toBeDefined();
    expect(tools.find((t) => t.name === 'resolve_review_item')).toBeDefined();
    await client.close();
  });

  it('list_review_queue returns the surfaced no-match candidate end-to-end', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Drift.', quote: 'Words never in the source.' },
    ]);
    await ingestSource(sermon, { provider, repository });
    const client = await wireClient({ provider, repository });
    const result = await client.callTool({
      name: 'list_review_queue',
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as unknown as ReviewQueueListing;
    expect(structured.total).toBe(1);
    expect(structured.items[0]!.sourceTitle).toBe('Grace and obedience');
    expect(structured.items[0]!.matchTier).toBe('no-match');
    await client.close();
  });

  it('list_review_queue returns the well-shaped empty case', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => []);
    const client = await wireClient({ provider, repository });
    const result = await client.callTool({ name: 'list_review_queue', arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ items: [], total: 0 });
    await client.close();
  });

  it('resolve_review_item correct admits when the Owner supplies a relocating quote', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Drift.', quote: 'Words not in source.' },
    ]);
    await ingestSource(sermon, { provider, repository });
    const itemId = repository.reviewCandidates()[0]!.id;
    const client = await wireClient({ provider, repository });
    const result = await client.callTool({
      name: 'resolve_review_item',
      arguments: {
        itemId,
        action: 'correct',
        quoteText: 'We are loved first.',
        claim: 'Loved first.',
      },
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as unknown as ReviewResolution;
    expect(structured.resolved).toBe(true);
    if (!structured.resolved) return;
    expect(structured.outcome).toBe('admitted');
    await client.close();
  });

  it('resolve_review_item reject drops the candidate', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Drift.', quote: 'Words not in source.' },
    ]);
    await ingestSource(sermon, { provider, repository });
    const itemId = repository.reviewCandidates()[0]!.id;
    const client = await wireClient({ provider, repository });
    const result = await client.callTool({
      name: 'resolve_review_item',
      arguments: { itemId, action: 'reject' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ resolved: true, outcome: 'rejected' });
    expect(repository.reviewCandidates()).toHaveLength(0);
    await client.close();
  });

  it('resolve_review_item rejects a malformed call (missing action) with isError', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => []);
    const client = await wireClient({ provider, repository });
    const result = await client.callTool({
      name: 'resolve_review_item',
      arguments: { itemId: 'nope' },
    });
    expect(result.isError).toBe(true);
    await client.close();
  });
});

describe('MCP server wiring (list_works over JSON-RPC — ADR-0017)', () => {
  it('advertises list_works in tools/list', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => []);
    const client = await wireClient({ provider, repository });
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'list_works');
    expect(tool).toBeDefined();
    expect(tool!.description).toMatch(/work/i);
    expect(tool!.inputSchema.type).toBe('object');
    await client.close();
  });

  it('tools/call returns Works grouped by Figure with tier', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => []);
    await repository.upsertFigure({ id: 'fig_smm', slug: 'sun-myung-moon', displayName: 'Sun Myung Moon' });
    await repository.upsertWork({ id: 'work_csg', title: 'Cheon Seong Gyeong', figureId: 'fig_smm', tier: 'core' });

    const client = await wireClient({ provider, repository });
    const result = await client.callTool({ name: 'list_works', arguments: {} });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as unknown as ListWorksResponse;
    expect(structured.figures).toHaveLength(1);
    expect(structured.figures[0]!.displayName).toBe('Sun Myung Moon');
    expect(structured.figures[0]!.works[0]!.title).toBe('Cheon Seong Gyeong');
    expect(structured.figures[0]!.works[0]!.tier).toBe('core');
    await client.close();
  });

  it('returns the well-shaped empty case ({ figures: [] })', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => []);
    const client = await wireClient({ provider, repository });
    const result = await client.callTool({ name: 'list_works', arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ figures: [] });
    await client.close();
  });
});

describe('MCP server wiring (readOnly: true — public web surface, ADR-0015 + ADR-0017)', () => {
  it('registers exactly the 4 read tools; write tools are absent', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => []);
    const client = await wireClient({ provider, repository }, { readOnly: true });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ['get_quote_in_context', 'list_works', 'related_principles', 'search_principles'].sort(),
    );
    await client.close();
  });

  it('calling a write tool from readOnly surface fails cleanly (tool not found)', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => []);
    const client = await wireClient({ provider, repository }, { readOnly: true });
    const result = await client.callTool({
      name: 'list_review_queue',
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const [firstContent] = result.content as Array<{ type: string; text: string }>;
    expect(firstContent!.text).toMatch(/list_review_queue/);
    await client.close();
  });
});

describe('MCP server wiring (related_principles over JSON-RPC)', () => {
  it('advertises related_principles in tools/list', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => []);
    const client = await wireClient({ provider, repository });
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'related_principles');
    expect(tool).toBeDefined();
    expect(tool!.description).toMatch(/related/i);
    expect(tool!.inputSchema.type).toBe('object');
    expect((tool!.inputSchema.properties as Record<string, unknown>).principleId).toBeDefined();
    await client.close();
  });

  it('tools/call returns the cluster sibling for a seed principle (golden, end-to-end)', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
      { claim: 'Obedience flows from grace.', quote: 'We are loved first.' },
    ]);
    await ingestSource(sermon, { provider, repository });
    const hits = await repository.searchByEmbedding((await provider.embed(['grace']))[0]!, 1);
    const seedId = hits[0]!.principle.id;

    const client = await wireClient({ provider, repository });
    const result = await client.callTool({
      name: 'related_principles',
      arguments: { principleId: seedId },
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as unknown as RelatedPrinciplesResponse;
    expect(structured.related.length).toBeGreaterThan(0);
    expect(structured.related[0]!.claim).toBe('Obedience flows from grace.');
    await client.close();
  });

  it('returns a well-shaped empty case ({ related: [] }) for an unknown principle id', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => []);
    const client = await wireClient({ provider, repository });
    const result = await client.callTool({
      name: 'related_principles',
      arguments: { principleId: 'does-not-exist' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ related: [] });
    await client.close();
  });

  it('rejects a malformed call (missing principleId) with isError', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => []);
    const client = await wireClient({ provider, repository });
    const result = await client.callTool({
      name: 'related_principles',
      arguments: {},
    });
    expect(result.isError).toBe(true);
    await client.close();
  });
});
