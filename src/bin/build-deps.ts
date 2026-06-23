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
  PRINCIPLEDB_EMBED_MODEL?: string;
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

  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const repository = new PostgresCanonRepository(pool);
  const embed = createOpenAIEmbedder({
    apiKey: env.OPENAI_API_KEY,
    ...(env.PRINCIPLEDB_EMBED_MODEL ? { model: env.PRINCIPLEDB_EMBED_MODEL } : {}),
  });
  const provider = new AnthropicIngestProvider({
    ...anthropicAuth,
    embed,
    ...(env.PRINCIPLEDB_DISTIL_MODEL ? { model: env.PRINCIPLEDB_DISTIL_MODEL } : {}),
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
