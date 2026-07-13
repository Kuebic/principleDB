#!/usr/bin/env node
// principleDB web + remote MCP server — production entrypoint (issue #46,
// ADR-0015 / ADR-0016). Reuses the same env wiring as the stdio bin
// (`principledb-mcp.ts`), then boots a Hono app on plain Node via
// `@hono/node-server`, serving both `/api/search` (core-direct) and `/mcp`
// (stateless, read-only) from one process. stdio MCP stays the baseline
// self-host mode; this serve mode is opt-in.
//
// Config from env:
//   • PORT (default 3000)
//   • HOSTNAME (default 0.0.0.0)
//   • PRINCIPLEDB_ALLOWED_ORIGINS — comma-separated list, opt-in origin check
//     for local dev. Public deploys handle origin policing at the Cloudflare
//     edge (ADR-0016), so unset is the recommended default.

import { serve } from '@hono/node-server';
import { buildPrincipleDbDepsFromEnv } from '../src/bin/build-deps';
import { createWebApp } from '../src/web/app';

async function main(): Promise<void> {
  const { deps, close } = buildPrincipleDbDepsFromEnv();
  const port = parsePort(process.env.PORT);
  const hostname = process.env.HOSTNAME ?? '0.0.0.0';
  const allowedOrigins = parseAllowedOrigins(process.env.PRINCIPLEDB_ALLOWED_ORIGINS);

  const app = createWebApp(
    deps,
    allowedOrigins ? { allowedOrigins } : {},
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

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
