// searchPrinciples — the retrieval seam the MCP `search_principles` tool wraps.
// Embed the query through the same provider that distilled the Canon, then ask the
// repository for the top-K by cosine.

import type { CanonRepository, IngestProvider, SearchHit } from './ports';

export interface SearchDeps {
  provider: IngestProvider;
  repository: CanonRepository;
  limit?: number;
}

export async function searchPrinciples(query: string, deps: SearchDeps): Promise<SearchHit[]> {
  const limit = deps.limit ?? 5;
  const [embedding] = await deps.provider.embed([query]);
  if (!embedding) return [];
  return deps.repository.searchByEmbedding(embedding, limit);
}
