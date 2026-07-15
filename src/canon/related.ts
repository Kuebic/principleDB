// relatedPrinciples — live, computed-at-query-time relatedness over pgvector
// (issue #7, PRD user story 32, ADR-0006).
//
// Nothing stored, no graph: the seed Principle's embedding is fetched and the
// top-K cosine-nearest neighbours (excluding the seed itself) are returned. A
// modest similarity floor filters noise so an isolated Principle returns the
// empty case rather than a list of low-score unrelated hits.

import type { CanonRepository, SearchHit } from './ports';
import { resolveScopedSourceIds } from './search';
import type { Scope } from './scope';

export const DEFAULT_RELATED_LIMIT = 5;
// Below this score, in-memory bag-of-words (FakeIngestProvider) and production
// 1536-d embeddings both look like noise. Set well below the dedup threshold
// (0.4, near-identical) so genuine relatives — paraphrases of the same idea
// across Sources — surface, while truly unrelated Principles drop off.
export const DEFAULT_RELATED_THRESHOLD = 0.3;

export interface RelatedDeps {
  repository: CanonRepository;
  limit?: number;
  threshold?: number;
  // `scope` (ADR-0017) gates relatives by the SAME tier rule as search:
  // omitted ⇒ core Works only, so an `extra` neighbour no longer leaks into an
  // unscoped stack; naming a Figure/Work opts it in. Resolved through the
  // shared helper so "omitted ⇒ core" and the pre-backfill "no Works ⇒
  // unscoped" case stay identical across both surfaces.
  scope?: Scope;
}

export async function relatedPrinciples(
  principleId: string,
  deps: RelatedDeps,
): Promise<SearchHit[]> {
  const limit = deps.limit ?? DEFAULT_RELATED_LIMIT;
  const threshold = deps.threshold ?? DEFAULT_RELATED_THRESHOLD;
  const scopedSourceIds = await resolveScopedSourceIds(deps.scope, deps.repository);
  // All named ids unknown ⇒ empty set ⇒ nothing in scope; skip the seed read.
  if (scopedSourceIds !== undefined && scopedSourceIds.length === 0) return [];
  return deps.repository.findRelatedPrinciples(principleId, threshold, limit, scopedSourceIds);
}
