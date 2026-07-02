// ingestSource — the Canon ingest pipeline.
//
// distil → admit (relocation + admission gate) → embed admitted claims →
// conservative dedup (issue #5: vector prefilter + LLM "same claim?" confirm,
// cross-Source only) → persist.
//
// Idempotent under a pinned (sourceId, provenance) per ADR-0008: repeated
// runs replace that slot, not append. Attached-quote merges and dedup
// decisions are scoped to the same slot so they too clear on re-ingest.
//
// Two-phase seed split (issue #30, PRD #27, ADR-0014). `stageSource` /
// `stageDistilledItems` are the Canon-independent head of the pipeline —
// distil + admit + embed → StagingStore. They exist alongside the single-file
// pipeline (unchanged) so the seed can run Phase A massively parallel across
// docs, then Phase B (issue #31) drains staging serially against the Canon.

import { admit } from './admission';
import { dedup } from './dedup';
import type { CanonRepository, IngestProvider } from './ports';
import type { StagingPayload, StagingStore } from './staging-store';
import type { DistilledItem, Source } from './types';

export interface IngestResult {
  admitted: number;
  merged: number;
  review: number;
}

// Return shape for the Phase A head-only path. No `merged` because dedup does
// not run in Phase A; the two counts are what admit() produced.
export interface StageResult {
  admitted: number;
  review: number;
}

export async function ingestSource(
  source: Source,
  deps: { provider: IngestProvider; repository: CanonRepository },
): Promise<IngestResult> {
  const items = await deps.provider.distil({ title: source.title, text: source.text });
  return ingestDistilledItems(source, items, deps);
}

// Tail of the pipeline shared with multi-chunk ingest (issue #9). The
// orchestrator calls `provider.distil` per Marker section chunk and hands the
// merged item list here, so admission (locatability against the unified
// Source.text), embedding, dedup and persistence behave identically regardless
// of how the distillation was sliced upstream.
export async function ingestDistilledItems(
  source: Source,
  items: DistilledItem[],
  deps: { provider: IngestProvider; repository: CanonRepository },
): Promise<IngestResult> {
  const { provider, repository } = deps;
  await repository.upsertSource(source);

  const { principles, reviewCandidates } = admit(source, items, provider.provenance);

  if (principles.length > 0) {
    const embeddings = await provider.embed(principles.map((p) => p.claim));
    principles.forEach((p, i) => {
      p.embedding = embeddings[i]!;
    });
  }

  const { freshPrinciples, attachedQuotes, decisions } = await dedup(
    principles,
    source,
    provider.provenance,
    { provider, repository },
  );

  await repository.replacePrinciplesForSource(
    source.id,
    provider.provenance,
    freshPrinciples,
    { attachedQuotes, decisions },
  );
  if (reviewCandidates.length > 0) {
    await repository.addReviewCandidates(reviewCandidates);
  }

  return {
    admitted: freshPrinciples.length,
    merged: attachedQuotes.length,
    review: reviewCandidates.length,
  };
}

// Phase B per-Source entry point (issue #31, PRD #27, ADR-0014). Drains a
// single staged payload against the Canon-so-far: `dedup` → `replacePrinciplesForSource`
// + `addReviewCandidates`. Provenance is taken from the **payload**, not from
// `deps.provider.provenance` — that is the ADR-0014 guardrail against a
// Phase-B provider config that does not match Phase A's minting mismatched ID
// slots. `deps.provider` still supplies `confirmSameClaim` and `confirmModel`,
// where a different Phase-B model is expected (ADR-0013 lever 2 — confirm
// model is not part of the provenance tuple).
//
// `dedup.ts` is unchanged; the within-Source confirm pool (`confirmConcurrency`,
// ADR-0013) is forwarded through so the seed can raise it > 32 for Phase B.
// `replacePrinciplesForSource`'s (sourceId, provenance)-slot idempotency
// (ADR-0008) makes a crash between persist and mark safe to resume.
export async function dedupStagedSource(
  sourceId: string,
  payload: StagingPayload,
  deps: { provider: IngestProvider; repository: CanonRepository },
  options: { confirmConcurrency?: number } = {},
): Promise<IngestResult> {
  const source = await deps.repository.getSource(sourceId);
  if (!source) {
    throw new Error(
      `dedupStagedSource: source ${sourceId} is not in the repository — Phase A must upsert before staging`,
    );
  }

  const { freshPrinciples, attachedQuotes, decisions } = await dedup(
    payload.principles,
    source,
    payload.provenance,
    {
      provider: deps.provider,
      repository: deps.repository,
      ...(options.confirmConcurrency !== undefined
        ? { confirmConcurrency: options.confirmConcurrency }
        : {}),
    },
  );

  await deps.repository.replacePrinciplesForSource(
    sourceId,
    payload.provenance,
    freshPrinciples,
    { attachedQuotes, decisions },
  );
  if (payload.reviewCandidates.length > 0) {
    await deps.repository.addReviewCandidates(payload.reviewCandidates);
  }

  return {
    admitted: freshPrinciples.length,
    merged: attachedQuotes.length,
    review: payload.reviewCandidates.length,
  };
}

// Phase A entry point: distil + stage. Mirrors `ingestSource` but writes the
// admitted + embedded Principles (and any Review candidates) to the
// Canon-invisible StagingStore instead of running dedup + persisting. Called by
// the parallel Phase A driver over the planned Sources of the seed run.
export async function stageSource(
  source: Source,
  deps: { provider: IngestProvider; repository: CanonRepository; staging: StagingStore },
): Promise<StageResult> {
  const items = await deps.provider.distil({ title: source.title, text: source.text });
  return stageDistilledItems(source, items, deps);
}

// Head-only tail: upsertSource + admit + embed → StagingStore. Kept parallel to
// `ingestDistilledItems` so a caller with pre-distilled items (multi-chunk
// large-book path, or a Phase A driver that distilled elsewhere) can stage
// without re-distilling. No Canon read, no Canon write — the load-bearing
// guarantee that lets Phase A run massively parallel across Sources without
// racing the Canon (ADR-0014).
export async function stageDistilledItems(
  source: Source,
  items: DistilledItem[],
  deps: { provider: IngestProvider; repository: CanonRepository; staging: StagingStore },
): Promise<StageResult> {
  const { provider, repository, staging } = deps;
  await repository.upsertSource(source);

  const { principles, reviewCandidates } = admit(source, items, provider.provenance);

  if (principles.length > 0) {
    const embeddings = await provider.embed(principles.map((p) => p.claim));
    principles.forEach((p, i) => {
      p.embedding = embeddings[i]!;
    });
  }

  await staging.stage(source.id, provider.provenance, {
    provenance: provider.provenance,
    principles,
    reviewCandidates,
  });

  return {
    admitted: principles.length,
    review: reviewCandidates.length,
  };
}
