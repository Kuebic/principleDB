// search_principles — the MCP tool the AI client calls.
//
// Thin adapter over searchPrinciples():
//   • ranks via the repository
//   • enriches each hit with the Source's title/author/kind so a citation renders
//     without a follow-up tool call
//   • swaps the AI's stored claim for the SOURCE'S OWN WORDS at the snapped span
//     (ADR-0007) — `source.text.slice(span.start, span.end)`
//   • stamps the derived display label from the structureMap (ADR-0009)
//
// Response shape is THE SAME for hits and the empty case (`{ hits: [] }`) so the AI
// client doesn't have to special-case "nothing found".

import { deriveLabel } from '../canon/derive-label';
import type { CanonRepository, IngestProvider, SearchHit } from '../canon/ports';
import { searchPrinciples } from '../canon/search';
import type { SourceKind, Span } from '../canon/types';

export interface SearchPrinciplesRequest {
  query: string;
  limit?: number;
}

export interface SearchHitResponse {
  principleId: string;
  claim: string;
  score: number;
  source: {
    id: string;
    title: string;
    author: string;
    kind: SourceKind;
  };
  quote: {
    text: string;
    label: string;
    span: Span;
  };
}

export interface SearchPrinciplesResponse {
  hits: SearchHitResponse[];
}

export async function searchPrinciplesTool(
  req: SearchPrinciplesRequest,
  deps: { provider: IngestProvider; repository: CanonRepository },
): Promise<SearchPrinciplesResponse> {
  const limit = req.limit ?? 5;
  const hits = await searchPrinciples(req.query, { ...deps, limit });
  return { hits: await toSearchHitResponses(hits, deps.repository) };
}

// Enriches each SearchHit with its first Quote's snapped text, derived label,
// and Source citation fields (title/author/kind). Hits whose first Quote or
// Source can't be resolved are dropped — same shape as search_principles, so
// related_principles reuses it verbatim.
export async function toSearchHitResponses(
  hits: SearchHit[],
  repository: CanonRepository,
): Promise<SearchHitResponse[]> {
  const responses: SearchHitResponse[] = [];
  for (const hit of hits) {
    const quote = hit.principle.quotes[0];
    if (!quote) continue;
    const source = await repository.getSource(quote.sourceId);
    if (!source) continue;
    responses.push({
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
  return responses;
}
