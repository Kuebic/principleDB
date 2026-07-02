// Canon-invisible staging store — foundation slice for the two-phase seed
// (issue #29, PRD #27, ADR-0014).
//
// Phase A of the seed runs distil+admit+embed massively parallel across docs
// and writes each Source's admitted Principles + Review candidates to this
// store; Phase B drains it in plan-walk order, dedups against the Canon-so-far
// and persists. The load-bearing guardrail is that the dedup query surface
// (`findSimilarPrinciplesExcludingSource`) MUST NOT see staged rows — if it
// did, `first-Source-wins` (ADR-0008) would break because Phase B could see an
// un-deduped sibling as a merge candidate. So staging is a *separate* table
// and lives behind its own port, not a flag on `principle`.
//
// Keyed `(sourceId, provenance)` — same grain as `replacePrinciplesForSource`,
// so a re-stage under the same provenance replaces (idempotent). Provenance
// travels *inside* the payload as well, so Phase B reconstructs
// `DistilProvenance` from staged rows — never from a Phase-B provider config
// that might not match Phase A's (ADR-0014 "Provenance-in-payload").
//
// Embeddings ride along in the payload so Phase B is a pure local-query +
// confirm loop (no re-embed). ~4GB transient at 690k scale, dropped as each
// Source is deduped and its staging row deleted.
//
// Kept off the existing `BulkProgressStore` port on purpose: progress is a
// tiny (phase, source_id) marker (has the Source been distilled? has it been
// deduped?); staging holds the payload between the two phases. They compose
// but do not overlap.

import type { DistilProvenance, Principle, ReviewCandidate } from './types';

// What Phase A writes and Phase B reads. Principles carry their embeddings
// (Phase B never re-embeds) and their located Quotes; Review candidates carry
// what they need to be persisted at the end of Phase B. Provenance rides
// alongside so Phase B can reconstruct `DistilProvenance` without depending
// on a live provider config.
export interface StagingPayload {
  provenance: DistilProvenance;
  principles: Principle[];
  reviewCandidates: ReviewCandidate[];
}

// A `(sourceId, provenance)` pointer to a staged payload — the listStaged
// return shape. Includes provenance so a caller can construct the Phase-B
// worklist without a second round-trip.
export interface StagedEntry {
  sourceId: string;
  provenance: DistilProvenance;
}

export interface StagingStore {
  // Write the payload for `(sourceId, provenance)`. Re-staging under the same
  // key replaces (idempotent). Phase A writes this transactionally with its
  // `BulkProgressStore.mark` so no Source is ever half-staged.
  stage(
    sourceId: string,
    provenance: DistilProvenance,
    payload: StagingPayload,
  ): Promise<void>;
  // Retrieve the staged payload for `(sourceId, provenance)`. Returns null
  // when no payload has been staged for that key.
  read(
    sourceId: string,
    provenance: DistilProvenance,
  ): Promise<StagingPayload | null>;
  // Every currently-staged `(sourceId, provenance)`. Phase B replays the
  // plan-walk to derive order — this is a completeness check, not the
  // authority on Phase-B order.
  listStaged(): Promise<StagedEntry[]>;
  // Drain a staged Source after Phase B has deduped+persisted it. The
  // staging table shrinks as the seed run progresses. A staging row deleted
  // between Phase B persist and mark is safe: `replacePrinciplesForSource`
  // is idempotent, and Phase B will skip the marked Source on resume.
  delete(sourceId: string, provenance: DistilProvenance): Promise<void>;
}

export class InMemoryStagingStore implements StagingStore {
  // Keyed by `${sourceId}\x00${provenanceKey}` so a Source under two distinct
  // provenances (e.g. re-distil sweep) stays in separate slots. The sourceId
  // is stored alongside the payload so `listStaged` never has to parse it back
  // out of the composite key.
  private readonly entries = new Map<
    string,
    { sourceId: string; payload: StagingPayload }
  >();

  async stage(
    sourceId: string,
    provenance: DistilProvenance,
    payload: StagingPayload,
  ): Promise<void> {
    this.entries.set(keyOf(sourceId, provenance), {
      sourceId,
      payload: clonePayload(payload),
    });
  }

  async read(
    sourceId: string,
    provenance: DistilProvenance,
  ): Promise<StagingPayload | null> {
    const found = this.entries.get(keyOf(sourceId, provenance));
    return found ? clonePayload(found.payload) : null;
  }

  async listStaged(): Promise<StagedEntry[]> {
    return [...this.entries.values()].map(({ sourceId, payload }) => ({
      sourceId,
      provenance: { ...payload.provenance },
    }));
  }

  async delete(sourceId: string, provenance: DistilProvenance): Promise<void> {
    this.entries.delete(keyOf(sourceId, provenance));
  }

  size(): number {
    return this.entries.size;
  }
}

function keyOf(sourceId: string, provenance: DistilProvenance): string {
  return `${sourceId}\x00${provenance.distilModel}\x00${provenance.distilModelVersion}\x00${provenance.distilPromptVersion}`;
}

// Deep-copy the payload on the way in and out so a caller mutating a Principle
// (e.g. Phase B stamping dedup verdicts) never leaks back into the store —
// the real Postgres impl round-trips through jsonb which serializes anyway,
// and the in-memory impl matches that isolation.
function clonePayload(p: StagingPayload): StagingPayload {
  return {
    provenance: { ...p.provenance },
    principles: p.principles.map((pr) => ({
      ...pr,
      embedding: [...pr.embedding],
      quotes: pr.quotes.map((q) => ({ ...q, span: { ...q.span } })),
    })),
    reviewCandidates: p.reviewCandidates.map((c) => ({ ...c })),
  };
}
