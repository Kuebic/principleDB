// CI smoke test for the public /mcp endpoint (ADR-0015 dogfooding).
//
// Spins up a real Node HTTP server (@hono/node-server) hosting the Hono app,
// connects a real MCP SDK Client over StreamableHTTPClientTransport, and
// asserts:
//   • `search_principles` returns a grounded hit end-to-end
//   • the write tools (`list_review_queue`, `resolve_review_item`) are ABSENT
//     from the public tool listing (readOnly surface, ADR-0015)
//
// This is the only place an MCP *client* appears in the code path; the site
// (/api/search) never hops through the MCP client.

import { serve, type ServerType } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

describe('CI smoke test — real HTTP MCP client against /mcp (ADR-0015)', () => {
  let server: ServerType;
  let baseUrl: URL;

  beforeAll(async () => {
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
    ]);
    const repository = new InMemoryRepository();
    await ingestSource(sermon, { provider, repository });
    const app = createWebApp({ provider, repository });

    server = await new Promise<ServerType>((resolve) => {
      // port: 0 → OS assigns a free ephemeral port so parallel test files
      // never collide on a fixed one.
      const s = serve({ fetch: app.fetch, port: 0 }, () => resolve(s));
    });
    const address = server.address() as AddressInfo;
    baseUrl = new URL(`http://127.0.0.1:${address.port}`);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('lists exactly the 3 read tools; write tools are absent', async () => {
    const client = new Client({ name: 'smoke', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl));
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(
        ['get_quote_in_context', 'related_principles', 'search_principles'].sort(),
      );
      expect(names).not.toContain('list_review_queue');
      expect(names).not.toContain('resolve_review_item');
    } finally {
      await client.close();
    }
  });

  it('search_principles over HTTP returns a grounded hit', async () => {
    const client = new Client({ name: 'smoke', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl));
    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: 'search_principles',
        arguments: { query: 'grace and obedience' },
      });
      expect(result.isError).not.toBe(true);
      const structured = result.structuredContent as unknown as SearchPrinciplesResponse;
      expect(structured.hits).toHaveLength(1);
      const hit = structured.hits[0]!;
      expect(hit.claim).toBe('Grace precedes obedience.');
      expect(hit.quote.text).toBe('Grace precedes obedience.');
    } finally {
      await client.close();
    }
  });
});
