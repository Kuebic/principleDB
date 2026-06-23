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
  DedupDecision,
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

export interface SameClaimVerdict {
  same: boolean;
  rationale: string;
}

export interface IngestProvider {
  readonly provenance: DistilProvenance;
  distil(input: DistilInput): Promise<DistilledItem[]>;
  embed(claims: string[]): Promise<number[][]>;
  // The conservative-dedup "same claim?" confirm step (issue #5, ADR-0006).
  // Returns whether the two atomic claims are the same teaching plus a
  // rationale the Owner can inspect via the dedup decision log.
  confirmSameClaim(a: string, b: string): Promise<SameClaimVerdict>;
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

// Extra ingest output written alongside the new Principles. Kept on the same
// repository call so a transactional implementation can apply all three
// atomically (`replacePrinciplesForSource` already wipes the slot — attached
// quotes and decisions tagged with the same (sourceId, provenance) are wiped
// in the same transaction so re-ingest stays idempotent).
export interface ReplacePrinciplesOptions {
  attachedQuotes?: LocatedQuote[];
  decisions?: DedupDecision[];
}

// Pagination knobs for the Review queue listing (slice 6, issue #6).
// `limit`/`offset` are optional so the call shape stays terse for callers that
// just want the head of the queue. Order is stable insertion order — newest
// candidates at the tail — so paging through is predictable.
export interface ListReviewCandidatesOptions {
  limit?: number;
  offset?: number;
}

export interface CanonRepository {
  upsertSource(source: Source): Promise<void>;
  getSource(id: string): Promise<Source | null>;
  getQuoteById(quoteId: string): Promise<QuoteWithPrinciple | null>;
  replacePrinciplesForSource(
    sourceId: string,
    provenance: DistilProvenance,
    principles: Principle[],
    options?: ReplacePrinciplesOptions,
  ): Promise<void>;
  addReviewCandidates(candidates: ReviewCandidate[]): Promise<void>;
  // Review-queue surface (slice 6, issue #6). The resolver workflow is
  // per-row: list → get → on confirm/correct, insert an admitted Principle +
  // remove the candidate; on reject, just remove the candidate.
  // `insertReviewAdmittedPrinciple` is intentionally NOT scoped to the
  // `(sourceId, provenance)` slot used by `replacePrinciplesForSource` — a
  // review-admitted Principle is a per-candidate decision that should
  // survive routine re-ingest of the same Source, so it uses a distinct ID
  // namespace (`${candidate.id}#admitted` / `…#admitted-q`).
  listReviewCandidates(opts: ListReviewCandidatesOptions): Promise<ReviewCandidate[]>;
  countReviewCandidates(): Promise<number>;
  getReviewCandidate(id: string): Promise<ReviewCandidate | null>;
  removeReviewCandidate(id: string): Promise<void>;
  insertReviewAdmittedPrinciple(principle: Principle, sourceId: string): Promise<void>;
  searchByEmbedding(queryEmbedding: number[], limit: number): Promise<SearchHit[]>;
  // Vector prefilter for dedup. Returns the top-`limit` Principles whose
  // embedding is at or above `threshold` cosine to `embedding`, EXCLUDING any
  // Principle whose origin is `excludeSourceId` — dedup is a cross-Source
  // concern (ADR-0006/0008); the same source under different provenance must
  // not collapse into itself.
  findSimilarPrinciplesExcludingSource(
    embedding: number[],
    excludeSourceId: string,
    threshold: number,
    limit: number,
  ): Promise<SearchHit[]>;
  // Live relatedness (issue #7, PRD user story 32, ADR-0006). Top-`limit`
  // Principles whose cosine to `principleId`'s embedding is at or above
  // `threshold`, EXCLUDING the seed itself. Computed on read — nothing
  // stored, no graph (ADR-0006). Unknown seed id ⇒ empty array.
  findRelatedPrinciples(
    principleId: string,
    threshold: number,
    limit: number,
  ): Promise<SearchHit[]>;
}
