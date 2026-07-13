// Hono app for the public web surface (ADR-0015, ADR-0016). One Node process,
// adapters over the shared `src/canon/` core:
//   • GET /            — the public Canon search page (Slice W2, #40/#47);
//     server-rendered HTML over `searchPrinciplesTool`. LLM-free.
//   • GET /quote/:id   — the Reader (Slice W3, #48, Variant D). Full source,
//     highlighted quote, sticky outline with scroll-spy.
//   • GET /api/search  — core-direct search JSON (no MCP hop, no LLM per #40);
//     returns the same SearchHitResponse shape the stdio MCP tool wraps.
//   • GET /api/related — core-direct related JSON for the on-demand expander
//     on the search page (fetched on click, not eager).
//   • POST /mcp        — stateless Streamable HTTP transport; a fresh server +
//     fresh transport instantiated per request (readOnly: true so the two
//     write tools are absent). GET/DELETE /mcp return 405.
// The site data path never hops through an MCP client — dogfooding lives in the
// smoke test (mcp-smoke.test.ts), not on this path (ADR-0015).
//
// Abuse / cost controls (Slice W4, #49) plug in as middleware here rather than
// in the individual handlers so they're one-place-to-look:
//   • createRateLimiter    — per-IP token-bucket 429s (opt-in via options)
//   • createRequestLogger  — per-request IP + UA log line (opt-in via options)
// The query-embedding cache lives in the caller-supplied provider (wrap with
// withQueryEmbeddingCache in the serve bin) so tests can opt in per-fixture.

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { getQuoteReader } from '../canon/quote-in-context';
import { createPrincipleDbServer, type ServerDeps } from '../mcp/server';
import { relatedPrinciplesTool } from '../mcp/related-principles-tool';
import { searchPrinciplesTool } from '../mcp/search-principles-tool';
import { createRateLimiter, type RateLimitOptions } from './rate-limit';
import {
  createRequestLogger,
  type RequestLoggerOptions,
} from './request-logger';
import { renderReaderNotFound, renderReaderPage } from './render-reader-page';
import { renderSearchPage } from './render-search-page';

export interface WebAppOptions {
  // Origin values allowed on cross-origin requests (DNS-rebinding protection).
  // When undefined, no Origin check is applied — the tracer-bullet default, safe
  // because the public deploy sits behind Cloudflare which handles origin
  // policing at the edge. Set on local dev to lock the endpoint to same-origin.
  allowedOrigins?: string[];
  // In-app per-IP rate limit (Slice W4, #49). Defense-in-depth behind the
  // Cloudflare edge rules (W6 deploy config). When omitted, no in-app limit
  // is applied — the tracer-bullet default so tests and dev don't 429 on
  // themselves. The serve bin turns it on with production-shaped defaults.
  rateLimit?: RateLimitOptions;
  // Per-request access log (Slice W4, #49). When omitted, no log is emitted.
  // Serve bin turns it on unconditionally; tests opt-in when asserting on
  // log output.
  requestLog?: RequestLoggerOptions;
}

export function createWebApp(deps: ServerDeps, options: WebAppOptions = {}): Hono {
  const app = new Hono();
  const { allowedOrigins } = options;

  // Middleware — order matters:
  //   1. request log runs first so every response (200/400/429/…) is logged
  //   2. rate limit runs before the handlers, so a 429 skips the (expensive)
  //      embed + vector-search work.
  if (options.requestLog) app.use('*', createRequestLogger(options.requestLog));
  if (options.rateLimit) app.use('*', createRateLimiter(options.rateLimit));

  // GET / — the public Canon search page (Slice W2, #40/#47). Server-rendered
  // over `searchPrinciplesTool` so results share the exact shape /api/search
  // returns. LLM-free by construction (embedding + pgvector); related hits
  // are DEFERRED and fetched on click via /api/related.
  app.get('/', async (c) => {
    const query = c.req.query('q');
    if (!query || query.trim() === '') {
      return c.html(renderSearchPage({}));
    }
    const response = await searchPrinciplesTool({ query }, deps);
    return c.html(renderSearchPage({ query, response }));
  });

  // GET /quote/:quoteId — the Reader page (Slice W3, #48, Variant D). The full
  // Source, freely scrollable, with the target Quote highlighted (`<mark
  // id="quote">`) and a sticky outline scroll-spy alongside. Not-found returns
  // 404 with a shaped page so a stale link doesn't dump a generic Hono response.
  app.get('/quote/:quoteId', async (c) => {
    const quoteId = c.req.param('quoteId');
    const back = safeReferer(c.req.header('Referer')) ?? '/';
    const result = await getQuoteReader(quoteId, deps);
    if (!result.found) {
      return c.html(renderReaderNotFound({ back }), 404);
    }
    return c.html(renderReaderPage(result, { back }));
  });

  // GET /api/search — core-direct, no MCP hop. Reuses the existing tool
  // handler so the site and the MCP endpoint return byte-identical hit shapes.
  app.get('/api/search', async (c) => {
    const query = c.req.query('q');
    if (!query || query.trim() === '') {
      return c.json({ error: 'missing required query parameter `q`' }, 400);
    }
    const limitRaw = c.req.query('limit');
    const limit = parseLimit(limitRaw);
    if (limit instanceof Error) {
      return c.json({ error: limit.message }, 400);
    }
    const response = await searchPrinciplesTool(
      { query, ...(limit !== undefined ? { limit } : {}) },
      deps,
    );
    return c.json(response);
  });

  // GET /api/related — core-direct, live pgvector relatedness for one seed
  // Principle. Powers the on-demand related expander on the public search
  // page (Slice W2 — not eager, fetched only when the user clicks). Same
  // response shape as the MCP `related_principles` tool.
  app.get('/api/related', async (c) => {
    const principleId = c.req.query('principleId');
    if (!principleId || principleId.trim() === '') {
      return c.json({ error: 'missing required query parameter `principleId`' }, 400);
    }
    const limitRaw = c.req.query('limit');
    const limit = parseLimit(limitRaw);
    if (limit instanceof Error) {
      return c.json({ error: limit.message }, 400);
    }
    const response = await relatedPrinciplesTool(
      { principleId, ...(limit !== undefined ? { limit } : {}) },
      deps,
    );
    return c.json(response);
  });

  // POST /mcp — stateless Streamable HTTP. Per ADR-0015 the read-only tool
  // surface is exactly the 3 read tools; write tools stay off the anonymous
  // surface. A fresh server + fresh transport per request (sessionIdGenerator:
  // undefined) keeps the endpoint safe under concurrent anonymous callers.
  app.post('/mcp', async (c) => {
    if (allowedOrigins && !originAllowed(c.req.header('Origin'), allowedOrigins)) {
      return c.json({ error: 'Origin not allowed' }, 403);
    }
    const server = createPrincipleDbServer(deps, { readOnly: true });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    // Per SDK v1.29 stateless mode the transport owns the response lifecycle:
    // returning its Response streams the reply to the client and the transport
    // + server are released when the stream ends. Closing the server here
    // would tear the reply down mid-flight.
    return transport.handleRequest(c.req.raw);
  });

  // Streamable HTTP stateless mode: GET (SSE stream) and DELETE (session
  // termination) have no meaning without a session, so surface them as 405
  // rather than defaulting to Hono's 404.
  app.on(['GET', 'DELETE'], '/mcp', (c) => c.text('Method Not Allowed', 405));

  return app;
}

function parseLimit(raw: string | undefined): number | undefined | Error {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    return new Error('`limit` must be an integer between 1 and 50');
  }
  return n;
}

function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (!origin) return true;
  return allowed.includes(origin);
}

// Only trust a Referer whose path/query we can safely use as a same-origin back
// link. External referers (or malformed URLs) fall through to the default '/'.
function safeReferer(referer: string | undefined): string | undefined {
  if (!referer) return undefined;
  try {
    const url = new URL(referer);
    if (!url.pathname.startsWith('/')) return undefined;
    return url.pathname + url.search;
  } catch {
    return undefined;
  }
}
