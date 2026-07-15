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
  Figure,
  LocatedQuote,
  Principle,
  ReviewCandidate,
  Source,
  Work,
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
  // The model that produced the `confirmSameClaim` verdict — separate from
  // the distil provenance because the confirm changes the merge decision,
  // not what was said (issue #24, PRD #21). Surfaced on the provider so
  // `dedup()` can stamp every `DedupDecision` without taking a config
  // parameter, and so the audit trail stays honest in a model-mixed Canon.
  readonly confirmModel: string;
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

// Denormalized listing for the Figure-grouped picker + `list_works` MCP tool
// (ADR-0017). One row per Work with its Figure pre-joined so callers render
// grouped output without a second round-trip.
export interface WorkWithFigure {
  work: Work;
  figure: Figure;
}

// Lightweight Source ref for the backfill (issue #54). `text` +
// `structure_map` are deliberately omitted so 615 rows (or more) fit
// comfortably in memory during the one-time assignment pass.
export interface SourceRefForBackfill {
  id: string;
  author: string;
  title: string;
  workId: string | null;
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
  // Work/Figure grouping layer (ADR-0017). `upsertFigure`/`upsertWork` back
  // the one-time backfill and future ingest's Work-assignment step; both are
  // idempotent by primary key so re-running is safe.
  upsertFigure(figure: Figure): Promise<void>;
  upsertWork(work: Work): Promise<void>;
  // Every Work with its Figure pre-joined — feeds the web picker + the
  // `list_works` MCP tool.
  listWorks(): Promise<WorkWithFigure[]>;
  // Resolves a set of Work ids to the Source ids that belong to them. The
  // scope resolver uses this to compute the concrete pre-filter set from a
  // Work/Figure scope. Returns [] for an empty input.
  listSourceIdsInWorks(workIds: string[]): Promise<string[]>;
  // Lightweight rows the one-time backfill (issue #54, ADR-0017) reads to
  // assign every existing Source to its Work. Deliberately omits `text` and
  // `structure_map` so the whole Canon fits in memory during the assignment
  // pass. `workId` is included so a re-run can be logged as "already
  // assigned" — idempotence is a first-class property of the script.
  listSourceRefsForBackfill(): Promise<SourceRefForBackfill[]>;
  // Narrow UPDATE (issue #54): sets `source.work_id` without rewriting the
  // rest of the row. Backs the backfill and future ingest's Work-assignment
  // step — a full `upsertSource` would rewrite the (potentially large) text
  // column for no reason.
  assignSourceToWork(sourceId: string, workId: string): Promise<void>;
  // `scopedSourceIds`, when provided, restricts the search to Principles
  // whose home Source is in the set — applied as a SQL pre-filter *before*
  // top-K so tight scopes still return their best matches (ADR-0017). An
  // empty array = no matches; omitting the arg preserves the unscoped
  // behavior existing callers rely on.
  searchByEmbedding(
    queryEmbedding: number[],
    limit: number,
    scopedSourceIds?: readonly string[],
  ): Promise<SearchHit[]>;
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
  // Batched vector prefilter for dedup: one round-trip that returns the
  // top-`limit` candidates for EACH of `embeddings[i]`, in the same order.
  // Semantically equivalent to calling `findSimilarPrinciplesExcludingSource`
  // once per embedding — but Phase B of the two-phase seed pays that
  // round-trip per Principle (~1 pooler hop per Principle, ~5–6s/confirm-
  // equivalent measured in the #34 spike). Batching per Source removes it
  // from the critical path without changing merge semantics: `dedup` still
  // walks each Principle's candidates in the same order under the same
  // `topK`/`threshold`, and the confirm loop is byte-for-byte the same.
  findSimilarPrinciplesForBatch(
    embeddings: number[][],
    excludeSourceId: string,
    threshold: number,
    limit: number,
  ): Promise<SearchHit[][]>;
  // Live relatedness (issue #7, PRD user story 32, ADR-0006). Top-`limit`
  // Principles whose cosine to `principleId`'s embedding is at or above
  // `threshold`, EXCLUDING the seed itself. Computed on read — nothing
  // stored, no graph (ADR-0006). Unknown seed id ⇒ empty array.
  //
  // `scopedSourceIds` (ADR-0017) restricts relatives to Principles whose home
  // Source is in the set, applied as a pre-filter — the SAME tier gate
  // searchByEmbedding uses, so an `extra` neighbour can't leak into an
  // unscoped stack the way it did before. Empty array = no matches; omitting
  // the arg keeps the unscoped behavior (used by dedup/tests, not the public
  // tool, which always passes the resolved core-or-named set).
  findRelatedPrinciples(
    principleId: string,
    threshold: number,
    limit: number,
    scopedSourceIds?: readonly string[],
  ): Promise<SearchHit[]>;
}
