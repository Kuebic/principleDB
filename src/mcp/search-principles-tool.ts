// search_principles — the MCP tool the AI client calls.
//
// Thin adapter over searchPrinciples():
//   • ranks via the repository
//   • enriches each hit with the Source's title/author/kind so a citation renders
//     without a follow-up tool call
//   • swaps the AI's stored claim for the SOURCE'S OWN WORDS at the snapped span
//     (ADR-0007) — `source.text.slice(span.start, span.end)`
//   • stamps the derived display label from the structureMap (ADR-0009)
//   • enriches the citation with Work title + Figure display name (ADR-0017) so
//     the AI client never has to render the ingest-time `author` slug (e.g.
//     `SunMyungMoon-CSG`, DP part-slugs). Nullable during the backfill window
//     for Sources not yet assigned a Work.
//
// Optional `works` / `figures` (ADR-0017) scope the retrieval: omitted ⇒ all
// `core` Works; naming a Figure expands to its Works; naming an `extra` Work
// opts it in. Include-only, unioned.
//
// Response shape is THE SAME for hits and the empty case (`{ hits: [] }`) so the AI
// client doesn't have to special-case "nothing found".

import { deriveLabel } from '../canon/derive-label';
import type { CanonRepository, IngestProvider, SearchHit } from '../canon/ports';
import { searchPrinciples } from '../canon/search';
import type { Scope } from '../canon/scope';
import type { SourceKind, Span } from '../canon/types';

export interface SearchPrinciplesRequest {
  query: string;
  limit?: number;
  works?: readonly string[];
  figures?: readonly string[];
  // One-shot "search core + every extra Work" toggle (ADR-0017). Union'd on
  // top of works/figures; omit for the core-only default.
  includeExtras?: boolean;
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
    // Work title + Figure display name (ADR-0017). Nullable during the
    // backfill window (a Source without an assigned Work) so a stale record
    // still renders — the AI client should prefer these fields for citation
    // and never surface `author`, which is the raw ingest slug.
    work: { title: string } | null;
    figure: { displayName: string } | null;
  };
  quote: {
    id: string;
    text: string;
    label: string;
    span: Span;
  };
  // Attestation signal (issue #64, PRD #63): how many Sources voice this
  // Principle — always >= 1 (the lead Quote itself). MCP clients read it as a
  // grounding-strength hint at negligible token cost; the web UI uses
  // `quoteCount - 1` to label the "+ N more sources" reveal control.
  quoteCount: number;
}

export interface SearchPrinciplesResponse {
  hits: SearchHitResponse[];
}

export async function searchPrinciplesTool(
  req: SearchPrinciplesRequest,
  deps: { provider: IngestProvider; repository: CanonRepository },
): Promise<SearchPrinciplesResponse> {
  const limit = req.limit ?? 5;
  const scope: Scope | undefined =
    req.works || req.figures || req.includeExtras
      ? { works: req.works, figures: req.figures, includeExtras: req.includeExtras }
      : undefined;
  const hits = await searchPrinciples(req.query, { ...deps, limit, scope });
  return { hits: await toSearchHitResponses(hits, deps.repository) };
}

// Enriches each SearchHit with its first Quote's snapped text, derived label,
// and Source citation fields (title/author/kind + Work/Figure). Hits whose
// first Quote or Source can't be resolved are dropped — same shape as
// search_principles, so related_principles reuses it verbatim. The Work +
// Edition listings are fetched once per call and indexed so we don't hit the
// repository per hit — post-#61, resolution runs Source → Edition → Work +
// Figure (the second-drifting-path-to-identity risk ADR-0017 removed cannot
// reappear).
export async function toSearchHitResponses(
  hits: SearchHit[],
  repository: CanonRepository,
): Promise<SearchHitResponse[]> {
  if (hits.length === 0) return [];
  const [listings, editions] = await Promise.all([
    repository.listWorks(),
    repository.listEditions(),
  ]);
  const worksByWorkId = new Map(listings.map((l) => [l.work.id, l] as const));
  const editionsById = new Map(editions.map((e) => [e.id, e] as const));
  const responses: SearchHitResponse[] = [];
  for (const hit of hits) {
    const quote = hit.principle.quotes[0];
    if (!quote) continue;
    const source = await repository.getSource(quote.sourceId);
    if (!source) continue;
    const edition = source.editionId ? editionsById.get(source.editionId) : undefined;
    const wf = edition ? worksByWorkId.get(edition.workId) : undefined;
    responses.push({
      principleId: hit.principle.id,
      claim: hit.principle.claim,
      score: hit.score,
      source: {
        id: source.id,
        title: source.title,
        author: source.author,
        kind: source.kind,
        work: wf ? { title: wf.work.title } : null,
        figure: wf ? { displayName: wf.figure.displayName } : null,
      },
      quote: {
        id: quote.id,
        text: source.text.slice(quote.span.start, quote.span.end),
        label: deriveLabel(source.structureMap, quote.span, source.text.length),
        span: quote.span,
      },
      quoteCount: hit.principle.quotes.length,
    });
  }
  return responses;
}
