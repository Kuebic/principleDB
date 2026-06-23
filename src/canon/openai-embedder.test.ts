// Two tiers of test:
//
// 1. Unit tests with a stubbed fetch — assert the request shape (URL, headers,
//    body), response parsing, ordering re-sort, error mapping, and L2 norm.
//    These run on every CI.
//
// 2. A live smoke test gated on OPENAI_API_KEY — asserts a real call returns
//    a 1536-dim L2-normalized vector. Skipped without a key, like the Postgres
//    integration tests gate on DATABASE_URL.

import { describe, expect, it, vi } from 'vitest';
import { createOpenAIEmbedder } from './openai-embedder';

function fakeFetchOk(body: unknown): typeof fetch {
  const f = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => body,
  })) as unknown as typeof fetch;
  return f;
}

function fakeFetchErr(status: number, body: string): typeof fetch {
  return (async () => ({
    ok: false,
    status,
    text: async () => body,
    json: async () => ({}),
  })) as unknown as typeof fetch;
}

describe('createOpenAIEmbedder (unit)', () => {
  it('throws when no API key is in opts or env', () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(() => createOpenAIEmbedder()).toThrow(/OPENAI_API_KEY/);
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
    }
  });

  it('returns [] for an empty claims array (no API call)', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const embed = createOpenAIEmbedder({ apiKey: 'sk-test', fetchImpl });
    expect(await embed([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts to {baseUrl}/embeddings with model, input, dimensions, and bearer auth', async () => {
    const captured: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          data: [{ index: 0, embedding: [1, 0, 0] }],
        }),
      };
    }) as unknown as typeof fetch;

    const embed = createOpenAIEmbedder({
      apiKey: 'sk-test',
      model: 'text-embedding-3-small',
      dim: 1536,
      baseUrl: 'https://api.openai.com/v1/',
      fetchImpl,
    });
    await embed(['hello']);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe('https://api.openai.com/v1/embeddings');
    expect(captured[0]!.init.method).toBe('POST');
    const headers = captured[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(captured[0]!.init.body as string)).toEqual({
      model: 'text-embedding-3-small',
      input: ['hello'],
      dimensions: 1536,
    });
  });

  it('L2-normalizes returned vectors so cosine degrades to dot product', async () => {
    const fetchImpl = fakeFetchOk({
      data: [{ index: 0, embedding: [3, 4] }],
    });
    const embed = createOpenAIEmbedder({ apiKey: 'sk-test', fetchImpl });
    const [vec] = await embed(['hello']);
    expect(vec).toEqual([0.6, 0.8]);
    const mag = Math.sqrt(vec!.reduce((s, v) => s + v * v, 0));
    expect(mag).toBeCloseTo(1, 10);
  });

  it('re-sorts vectors by index so out-of-order responses still pair with claims', async () => {
    const fetchImpl = fakeFetchOk({
      data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ],
    });
    const embed = createOpenAIEmbedder({ apiKey: 'sk-test', fetchImpl });
    const vectors = await embed(['first', 'second']);
    expect(vectors).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it('throws with status + body excerpt on non-2xx', async () => {
    const fetchImpl = fakeFetchErr(401, '{"error":{"message":"bad key"}}');
    const embed = createOpenAIEmbedder({ apiKey: 'sk-test', fetchImpl });
    await expect(embed(['x'])).rejects.toThrow(/401.*bad key/);
  });
});

const OPENAI_KEY = process.env.OPENAI_API_KEY;

describe.skipIf(!OPENAI_KEY)('createOpenAIEmbedder (live smoke)', () => {
  it('returns a 1536-dim L2-normalized vector from a real API call', async () => {
    const embed = createOpenAIEmbedder();
    const [vec] = await embed(['Grace precedes obedience.']);
    expect(vec).toBeDefined();
    expect(vec!.length).toBe(1536);
    const mag = Math.sqrt(vec!.reduce((s, v) => s + v * v, 0));
    expect(mag).toBeCloseTo(1, 5);
  }, 30_000);

  it('keeps claims and vectors paired across a batch', async () => {
    const embed = createOpenAIEmbedder();
    const claims = ['Grace precedes obedience.', 'Light is a measure of love.'];
    const vectors = await embed(claims);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).not.toEqual(vectors[1]);
  }, 30_000);
});
