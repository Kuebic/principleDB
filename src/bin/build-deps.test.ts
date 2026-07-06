import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicIngestProvider } from '../canon/anthropic-provider';
import { PostgresCanonRepository } from '../db/postgres-repository';
import { buildPrincipleDbDepsFromEnv } from './build-deps';

const fullEnv = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/principledb',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  OPENAI_API_KEY: 'sk-openai-test',
};

describe('buildPrincipleDbDepsFromEnv', () => {
  const built: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (built.length > 0) {
      const b = built.pop()!;
      await b.close().catch(() => {});
    }
  });

  it('wires PostgresCanonRepository + AnthropicIngestProvider when env is complete', () => {
    const out = buildPrincipleDbDepsFromEnv(fullEnv);
    built.push(out);
    expect(out.deps.repository).toBeInstanceOf(PostgresCanonRepository);
    expect(out.deps.provider).toBeInstanceOf(AnthropicIngestProvider);
    // The provider stamps provenance even though we never made a network call.
    expect(out.deps.provider.provenance.distilModel).toMatch(/^claude-/);
    expect(out.deps.provider.provenance.distilPromptVersion).toMatch(/^distil\//);
  });

  it('throws a single message listing every missing env var', () => {
    expect(() => buildPrincipleDbDepsFromEnv({})).toThrow(
      /DATABASE_URL \+ ANTHROPIC_API_KEY \+ OPENAI_API_KEY/,
    );
  });

  it('throws when both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are missing', () => {
    expect(() =>
      buildPrincipleDbDepsFromEnv({
        DATABASE_URL: fullEnv.DATABASE_URL,
        OPENAI_API_KEY: fullEnv.OPENAI_API_KEY,
      }),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('accepts a CLAUDE_CODE_OAUTH_TOKEN in place of ANTHROPIC_API_KEY', () => {
    const out = buildPrincipleDbDepsFromEnv({
      DATABASE_URL: fullEnv.DATABASE_URL,
      OPENAI_API_KEY: fullEnv.OPENAI_API_KEY,
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test',
    });
    built.push(out);
    expect(out.deps.provider).toBeInstanceOf(AnthropicIngestProvider);
    expect(out.deps.provider.provenance.distilModel).toMatch(/^claude-/);
  });

  it('throws when only OPENAI_API_KEY is missing', () => {
    expect(() =>
      buildPrincipleDbDepsFromEnv({
        DATABASE_URL: fullEnv.DATABASE_URL,
        ANTHROPIC_API_KEY: fullEnv.ANTHROPIC_API_KEY,
      }),
    ).toThrow(/OPENAI_API_KEY/);
  });

  it('respects PRINCIPLEDB_DISTIL_MODEL when set', () => {
    const out = buildPrincipleDbDepsFromEnv({
      ...fullEnv,
      PRINCIPLEDB_DISTIL_MODEL: 'claude-sonnet-4-6',
    });
    built.push(out);
    expect(out.deps.provider.provenance.distilModel).toBe('claude-sonnet-4-6');
  });

  it('respects PRINCIPLEDB_CONFIRM_MODEL — pinning confirm back to Opus per SELF_HOSTING (#24, PRD #21)', () => {
    const out = buildPrincipleDbDepsFromEnv({
      ...fullEnv,
      PRINCIPLEDB_CONFIRM_MODEL: 'claude-opus-4-8',
    });
    built.push(out);
    expect(out.deps.provider.confirmModel).toBe('claude-opus-4-8');
    // Distil default is unchanged when confirm is overridden in isolation.
    expect(out.deps.provider.provenance.distilModel).toMatch(/^claude-opus/);
  });

  it('defaults confirmModel to Haiku without an explicit override (#24, PRD #21)', () => {
    const out = buildPrincipleDbDepsFromEnv(fullEnv);
    built.push(out);
    expect(out.deps.provider.confirmModel).toMatch(/haiku/);
  });

  it('threads PRINCIPLEDB_MAX_RETRIES into the Anthropic client when set', () => {
    const out = buildPrincipleDbDepsFromEnv({ ...fullEnv, PRINCIPLEDB_MAX_RETRIES: '5' });
    built.push(out);
    expect(
      (out.deps.provider as unknown as { client: { maxRetries: number } }).client.maxRetries,
    ).toBe(5);
  });

  it('throws a clear error on a non-integer or negative PRINCIPLEDB_MAX_RETRIES', () => {
    expect(() =>
      buildPrincipleDbDepsFromEnv({ ...fullEnv, PRINCIPLEDB_MAX_RETRIES: 'abc' }),
    ).toThrow(/PRINCIPLEDB_MAX_RETRIES must be a non-negative integer/);
    expect(() =>
      buildPrincipleDbDepsFromEnv({ ...fullEnv, PRINCIPLEDB_MAX_RETRIES: '-1' }),
    ).toThrow(/PRINCIPLEDB_MAX_RETRIES must be a non-negative integer/);
  });

  it('exposes a close() that drains the pg pool', async () => {
    const out = buildPrincipleDbDepsFromEnv(fullEnv);
    await expect(out.close()).resolves.toBeUndefined();
  });

  it('threads PRINCIPLEDB_PG_POOL_MAX into the pg pool for the seed run (#34)', () => {
    // Phase B's confirm concurrency plateaus at ~390/min because the default
    // pg.Pool max=10 caps DB fan-out below `confirmConcurrency` (#34). The
    // knob has to size the pool for a seed run explicitly; unset = pg.Pool's
    // default (10 today), which is the right choice for interactive MCP use.
    const out = buildPrincipleDbDepsFromEnv({ ...fullEnv, PRINCIPLEDB_PG_POOL_MAX: '48' });
    built.push(out);
    expect(out.pool.options.max).toBe(48);
  });

  it('uses pg.Pool defaults when PRINCIPLEDB_PG_POOL_MAX is unset (#34)', () => {
    const out = buildPrincipleDbDepsFromEnv(fullEnv);
    built.push(out);
    // pg.Pool falls back to its built-in default (10) when max is not set.
    expect(out.pool.options.max).toBe(10);
  });

  it('throws a clear error on a non-integer or non-positive PRINCIPLEDB_PG_POOL_MAX (#34)', () => {
    expect(() =>
      buildPrincipleDbDepsFromEnv({ ...fullEnv, PRINCIPLEDB_PG_POOL_MAX: 'abc' }),
    ).toThrow(/PRINCIPLEDB_PG_POOL_MAX must be a positive integer/);
    expect(() =>
      buildPrincipleDbDepsFromEnv({ ...fullEnv, PRINCIPLEDB_PG_POOL_MAX: '0' }),
    ).toThrow(/PRINCIPLEDB_PG_POOL_MAX must be a positive integer/);
  });
});
