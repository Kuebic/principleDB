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
import { listReviewQueueTool } from './list-review-queue-tool';
import { listWorksTool } from './list-works-tool';
import { relatedPrinciplesTool } from './related-principles-tool';
import { resolveReviewItemTool } from './resolve-review-item-tool';
import { searchPrinciplesTool } from './search-principles-tool';

export interface ServerDeps {
  provider: IngestProvider;
  repository: CanonRepository;
}

// Which tool surface to expose on the server. The public web/MCP endpoint
// (ADR-0015 + ADR-0017 extension: 3 → 4 public tools with `list_works`)
// registers `readOnly: true` so `list_review_queue` + `resolve_review_item`
// — the Owner-only write tools — are never reachable from the anonymous
// surface. stdio and CI keep the default (all 6 tools).
export interface ServerOptions {
  readOnly?: boolean;
}

export function createPrincipleDbServer(
  deps: ServerDeps,
  options: ServerOptions = {},
): McpServer {
  const { readOnly = false } = options;
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
        'Search the Canon for atomic Principles matching a natural-language query. Each hit returns the Source’s own words at the snapped span (a Quote), with a derived label (page / timecode / position) so the caller can jump to the exact spot, and a citation carrying the Work title + Figure display name (ADR-0017). Optional `works` / `figures` scope the search: omitted ⇒ all core Works; naming a Figure expands to its Works; naming an `extra` Work opts it in. Include-only. Set `includeExtras: true` to search core + every supplementary (`extra`) Work in one shot.',
      inputSchema: {
        query: z.string().min(1).describe('What to search for, in natural language.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Max hits to return. Defaults to 5.'),
        works: z
          .array(z.string().min(1))
          .optional()
          .describe('Optional Work ids to search within. Union\'d with `figures`. Omitted ⇒ all core Works.'),
        figures: z
          .array(z.string().min(1))
          .optional()
          .describe('Optional Figure ids (or slugs) whose Works to search within. Union\'d with `works`. Omitted ⇒ all core Works.'),
        includeExtras: z
          .boolean()
          .optional()
          .describe('Union every supplementary (`extra`) Work on top of the scope. Omitted ⇒ core only; true ⇒ core + all extras (the whole Canon).'),
      },
    },
    async ({ query, limit, works, figures, includeExtras }) => {
      const response = await searchPrinciplesTool({ query, limit, works, figures, includeExtras }, deps);
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

  if (!readOnly) {
    server.registerTool(
      'list_review_queue',
      {
        description:
          'List unlocatable ReviewCandidates surfaced by the admission gate — the no-match extractions awaiting Owner judgement. Returns a summary-first shape (progressive disclosure): one row per candidate with a truncated quote preview and the Source title joined in. Empty case is { items: [], total: 0 }.',
        inputSchema: {
          limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe('Page size. Defaults to 25.'),
          offset: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe('Pagination offset, in candidate count.'),
        },
      },
      async ({ limit, offset }) => {
        const response = await listReviewQueueTool({ limit, offset }, deps);
        return {
          content: [{ type: 'text', text: JSON.stringify(response) }],
          structuredContent: response as unknown as Record<string, unknown>,
        };
      },
    );

    server.registerTool(
      'resolve_review_item',
      {
        description:
          'Resolve a ReviewCandidate: confirm (re-relocate the candidate as-is and admit if it now locates), correct (admit using a corrected quote, optionally a refined claim), or reject (drop). Admission still enforces the ≥1-relocating-Quote invariant (ADR-0007), so confirm/correct decline when the quote does not relocate.',
        inputSchema: {
          itemId: z.string().min(1).describe('The ReviewCandidate id, from list_review_queue.'),
          action: z
            .enum(['confirm', 'correct', 'reject'])
            .describe('confirm | correct | reject — see tool description.'),
          quoteText: z
            .string()
            .min(1)
            .optional()
            .describe('Required when action=correct: the Source-faithful quote to relocate against.'),
          claim: z
            .string()
            .min(1)
            .optional()
            .describe('Optional refinement of the claim when action=correct.'),
        },
      },
      async ({ itemId, action, quoteText, claim }) => {
        const response = await resolveReviewItemTool(
          { itemId, action, quoteText, claim },
          deps,
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(response) }],
          structuredContent: response as unknown as Record<string, unknown>,
        };
      },
    );
  }

  server.registerTool(
    'list_works',
    {
      description:
        'Discover what Works exist in the Canon, grouped by Figure (ADR-0017). Each Work carries a clean title and a `tier` — `core` (searched by default) or `extra` (opt-in). Use this to translate a member request like "only look through Hak Ja Han" into concrete `figures` / `works` params on search_principles. Empty case is { figures: [] }.',
      inputSchema: {},
    },
    async () => {
      const response = await listWorksTool(deps);
      return {
        content: [{ type: 'text', text: JSON.stringify(response) }],
        structuredContent: response as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'related_principles',
    {
      description:
        'Stack live-related Principles around a seed Principle. Relatedness is computed at query time over pgvector (ADR-0006: nothing stored, no graph), so the AI can surface siblings of a hit without a stale or hand-maintained graph. Returns the same citation-ready shape as search_principles (Source title/author/kind + the Source’s own words at the snapped span + a derived label). Optional `works` / `figures` scope the relatives the same way as search_principles: omitted ⇒ all core Works; naming a Figure expands to its Works; naming an `extra` Work opts it in. Include-only. Set `includeExtras: true` to draw relatives from core + every supplementary (`extra`) Work. Empty case is { related: [] }.',
      inputSchema: {
        principleId: z
          .string()
          .min(1)
          .describe('The seed Principle id (as returned from search_principles).'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Max related Principles to return. Defaults to 5.'),
        works: z
          .array(z.string().min(1))
          .optional()
          .describe("Optional Work ids to draw relatives from. Union'd with `figures`. Omitted ⇒ all core Works."),
        figures: z
          .array(z.string().min(1))
          .optional()
          .describe("Optional Figure ids (or slugs) whose Works to draw relatives from. Union'd with `works`. Omitted ⇒ all core Works."),
        includeExtras: z
          .boolean()
          .optional()
          .describe('Draw relatives from core + every supplementary (`extra`) Work. Omitted ⇒ core only.'),
      },
    },
    async ({ principleId, limit, works, figures, includeExtras }) => {
      const response = await relatedPrinciplesTool({ principleId, limit, works, figures, includeExtras }, deps);
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
