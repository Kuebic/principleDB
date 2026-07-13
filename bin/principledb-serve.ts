#!/usr/bin/env node
// principleDB web + remote MCP server — production entrypoint (issue #46,
// ADR-0015 / ADR-0016). Reuses the same env wiring as the stdio bin
// (`principledb-mcp.ts`), then boots a Hono app on plain Node via
// `@hono/node-server`, serving both `/api/search` (core-direct) and `/mcp`
// (stateless, read-only) from one process. stdio MCP stays the baseline
// self-host mode; this serve mode is opt-in.
//
// Slice W4 (#49) hardening applied here:
//   • Wrap the ingest provider with a short-TTL query-embedding cache so
//     repeated queries within the TTL skip the OpenAI embed round-trip.
//   • Turn on per-IP in-app rate limiting (~60/min per IP, capacity = burst) —
//     defense-in-depth behind Cloudflare edge rules (W6 deploy config).
//   • Turn on per-request IP+UA access logging.
//   • Default PRINCIPLEDB_STATEMENT_TIMEOUT_MS to 5000ms so every pool
//     connection lands under a bounded per-session timeout.
//
// Config from env:
//   • PORT (default 3000)
//   • HOSTNAME (default 0.0.0.0)
//   • PRINCIPLEDB_ALLOWED_ORIGINS — comma-separated list, opt-in origin check
//     for local dev. Public deploys handle origin policing at the Cloudflare
//     edge (ADR-0016), so unset is the recommended default.
//   • PRINCIPLEDB_RATE_LIMIT_CAPACITY / PRINCIPLEDB_RATE_LIMIT_WINDOW_MS
//     override the token-bucket shape. Default capacity 60, window 60000 —
//     ~60 req/min per IP with a full-bucket burst.
//   • PRINCIPLEDB_EMBEDDING_CACHE_TTL_MS / PRINCIPLEDB_EMBEDDING_CACHE_MAX
//     override the query-embedding cache TTL / size. Defaults 60000, 500.
//   • PRINCIPLEDB_STATEMENT_TIMEOUT_MS — per-session Postgres statement
//     timeout. Defaults to 5000 for serving. Requires a session-mode
//     connection: the SET runs at pool-client connect time, and Supabase's
//     transaction pooler (port 6543) does NOT propagate session-level SETs
//     to the underlying Postgres. Serve with the session pooler
//     (port 5432 or the Supabase "Session pooler" URL); the stdio bin's
//     transaction pooler is unaffected because it doesn't set this at all.

import { serve } from '@hono/node-server';
import { buildPrincipleDbDepsFromEnv } from '../src/bin/build-deps';
import { createWebApp } from '../src/web/app';
import { withQueryEmbeddingCache } from '../src/web/embedding-cache';

async function main(): Promise<void> {
  // Default the serving statement_timeout to 5s so callers don't have to opt
  // in via env for every deploy. Ingest / stdio bins do not touch this so
  // their long-running transactions are unaffected.
  const env = {
    ...process.env,
    PRINCIPLEDB_STATEMENT_TIMEOUT_MS:
      process.env.PRINCIPLEDB_STATEMENT_TIMEOUT_MS ?? '5000',
  };

  const { deps, close } = buildPrincipleDbDepsFromEnv(env);
  const port = parsePort(process.env.PORT);
  const hostname = process.env.HOSTNAME ?? '0.0.0.0';
  const allowedOrigins = parseAllowedOrigins(process.env.PRINCIPLEDB_ALLOWED_ORIGINS);
  const rateLimit = parseRateLimit(process.env);
  const embeddingCache = parseEmbeddingCache(process.env);

  const cachedProvider = withQueryEmbeddingCache(deps.provider, embeddingCache);

  const app = createWebApp(
    { provider: cachedProvider, repository: deps.repository },
    {
      ...(allowedOrigins ? { allowedOrigins } : {}),
      rateLimit,
      requestLog: {},
    },
  );

  const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
    process.stdout.write(
      `principleDB serving on http://${info.address}:${info.port} — /api/search, /mcp (read-only)\n`,
    );
  });

  const shutdown = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 3000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`PORT must be an integer in [0, 65535], got "${raw}".`);
  }
  return n;
}

function parseAllowedOrigins(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw === '') return undefined;
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

// Parse the rate-limit shape from env. Defaults ~60 req/min per IP — full
// bucket size (capacity) IS the burst, so 60 lets a legitimate flurry through
// while a scraper hitting the DB at 100+/min gets 429s.
function parseRateLimit(env: NodeJS.ProcessEnv): {
  capacity: number;
  refillPerMs: number;
} {
  const capacity = parsePositiveInt(env.PRINCIPLEDB_RATE_LIMIT_CAPACITY, 60, 'PRINCIPLEDB_RATE_LIMIT_CAPACITY');
  const windowMs = parsePositiveInt(env.PRINCIPLEDB_RATE_LIMIT_WINDOW_MS, 60_000, 'PRINCIPLEDB_RATE_LIMIT_WINDOW_MS');
  return { capacity, refillPerMs: capacity / windowMs };
}

function parseEmbeddingCache(env: NodeJS.ProcessEnv): {
  ttlMs: number;
  maxEntries: number;
} {
  const ttlMs = parsePositiveInt(env.PRINCIPLEDB_EMBEDDING_CACHE_TTL_MS, 60_000, 'PRINCIPLEDB_EMBEDDING_CACHE_TTL_MS');
  const maxEntries = parsePositiveInt(env.PRINCIPLEDB_EMBEDDING_CACHE_MAX, 500, 'PRINCIPLEDB_EMBEDDING_CACHE_MAX');
  return { ttlMs, maxEntries };
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}".`);
  }
  return n;
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
