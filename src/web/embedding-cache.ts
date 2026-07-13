// Short-TTL query-embedding cache (issue #49).
//
// A wrapper around an IngestProvider that memoizes SINGLE-STRING embed() calls
// — the retrieval path (searchPrinciples embeds `[query]`, one string) — so
// identical or retry queries within a short TTL skip the OpenAI /embeddings
// round-trip. Multi-string batches (the ingest path) fall through untouched:
// ingest doesn't retry the same batch shape often and would blow the cache.
//
// In-memory, per-process. Sized for one Node process (ADR-0016). Bounded by
// `maxEntries` + `ttlMs`; overflow evicts the oldest insertion order to keep
// the working set predictable under sustained novel-query load.

import type { IngestProvider } from '../canon/ports';

export interface QueryEmbeddingCacheOptions {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}

interface Entry {
  vector: number[];
  insertedAt: number;
}

export function withQueryEmbeddingCache(
  provider: IngestProvider,
  options: QueryEmbeddingCacheOptions,
): IngestProvider {
  const { ttlMs, maxEntries } = options;
  const now = options.now ?? Date.now;
  const cache = new Map<string, Entry>();

  const embed = async (claims: string[]): Promise<number[][]> => {
    // Only the retrieval path embeds a one-string batch. Ingest embeds many at
    // once; caching those would evict useful query entries and rarely hit.
    if (claims.length !== 1) return provider.embed(claims);

    const key = claims[0]!;
    const t = now();
    const hit = cache.get(key);
    if (hit && t - hit.insertedAt < ttlMs) {
      return [hit.vector];
    }

    const [vector] = await provider.embed([key]);
    if (!vector) return [];
    cache.set(key, { vector, insertedAt: t });
    // Bounded LRU-ish: Map preserves insertion order, so deleting the oldest
    // key when we exceed capacity gives insertion-order eviction. Cheap; no
    // heap or reordering on each read.
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return [vector];
  };

  return {
    provenance: provider.provenance,
    confirmModel: provider.confirmModel,
    distil: (input) => provider.distil(input),
    embed,
    confirmSameClaim: (a, b) => provider.confirmSameClaim(a, b),
  };
}
