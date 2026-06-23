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

  it('exposes a close() that drains the pg pool', async () => {
    const out = buildPrincipleDbDepsFromEnv(fullEnv);
    await expect(out.close()).resolves.toBeUndefined();
  });
});
