// MCP server scaffold (issue #2, ADR-0005). Wires the `search_principles` tool
// onto JSON-RPC over a Transport, so an AI client can call it directly. The
// adapter is thin: input validation lives in the registered Zod schema, the
// existing handler does the work, and the response is returned as structured
// content. `runStdio` binds the server to stdio for the production wire; tests
// pair InMemoryTransports against the same factory.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { CanonRepository, IngestProvider } from '../canon/ports';
import { getQuoteInContextTool } from './get-quote-in-context-tool';
import { searchPrinciplesTool } from './search-principles-tool';

export interface ServerDeps {
  provider: IngestProvider;
  repository: CanonRepository;
}

export function createPrincipleDbServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    { name: 'principledb', version: '0.1.0' },
    {
      instructions:
        'principleDB — search the Canon (atomic Principles distilled from your teaching) with grounded citations.',
    },
  );

  server.registerTool(
    'search_principles',
    {
      description:
        'Search the Canon for atomic Principles matching a natural-language query. Each hit returns the Source’s own words at the snapped span (a Quote), with a derived label (page / timecode / position) so the caller can jump to the exact spot.',
      inputSchema: {
        query: z.string().min(1).describe('What to search for, in natural language.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Max hits to return. Defaults to 5.'),
      },
    },
    async ({ query, limit }) => {
      const response = await searchPrinciplesTool({ query, limit }, deps);
      return {
        content: [{ type: 'text', text: JSON.stringify(response) }],
        structuredContent: response as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'get_quote_in_context',
    {
      description:
        'Open a Quote at its exact spot in the Source. Returns the Source’s own words at the snapped span, a window of surrounding text, and a derived label (page / section / timestamp) computed from the Source’s structureMap. Not-found is signalled by { found: false }.',
      inputSchema: {
        quoteId: z
          .string()
          .min(1)
          .describe('The Quote id (as returned from search_principles).'),
        contextChars: z
          .number()
          .int()
          .min(0)
          .max(4000)
          .optional()
          .describe('Characters of surrounding text on each side. Defaults to 280.'),
      },
    },
    async ({ quoteId, contextChars }) => {
      const response = await getQuoteInContextTool({ quoteId, contextChars }, deps);
      return {
        content: [{ type: 'text', text: JSON.stringify(response) }],
        structuredContent: response as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}

export async function runStdio(server: McpServer): Promise<void> {
  await server.connect(new StdioServerTransport());
}
