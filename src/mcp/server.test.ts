import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { FakeIngestProvider } from '../canon/fake-provider';
import { ingestSource } from '../canon/ingest';
import { InMemoryRepository } from '../canon/in-memory-repository';
import type { Source } from '../canon/types';
import type { GetQuoteInContextResponse } from './get-quote-in-context-tool';
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

async function wireClient(deps: {
  provider: FakeIngestProvider;
  repository: InMemoryRepository;
}): Promise<Client> {
  const server = createPrincipleDbServer(deps);
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
