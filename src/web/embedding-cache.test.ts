import { describe, expect, it } from 'vitest';
import { FakeIngestProvider } from '../canon/fake-provider';
import type { IngestProvider } from '../canon/ports';
import { withQueryEmbeddingCache } from './embedding-cache';

function countingProvider(): { provider: IngestProvider; calls: () => number } {
  let n = 0;
  const base = new FakeIngestProvider(() => []);
  const provider: IngestProvider = {
    provenance: base.provenance,
    confirmModel: base.confirmModel,
    distil: (input) => base.distil(input),
    embed: async (claims) => {
      n += 1;
      return base.embed(claims);
    },
    confirmSameClaim: (a, b) => base.confirmSameClaim(a, b),
  };
  return { provider, calls: () => n };
}

describe('withQueryEmbeddingCache — short-TTL query embedding cache (#49)', () => {
  it('returns the same vector for repeated single-string queries without re-embedding', async () => {
    const { provider, calls } = countingProvider();
    let now = 0;
    const cached = withQueryEmbeddingCache(provider, {
      ttlMs: 60_000,
      maxEntries: 100,
      now: () => now,
    });

    const [v1] = await cached.embed(['grace and obedience']);
    const [v2] = await cached.embed(['grace and obedience']);
    expect(v1).toEqual(v2);
    expect(calls()).toBe(1); // second call served from cache
  });

  it('expires entries past ttlMs and re-embeds on the next call', async () => {
    const { provider, calls } = countingProvider();
    let now = 0;
    const cached = withQueryEmbeddingCache(provider, {
      ttlMs: 1000,
      maxEntries: 100,
      now: () => now,
    });

    await cached.embed(['q']);
    expect(calls()).toBe(1);

    now = 500;
    await cached.embed(['q']);
    expect(calls()).toBe(1); // still fresh

    now = 1500;
    await cached.embed(['q']);
    expect(calls()).toBe(2); // expired, re-embedded
  });

  it('does not memoize multi-string batches (ingest path stays uncached)', async () => {
    const { provider, calls } = countingProvider();
    let now = 0;
    const cached = withQueryEmbeddingCache(provider, {
      ttlMs: 60_000,
      maxEntries: 100,
      now: () => now,
    });

    await cached.embed(['a', 'b']);
    await cached.embed(['a', 'b']);
    expect(calls()).toBe(2);
  });

  it('evicts oldest entries when the cache exceeds maxEntries', async () => {
    const { provider, calls } = countingProvider();
    let now = 0;
    const cached = withQueryEmbeddingCache(provider, {
      ttlMs: 60_000,
      maxEntries: 2,
      now: () => now,
    });

    await cached.embed(['a']);
    now = 1;
    await cached.embed(['b']);
    now = 2;
    await cached.embed(['c']); // evicts 'a'
    expect(calls()).toBe(3);

    await cached.embed(['a']); // 'a' was evicted → re-embed
    expect(calls()).toBe(4);

    await cached.embed(['c']); // still present
    expect(calls()).toBe(4);
  });

  it('preserves the underlying provider’s distil and confirmSameClaim behaviour', async () => {
    const { provider } = countingProvider();
    const cached = withQueryEmbeddingCache(provider, { ttlMs: 1000, maxEntries: 10 });
    expect(cached.provenance).toEqual(provider.provenance);
    expect(cached.confirmModel).toBe(provider.confirmModel);
    const verdict = await cached.confirmSameClaim('a', 'a');
    expect(verdict).toEqual(await provider.confirmSameClaim('a', 'a'));
  });
});
