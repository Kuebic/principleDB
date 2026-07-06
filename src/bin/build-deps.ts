// Production wiring for `bin/principledb-mcp.ts` (issue #2). Reads the
// self-hoster's env (DATABASE_URL + ANTHROPIC_API_KEY + OPENAI_API_KEY),
// constructs the real Postgres repository and the Anthropic-backed
// IngestProvider with an OpenAI embedder (ADR-0008, ADR-0011), and returns
// the ServerDeps the MCP factory consumes. Exposed as a testable factory so
// the bin file stays a four-liner.

import pg from 'pg';
import { AnthropicIngestProvider } from '../canon/anthropic-provider';
import { createOpenAIEmbedder } from '../canon/openai-embedder';
import { PostgresCanonRepository } from '../db/postgres-repository';
import type { ServerDeps } from '../mcp/server';

export interface BuildDepsEnv {
  DATABASE_URL?: string;
  ANTHROPIC_API_KEY?: string;
  // A Claude Code subscription OAuth token satisfies the Anthropic credential
  // requirement in place of an API key (ADR-0011 model port). Used as a bearer
  // token when ANTHROPIC_API_KEY is absent.
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  OPENAI_API_KEY?: string;
  PRINCIPLEDB_DISTIL_MODEL?: string;
  // Override the dedup confirm model (issue #24, PRD #21). Defaults to
  // `claude-haiku-4-5` per `AnthropicIngestProvider`. Pin back to Opus
  // (e.g. `claude-opus-4-8`) on instances that need the higher-caution
  // confirm — see docs/SELF_HOSTING.md.
  PRINCIPLEDB_CONFIRM_MODEL?: string;
  PRINCIPLEDB_EMBED_MODEL?: string;
  // Overrides the Anthropic SDK's retry count (default 2) for transient 429 /
  // 5xx / connection errors — useful when a distil call shares an Opus rate
  // bucket with a live session. Parsed as a non-negative integer.
  PRINCIPLEDB_MAX_RETRIES?: string;
  // Overrides `pg.Pool` max connection count (default 10) for the seed run
  // (#34, PRD #27). Phase B's confirm fan-out (`confirmConcurrency`) sees no
  // gain past ~10 workers because the pool caps DB round-trips there; a
  // seed pass should raise this above the intended `confirmConcurrency`.
  // Unset = pg.Pool default — the right choice for interactive MCP use
  // where a bigger pool is wasted headroom.
  PRINCIPLEDB_PG_POOL_MAX?: string;
}

export interface BuiltDeps {
  deps: ServerDeps;
  pool: pg.Pool;
  close: () => Promise<void>;
}

export function buildPrincipleDbDepsFromEnv(env: BuildDepsEnv = process.env): BuiltDeps {
  // The Anthropic credential is satisfied by either an API key or a Claude Code
  // OAuth token; the env keeps the canonical ANTHROPIC_API_KEY label in the
  // "missing" list so the message reads cleanly when neither is present.
  const anthropicAuth = anthropicCredential(env);

  const missing: string[] = [];
  if (!env.DATABASE_URL) missing.push('DATABASE_URL');
  if (!anthropicAuth) missing.push('ANTHROPIC_API_KEY');
  if (!env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (missing.length > 0) {
    throw new Error(
      `principleDB needs ${missing.join(' + ')} in the environment ` +
        `(ANTHROPIC_API_KEY may be a CLAUDE_CODE_OAUTH_TOKEN instead). See docs/SELF_HOSTING.md.`,
    );
  }

  // Parse the retry override before opening the pool, so a bad value fails loud
  // instead of leaking a connection pool behind the throw.
  const maxRetries = parseMaxRetries(env.PRINCIPLEDB_MAX_RETRIES);
  const poolMax = parsePgPoolMax(env.PRINCIPLEDB_PG_POOL_MAX);

  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    ...(poolMax !== undefined ? { max: poolMax } : {}),
  });
  const repository = new PostgresCanonRepository(pool);
  const embed = createOpenAIEmbedder({
    apiKey: env.OPENAI_API_KEY,
    ...(env.PRINCIPLEDB_EMBED_MODEL ? { model: env.PRINCIPLEDB_EMBED_MODEL } : {}),
  });
  const provider = new AnthropicIngestProvider({
    ...anthropicAuth,
    embed,
    ...(env.PRINCIPLEDB_DISTIL_MODEL ? { model: env.PRINCIPLEDB_DISTIL_MODEL } : {}),
    ...(env.PRINCIPLEDB_CONFIRM_MODEL ? { confirmModel: env.PRINCIPLEDB_CONFIRM_MODEL } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
  });

  return {
    deps: { provider, repository },
    pool,
    close: () => pool.end(),
  };
}

// The Anthropic auth shape for the provider, or null when neither credential is
// present. An API key wins over an OAuth token when both are set.
function anthropicCredential(
  env: BuildDepsEnv,
): { apiKey: string } | { authToken: string } | null {
  if (env.ANTHROPIC_API_KEY) return { apiKey: env.ANTHROPIC_API_KEY };
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { authToken: env.CLAUDE_CODE_OAUTH_TOKEN };
  return null;
}

// Parse PRINCIPLEDB_MAX_RETRIES into the Anthropic client's maxRetries option.
// Unset (or empty) → undefined, so the SDK's default of 2 applies. A set-but-
// invalid value throws rather than silently disabling retries.
function parseMaxRetries(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `PRINCIPLEDB_MAX_RETRIES must be a non-negative integer, got "${raw}".`,
    );
  }
  return n;
}

// Parse PRINCIPLEDB_PG_POOL_MAX into pg.Pool's `max` option. Unset ⇒ undefined
// ⇒ pg's built-in default (10). Must be positive — a zero pool would block
// every query indefinitely.
function parsePgPoolMax(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `PRINCIPLEDB_PG_POOL_MAX must be a positive integer, got "${raw}".`,
    );
  }
  return n;
}
