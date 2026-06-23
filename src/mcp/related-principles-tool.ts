// related_principles — the MCP tool the AI client calls to STACK related
// Principles around a seed (issue #7, PRD user story 32, ADR-0006).
//
// Thin adapter over relatedPrinciples(): ranks live via the repository, then
// enriches each hit with the same citation-ready shape as search_principles
// — Source title/author/kind and the SOURCE'S OWN WORDS at the snapped span
// (ADR-0007), with the derived label (ADR-0009). Empty case is the well-shaped
// `{ related: [] }` so the AI client doesn't have to special-case "no
// neighbours" or "unknown id".

import { deriveLabel } from '../canon/derive-label';
import type { CanonRepository } from '../canon/ports';
import { relatedPrinciples } from '../canon/related';
import type { SearchHitResponse } from './search-principles-tool';

export interface RelatedPrinciplesRequest {
  principleId: string;
  limit?: number;
}

export interface RelatedPrinciplesResponse {
  related: SearchHitResponse[];
}

export async function relatedPrinciplesTool(
  req: RelatedPrinciplesRequest,
  deps: { repository: CanonRepository },
): Promise<RelatedPrinciplesResponse> {
  const hits = await relatedPrinciples(req.principleId, {
    repository: deps.repository,
    limit: req.limit,
  });

  const related: SearchHitResponse[] = [];
  for (const hit of hits) {
    const quote = hit.principle.quotes[0];
    if (!quote) continue;
    const source = await deps.repository.getSource(quote.sourceId);
    if (!source) continue;
    related.push({
      principleId: hit.principle.id,
      claim: hit.principle.claim,
      score: hit.score,
      source: {
        id: source.id,
        title: source.title,
        author: source.author,
        kind: source.kind,
      },
      quote: {
        text: source.text.slice(quote.span.start, quote.span.end),
        label: deriveLabel(source.structureMap, quote.span, source.text.length),
        span: quote.span,
      },
    });
  }
  return { related };
}
