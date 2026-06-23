// Reference CanonRepository implementation — backs the integration tests without a
// running Postgres. The PostgresCanonRepository (Drizzle + pgvector) will land
// behind the same port; tests stay deterministic.
//
// Idempotency at the (sourceId, provenance) grain (ADR-0008): same provenance replaces
// the slot; different provenance occupies a different slot so re-ingest under a
// different model is ADDITIVE — a model-mixed Canon stays honest.

import type {
  DistilProvenance,
  Principle,
  ReviewCandidate,
  Source,
} from './types';
import type { CanonRepository, QuoteWithPrinciple, SearchHit } from './ports';

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

export class InMemoryRepository implements CanonRepository {
  private readonly sources = new Map<string, Source>();
  private readonly principlesBySlot = new Map<string, Principle[]>();
  private readonly review: ReviewCandidate[] = [];

  async upsertSource(source: Source): Promise<void> {
    this.sources.set(source.id, source);
  }

  async getSource(id: string): Promise<Source | null> {
    return this.sources.get(id) ?? null;
  }

  async getQuoteById(quoteId: string): Promise<QuoteWithPrinciple | null> {
    for (const principles of this.principlesBySlot.values()) {
      for (const principle of principles) {
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
  ): Promise<void> {
    this.principlesBySlot.set(provenanceKey(sourceId, provenance), principles);
  }

  async addReviewCandidates(candidates: ReviewCandidate[]): Promise<void> {
    this.review.push(...candidates);
  }

  async searchByEmbedding(queryEmbedding: number[], limit: number): Promise<SearchHit[]> {
    const all: Principle[] = [];
    for (const ps of this.principlesBySlot.values()) all.push(...ps);
    const scored: SearchHit[] = all.map((principle) => ({
      principle,
      score: cosine(queryEmbedding, principle.embedding),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  reviewCandidates(): ReadonlyArray<ReviewCandidate> {
    return this.review;
  }
}
