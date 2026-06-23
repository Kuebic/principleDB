#!/usr/bin/env node
// principleDB MCP server — production entrypoint. Reads env (DATABASE_URL,
// ANTHROPIC_API_KEY, OPENAI_API_KEY), wires the real PostgresCanonRepository
// + Anthropic distil + OpenAI embed, and binds the server to stdio so an AI
// client speaks JSON-RPC over it. All design surface lives in
// `src/bin/build-deps.ts` and `src/mcp/server.ts`; this file is just the
// wiring shell.

import { buildPrincipleDbDepsFromEnv } from '../src/bin/build-deps';
import { createPrincipleDbServer, runStdio } from '../src/mcp/server';

async function main(): Promise<void> {
  const { deps, close } = buildPrincipleDbDepsFromEnv();
  const server = createPrincipleDbServer(deps);
  const shutdown = async (): Promise<void> => {
    await close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await runStdio(server);
}

main().catch((err: unknown) => {
  // The wire is stdio JSON-RPC, so diagnostics go to stderr.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
