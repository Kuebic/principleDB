// The two non-deterministic seams (ADR-0005, ADR-0008): the LLM and the database.
//
// IngestProvider: distil + embed + own provenance. Anthropic-backed in production
// (default `claude-opus-4-8`); FakeIngestProvider in tests.
//
// CanonRepository: persistence. Idempotency lives in `replacePrinciplesForSource`
// at the (sourceId, provenance) grain (ADR-0008) — same provenance replaces;
// different provenance is additive so a model-mixed Canon stays honest.
//
// MCP tools and the future Formation layer are adapters over the same ports.

import type {
  DistilProvenance,
  DistilledItem,
  LocatedQuote,
  Principle,
  ReviewCandidate,
  Source,
} from './types';

export interface DistilInput {
  title: string;
  text: string;
}

export interface IngestProvider {
  readonly provenance: DistilProvenance;
  distil(input: DistilInput): Promise<DistilledItem[]>;
  embed(claims: string[]): Promise<number[][]>;
}

export interface SearchHit {
  principle: Principle;
  score: number;
}

// Minimal join shape getQuoteInContext needs: the located Quote plus the claim of
// the Principle it backs. Source is fetched separately via getSource() so the
// repository doesn't have to triple-join on what is fundamentally a lookup.
export interface QuoteWithPrinciple {
  quote: LocatedQuote;
  principleClaim: string;
}

export interface CanonRepository {
  upsertSource(source: Source): Promise<void>;
  getSource(id: string): Promise<Source | null>;
  getQuoteById(quoteId: string): Promise<QuoteWithPrinciple | null>;
  replacePrinciplesForSource(
    sourceId: string,
    provenance: DistilProvenance,
    principles: Principle[],
  ): Promise<void>;
  addReviewCandidates(candidates: ReviewCandidate[]): Promise<void>;
  searchByEmbedding(queryEmbedding: number[], limit: number): Promise<SearchHit[]>;
}
