// Two tiers, matching the OpenAI embedder test layout:
//
// 1. Unit tests with a stubbed Anthropic client — assert request shape (model,
//    tool, tool_choice, system, user content), response parsing
//    (tool_use → DistilledItem[], trimming + filtering), and provenance
//    stamping (default model, prompt version, overrides). Runs on every CI.
//
// 2. A live smoke test gated on ANTHROPIC_API_KEY — asserts a real Claude call
//    returns plausible Principles for a small fixture sermon. Skipped without
//    a key, like the Postgres integration tests gate on DATABASE_URL.

import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

import {
  AnthropicIngestProvider,
  DEFAULT_DISTIL_MODEL,
  PROMPT_VERSION,
} from './anthropic-provider';

type CreateParams = Anthropic.MessageCreateParamsNonStreaming;

function stubClient(
  toolInput: unknown,
  toolName = 'extract_principles',
): {
  client: Anthropic;
  calls: CreateParams[];
} {
  const calls: CreateParams[] = [];
  const create = vi.fn(async (params: CreateParams) => {
    calls.push(params);
    return {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: params.model,
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [
        {
          type: 'tool_use',
          id: 'toolu_test',
          name: toolName,
          input: toolInput,
        },
      ],
    } as unknown as Anthropic.Message;
  });
  return {
    client: { messages: { create } } as unknown as Anthropic,
    calls,
  };
}

const noEmbed = async (): Promise<number[][]> => {
  throw new Error('embed should not be called in distil tests');
};

describe('AnthropicIngestProvider (unit)', () => {
  it('stamps provenance with default model + prompt version (ADR-0008/0011)', () => {
    const { client } = stubClient({ principles: [] });
    const provider = new AnthropicIngestProvider({ client, embed: noEmbed });
    expect(provider.provenance).toEqual({
      distilModel: DEFAULT_DISTIL_MODEL,
      distilModelVersion: DEFAULT_DISTIL_MODEL,
      distilPromptVersion: PROMPT_VERSION,
    });
  });

  it('constructs from an OAuth bearer token (CLAUDE_CODE_OAUTH_TOKEN) without an API key', () => {
    // No stub client: this exercises the real SDK-construction branch for the
    // authToken credential. Provenance must still stamp.
    const provider = new AnthropicIngestProvider({ embed: noEmbed, authToken: 'sk-ant-oat-test' });
    expect(provider.provenance.distilModel).toBe(DEFAULT_DISTIL_MODEL);
    expect(provider.provenance.distilPromptVersion).toBe(PROMPT_VERSION);
  });

  it('defaults to the SDK retry count (2) when maxRetries is unset', () => {
    // Real SDK-construction branch (no stub client) so we can read the client's
    // maxRetries back off the constructed Anthropic instance.
    const provider = new AnthropicIngestProvider({ embed: noEmbed, authToken: 'sk-ant-oat-test' });
    expect((provider as unknown as { client: { maxRetries: number } }).client.maxRetries).toBe(2);
  });

  it('threads maxRetries into the Anthropic client (PRINCIPLEDB_MAX_RETRIES knob)', () => {
    const provider = new AnthropicIngestProvider({
      embed: noEmbed,
      authToken: 'sk-ant-oat-test',
      maxRetries: 5,
    });
    expect((provider as unknown as { client: { maxRetries: number } }).client.maxRetries).toBe(5);
  });

  it('allows model / version / prompt overrides for a pinned-instance Canon', () => {
    const { client } = stubClient({ principles: [] });
    const provider = new AnthropicIngestProvider({
      client,
      embed: noEmbed,
      model: 'claude-opus-4-7',
      modelVersion: '2026-03-13',
      promptVersion: 'distil/v2-experimental',
    });
    expect(provider.provenance).toEqual({
      distilModel: 'claude-opus-4-7',
      distilModelVersion: '2026-03-13',
      distilPromptVersion: 'distil/v2-experimental',
    });
  });

  it('forces the extract_principles tool and passes title + text in the user turn', async () => {
    const { client, calls } = stubClient({
      principles: [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }],
    });
    const provider = new AnthropicIngestProvider({ client, embed: noEmbed });

    await provider.distil({ title: 'Sermon on Grace', text: 'Grace precedes obedience.' });

    expect(calls).toHaveLength(1);
    const params = calls[0]!;
    expect(params.model).toBe(DEFAULT_DISTIL_MODEL);
    expect(params.tools).toHaveLength(1);
    const tool = params.tools![0] as Anthropic.Tool;
    expect(tool.name).toBe('extract_principles');
    expect(params.tool_choice).toEqual({ type: 'tool', name: 'extract_principles' });
    expect(typeof params.system).toBe('string');
    expect(params.messages).toHaveLength(1);
    const userContent = params.messages[0]!.content as string;
    expect(userContent).toContain('TITLE: Sermon on Grace');
    expect(userContent).toContain('Grace precedes obedience.');
  });

  it('parses tool_use output into DistilledItem[] in order', async () => {
    const { client } = stubClient({
      principles: [
        { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
        { claim: 'Light is a measure of love.', quote: 'light is a measure of love' },
      ],
    });
    const provider = new AnthropicIngestProvider({ client, embed: noEmbed });
    const items = await provider.distil({ title: 't', text: 'x' });
    expect(items).toEqual([
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
      { claim: 'Light is a measure of love.', quote: 'light is a measure of love' },
    ]);
  });

  it('trims whitespace and drops empty/malformed items so the admission gate sees clean input', async () => {
    const { client } = stubClient({
      principles: [
        { claim: '  Grace precedes obedience.  ', quote: '  Grace precedes obedience.\n' },
        { claim: '', quote: 'orphan quote' },
        { claim: 'orphan claim', quote: '' },
        { claim: 42, quote: 'not a string claim' },
        { claim: 'Light is a measure of love.', quote: 'light is a measure of love' },
      ],
    });
    const provider = new AnthropicIngestProvider({ client, embed: noEmbed });
    const items = await provider.distil({ title: 't', text: 'x' });
    expect(items).toEqual([
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
      { claim: 'Light is a measure of love.', quote: 'light is a measure of love' },
    ]);
  });

  it('returns [] when the tool_use block is absent (defensive — should not happen with forced tool_choice)', async () => {
    const create = vi.fn(async () => ({
      content: [{ type: 'text', text: 'oops, no tool call' }],
    })) as unknown as Anthropic['messages']['create'];
    const client = { messages: { create } } as unknown as Anthropic;
    const provider = new AnthropicIngestProvider({ client, embed: noEmbed });
    expect(await provider.distil({ title: 't', text: 'x' })).toEqual([]);
  });

  it('confirmSameClaim forces the same_claim tool and returns the verdict + rationale (issue #5)', async () => {
    const { client, calls } = stubClient(
      { same: true, rationale: 'identical wording' },
      'same_claim',
    );
    const provider = new AnthropicIngestProvider({ client, embed: noEmbed });
    const verdict = await provider.confirmSameClaim(
      'Grace precedes obedience.',
      'Grace precedes obedience.',
    );
    expect(verdict).toEqual({ same: true, rationale: 'identical wording' });

    expect(calls).toHaveLength(1);
    const params = calls[0]!;
    expect(params.tool_choice).toEqual({ type: 'tool', name: 'same_claim' });
    const tool = params.tools![0] as Anthropic.Tool;
    expect(tool.name).toBe('same_claim');
    const userContent = params.messages[0]!.content as string;
    expect(userContent).toContain('Grace precedes obedience.');
  });

  it('confirmSameClaim defaults to keep-separate when the model omits the tool (defensive)', async () => {
    const create = vi.fn(async () => ({
      content: [{ type: 'text', text: 'oops' }],
    })) as unknown as Anthropic['messages']['create'];
    const client = { messages: { create } } as unknown as Anthropic;
    const provider = new AnthropicIngestProvider({ client, embed: noEmbed });
    const verdict = await provider.confirmSameClaim('a', 'b');
    expect(verdict.same).toBe(false);
    expect(verdict.rationale).toMatch(/defaulting to keep-separate/);
  });

  it('delegates embed() to the injected EmbedFn (ADR-0011 split)', async () => {
    const { client } = stubClient({ principles: [] });
    const embed = vi.fn(async (claims: string[]) => claims.map(() => [1, 0, 0]));
    const provider = new AnthropicIngestProvider({ client, embed });
    const vectors = await provider.embed(['a', 'b']);
    expect(embed).toHaveBeenCalledWith(['a', 'b']);
    expect(vectors).toEqual([
      [1, 0, 0],
      [1, 0, 0],
    ]);
  });
});

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

describe.skipIf(!ANTHROPIC_KEY)('AnthropicIngestProvider (live smoke)', () => {
  it('distils a short sermon into Principles with verbatim backing quotes', async () => {
    const sermon = [
      'Grace precedes obedience. We are loved first, and our obedience flows from being loved.',
      'The empty seat is the assignment: God seats the person not yet here next to us.',
    ].join('\n');

    const provider = new AnthropicIngestProvider({ embed: noEmbed });
    const items = await provider.distil({ title: 'Grace and obedience', text: sermon });

    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.claim.length).toBeGreaterThan(0);
      expect(item.quote.length).toBeGreaterThan(0);
    }
    // Honesty guarantee (ADR-0007): the quote should appear in the source as
    // returned. Allow whitespace / curly-quote normalization to vary — the
    // canon-side relocation ladder handles that. At minimum, at least one
    // quote should exactly appear in the source.
    const exactHits = items.filter((it) => sermon.includes(it.quote));
    expect(exactHits.length).toBeGreaterThan(0);
  }, 60_000);
});
