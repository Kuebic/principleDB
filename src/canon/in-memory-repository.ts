// Reference CanonRepository implementation — backs the integration tests without a
// running Postgres. The PostgresCanonRepository (Drizzle + pgvector) will land
// behind the same port; tests stay deterministic.
//
// Idempotency at the (sourceId, provenance) grain (ADR-0008): same provenance replaces
// the slot; different provenance occupies a different slot so re-ingest under a
// different model is ADDITIVE — a model-mixed Canon stays honest. Dedup
// attachments (quotes from this source attached to a Principle from another
// source) and dedup-decision rows are scoped to (sourceId, provenance) too —
// the same key wipes them inside replacePrinciplesForSource, so a re-ingest
// stays clean.

import type {
  DedupDecision,
  DistilProvenance,
  LocatedQuote,
  Principle,
  ReviewCandidate,
  Source,
} from './types';
import type {
  CanonRepository,
  ListReviewCandidatesOptions,
  QuoteWithPrinciple,
  ReplacePrinciplesOptions,
  SearchHit,
} from './ports';

function provenanceKey(sourceId: string, p: DistilProvenance): string {
  return `${sourceId}|${p.distilModel}|${p.distilModelVersion}|${p.distilPromptVersion}`;
}

function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Each Principle's home (sourceId, provenance) slot — needed so dedup can
// exclude principles owned by the current source.
interface PrincipleHome {
  principle: Principle;
  sourceId: string;
}

export class InMemoryRepository implements CanonRepository {
  private readonly sources = new Map<string, Source>();
  private readonly principlesBySlot = new Map<string, PrincipleHome[]>();
  private readonly attachedQuotesBySlot = new Map<string, LocatedQuote[]>();
  private readonly decisionsBySlot = new Map<string, DedupDecision[]>();
  private readonly review: ReviewCandidate[] = [];
  // Review-admitted Principles (slice 6, issue #6) — kept in a distinct slot
  // from `principlesBySlot` so a future ingest of the same (sourceId,
  // provenance) does not silently wipe a Principle the Owner explicitly
  // resolved through the queue.
  private readonly reviewAdmitted: PrincipleHome[] = [];

  async upsertSource(source: Source): Promise<void> {
    this.sources.set(source.id, source);
  }

  async getSource(id: string): Promise<Source | null> {
    return this.sources.get(id) ?? null;
  }

  async getQuoteById(quoteId: string): Promise<QuoteWithPrinciple | null> {
    // Walks both own-slot and dedup-attached quotes — Postgres stores both
    // in the same `quote` table and finds them in one lookup; in-memory
    // mirrors that by joining via `allPrinciplesWithAttachedQuotes()`.
    for (const { principle } of this.allPrinciplesWithAttachedQuotes()) {
      for (const quote of principle.quotes) {
        if (quote.id === quoteId) {
          return { quote, principleClaim: principle.claim };
        }
      }
    }
    return null;
  }

  async replacePrinciplesForSource(
    sourceId: string,
    provenance: DistilProvenance,
    principles: Principle[],
    options?: ReplacePrinciplesOptions,
  ): Promise<void> {
    const key = provenanceKey(sourceId, provenance);
    this.principlesBySlot.set(
      key,
      principles.map((principle) => ({ principle, sourceId })),
    );
    this.attachedQuotesBySlot.set(key, options?.attachedQuotes ?? []);
    this.decisionsBySlot.set(key, options?.decisions ?? []);
  }

  async addReviewCandidates(candidates: ReviewCandidate[]): Promise<void> {
    this.review.push(...candidates);
  }

  async listReviewCandidates(opts: ListReviewCandidatesOptions): Promise<ReviewCandidate[]> {
    const offset = opts.offset ?? 0;
    const end = opts.limit !== undefined ? offset + opts.limit : undefined;
    return this.review.slice(offset, end);
  }

  async countReviewCandidates(): Promise<number> {
    return this.review.length;
  }

  async getReviewCandidate(id: string): Promise<ReviewCandidate | null> {
    return this.review.find((c) => c.id === id) ?? null;
  }

  async removeReviewCandidate(id: string): Promise<void> {
    const idx = this.review.findIndex((c) => c.id === id);
    if (idx >= 0) this.review.splice(idx, 1);
  }

  async insertReviewAdmittedPrinciple(principle: Principle, sourceId: string): Promise<void> {
    this.reviewAdmitted.push({ principle, sourceId });
  }

  async searchByEmbedding(queryEmbedding: number[], limit: number): Promise<SearchHit[]> {
    const hits = this.allPrinciplesWithAttachedQuotes().map(({ principle }) => ({
      principle,
      score: cosine(queryEmbedding, principle.embedding),
    }));
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  async findSimilarPrinciplesExcludingSource(
    embedding: number[],
    excludeSourceId: string,
    threshold: number,
    limit: number,
  ): Promise<SearchHit[]> {
    const hits = this.allPrinciplesWithAttachedQuotes()
      .filter((p) => p.sourceId !== excludeSourceId)
      .map(({ principle }) => ({
        principle,
        score: cosine(embedding, principle.embedding),
      }))
      .filter((h) => h.score >= threshold);
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  async findSimilarPrinciplesForBatch(
    embeddings: number[][],
    excludeSourceId: string,
    threshold: number,
    limit: number,
  ): Promise<SearchHit[][]> {
    // Reference implementation: fan out to the per-embedding query. Postgres
    // fuses this into a single LATERAL-join round-trip — the port contract
    // asserts both return the same result set per index.
    return Promise.all(
      embeddings.map((e) =>
        this.findSimilarPrinciplesExcludingSource(e, excludeSourceId, threshold, limit),
      ),
    );
  }

  async findRelatedPrinciples(
    principleId: string,
    threshold: number,
    limit: number,
  ): Promise<SearchHit[]> {
    const all = this.allPrinciplesWithAttachedQuotes();
    const seed = all.find(({ principle }) => principle.id === principleId);
    if (!seed) return [];
    const hits = all
      .filter(({ principle }) => principle.id !== principleId)
      .map(({ principle }) => ({
        principle,
        score: cosine(seed.principle.embedding, principle.embedding),
      }))
      .filter((h) => h.score >= threshold);
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  reviewCandidates(): ReadonlyArray<ReviewCandidate> {
    return this.review;
  }

  dedupDecisions(): ReadonlyArray<DedupDecision> {
    const all: DedupDecision[] = [];
    for (const ds of this.decisionsBySlot.values()) all.push(...ds);
    return all;
  }

  // Hydrates Principles with both their own (replace-slot) quotes and any
  // attached quotes from other Sources' dedup merges. The attached quotes
  // live under their originating slot so re-ingesting that source wipes them
  // and lets dedup re-decide; on read, we join them onto the host Principle
  // so search/quote-in-context see the full evidence trail.
  private allPrinciplesWithAttachedQuotes(): PrincipleHome[] {
    const attachedByPrincipleId = new Map<string, LocatedQuote[]>();
    for (const quotes of this.attachedQuotesBySlot.values()) {
      for (const q of quotes) {
        const arr = attachedByPrincipleId.get(q.principleId) ?? [];
        arr.push(q);
        attachedByPrincipleId.set(q.principleId, arr);
      }
    }
    const homes: PrincipleHome[] = [];
    const visit = ({ principle, sourceId }: PrincipleHome) => {
      const attached = attachedByPrincipleId.get(principle.id) ?? [];
      homes.push({
        principle:
          attached.length === 0
            ? principle
            : { ...principle, quotes: [...principle.quotes, ...attached] },
        sourceId,
      });
    };
    for (const slot of this.principlesBySlot.values()) {
      for (const home of slot) visit(home);
    }
    for (const home of this.reviewAdmitted) visit(home);
    return homes;
  }
}
