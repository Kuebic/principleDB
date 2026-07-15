// related_principles — the MCP tool the AI client calls to STACK related
// Principles around a seed (issue #7, PRD user story 32, ADR-0006).
//
// Thin adapter over relatedPrinciples(): ranks live via the repository, then
// enriches each hit with the same citation-ready shape as search_principles
// — Source title/author/kind and the SOURCE'S OWN WORDS at the snapped span
// (ADR-0007), with the derived label (ADR-0009). Empty case is the well-shaped
// `{ related: [] }` so the AI client doesn't have to special-case "no
// neighbours" or "unknown id".

import type { CanonRepository } from '../canon/ports';
import { relatedPrinciples } from '../canon/related';
import type { Scope } from '../canon/scope';
import { toSearchHitResponses, type SearchHitResponse } from './search-principles-tool';

export interface RelatedPrinciplesRequest {
  principleId: string;
  limit?: number;
  // Same tier scoping as search_principles (ADR-0017): omitted ⇒ core Works
  // only, so a related stack never surfaces an `extra` neighbour by default;
  // naming a Figure/Work opts it in. Include-only, unioned.
  works?: readonly string[];
  figures?: readonly string[];
}

export interface RelatedPrinciplesResponse {
  related: SearchHitResponse[];
}

export async function relatedPrinciplesTool(
  req: RelatedPrinciplesRequest,
  deps: { repository: CanonRepository },
): Promise<RelatedPrinciplesResponse> {
  const scope: Scope | undefined =
    req.works || req.figures ? { works: req.works, figures: req.figures } : undefined;
  const hits = await relatedPrinciples(req.principleId, {
    repository: deps.repository,
    limit: req.limit,
    scope,
  });
  return { related: await toSearchHitResponses(hits, deps.repository) };
}
