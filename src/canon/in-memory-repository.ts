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

  async upsertSource(source: Source): Promise<void> {
    this.sources.set(source.id, source);
  }

  async getSource(id: string): Promise<Source | null> {
    return this.sources.get(id) ?? null;
  }

  async getQuoteById(quoteId: string): Promise<QuoteWithPrinciple | null> {
    for (const homes of this.principlesBySlot.values()) {
      for (const { principle } of homes) {
        for (const quote of principle.quotes) {
          if (quote.id === quoteId) {
            return { quote, principleClaim: principle.claim };
          }
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
    for (const slot of this.principlesBySlot.values()) {
      for (const { principle, sourceId } of slot) {
        const attached = attachedByPrincipleId.get(principle.id) ?? [];
        homes.push({
          principle:
            attached.length === 0
              ? principle
              : { ...principle, quotes: [...principle.quotes, ...attached] },
          sourceId,
        });
      }
    }
    return homes;
  }
}
