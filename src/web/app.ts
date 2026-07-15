// Hono app for the public web surface (ADR-0015, ADR-0016). One Node process,
// adapters over the shared `src/canon/` core:
//   • GET /            — the public Canon search page (Slice W2, #40/#47);
//     server-rendered HTML over `searchPrinciplesTool`. LLM-free.
//   • GET /quote/:id   — the Reader (Slice W3, #48, Variant D). Full source,
//     highlighted quote, sticky outline with scroll-spy.
//   • GET /connect     — the "connect your AI" page (Slice W5, #50). Static
//     copy-paste steps against the deployed /mcp URL; the deep-face
//     counterpart to the shallow public search (CONTEXT.md carve-out).
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
import { deriveLabel } from '../canon/derive-label';
import { getQuoteReader } from '../canon/quote-in-context';
import { createPrincipleDbServer, type ServerDeps } from '../mcp/server';
import { relatedPrinciplesTool } from '../mcp/related-principles-tool';
import { searchPrinciplesTool } from '../mcp/search-principles-tool';
import { createRateLimiter, type RateLimitOptions } from './rate-limit';
import {
  createRequestLogger,
  type RequestLoggerOptions,
} from './request-logger';
import { renderConnectPage } from './render-connect-page';
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

  // GET / — the public Canon search page (Slice W2, #40/#47) with the
  // Work/Figure source-filtering scope in URL params (Slice W57, ADR-0017).
  // Repeated `?work=` / `?figure=` params define the scope; absence = all
  // `core` Works (dynamic — a future core Work auto-joins). State lives
  // purely in the URL so a scoped search is shareable/bookmarkable.
  app.get('/', async (c) => {
    const query = c.req.query('q');
    const works = c.req.queries('work') ?? [];
    const figures = c.req.queries('figure') ?? [];
    const scope = works.length > 0 || figures.length > 0 ? { works, figures } : undefined;
    // The picker needs the full Works listing regardless of query — a member
    // landing on the page (no query) should still see what is searchable.
    const listings = await deps.repository.listWorks();
    if (!query || query.trim() === '') {
      return c.html(renderSearchPage({ works: listings, scope }));
    }
    const response = await searchPrinciplesTool({ query, ...(scope ?? {}) }, deps);
    return c.html(renderSearchPage({ query, response, works: listings, scope }));
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

  // GET /connect — static "connect your AI" page (Slice W5, #50). We compute
  // the /mcp URL from the request so the same page works against localhost,
  // a Fly hostname, or a Cloudflare-fronted domain — no separate env var.
  // Behind a proxy we respect x-forwarded-proto/host so the printed URL is
  // the public one (Cloudflare terminates TLS in front).
  app.get('/connect', (c) => {
    const mcpUrl = buildPublicMcpUrl(c.req.raw, c.req.header('X-Forwarded-Proto'), c.req.header('X-Forwarded-Host'));
    return c.html(renderConnectPage({ mcpUrl }));
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

  // GET /api/quotes — web-only paging of a Principle's additional Sources
  // (issue #65, PRD #63). Consumed by the "+ N more sources" client reveal;
  // NOT wired into the MCP surface (MCP gets only the `quoteCount` integer).
  // `offset` counts extras beyond the lead (offset 0 → the first 3 extras =
  // `quotes[1..3]`); consecutive offsets return disjoint, ordered batches.
  // `hasMore` is detected by fetching one row past `limit` and dropping it.
  app.get('/api/quotes', async (c) => {
    const principleId = c.req.query('principleId');
    if (!principleId || principleId.trim() === '') {
      return c.json({ error: 'missing required query parameter `principleId`' }, 400);
    }
    const offsetRaw = c.req.query('offset');
    const offset = parseOffset(offsetRaw);
    if (offset instanceof Error) {
      return c.json({ error: offset.message }, 400);
    }
    const [listings, editions] = await Promise.all([
      deps.repository.listWorks(),
      deps.repository.listEditions(),
    ]);
    const worksByWorkId = new Map(listings.map((l) => [l.work.id, l] as const));
    const editionsById = new Map(editions.map((e) => [e.id, e] as const));
    // Extras start at index 1 (the lead lives at 0) — translate the extras-
    // relative offset to the flat quote index the repo indexes by.
    const flatOffset = 1 + offset;
    const rows = await deps.repository.getQuotesForPrinciple(
      principleId,
      flatOffset,
      EXTRAS_PAGE_SIZE + 1,
    );
    const hasMore = rows.length > EXTRAS_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, EXTRAS_PAGE_SIZE) : rows;
    const quotes = page.map(({ quote, source }) => {
      const edition = source.editionId ? editionsById.get(source.editionId) : undefined;
      const wf = edition ? worksByWorkId.get(edition.workId) : undefined;
      return {
        id: quote.id,
        text: source.text.slice(quote.span.start, quote.span.end),
        label: deriveLabel(source.structureMap, quote.span, source.text.length),
        source: {
          id: source.id,
          title: source.title,
          kind: source.kind,
          work: wf ? { title: wf.work.title } : null,
          figure: wf ? { displayName: wf.figure.displayName } : null,
        },
      };
    });
    return c.json({ quotes, hasMore });
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

function buildPublicMcpUrl(
  request: Request,
  forwardedProto: string | undefined,
  forwardedHost: string | undefined,
): string {
  const url = new URL(request.url);
  if (forwardedProto) url.protocol = `${forwardedProto.split(',')[0]!.trim()}:`;
  if (forwardedHost) url.host = forwardedHost.split(',')[0]!.trim();
  url.pathname = '/mcp';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function parseLimit(raw: string | undefined): number | undefined | Error {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    return new Error('`limit` must be an integer between 1 and 50');
  }
  return n;
}

// The "extras beyond the lead" batch size the /api/quotes endpoint returns
// per page (issue #65, PRD #63). Small so a heavily-attested Principle stays
// scannable; the client pages by advancing offset in this stride.
const EXTRAS_PAGE_SIZE = 3;

function parseOffset(raw: string | undefined): number | Error {
  if (raw === undefined || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    return new Error('`offset` must be a non-negative integer');
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
