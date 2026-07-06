// Conservative dedup (issue #5, ADR-0006).
//
// Vector prefilter + LLM confirm. A repeated idea across Sources attaches a
// new Quote to the existing Principle instead of duplicating it; a genuinely
// distinct framing stays a separate Principle. No human gate.
//
// Scope: CROSS-source only — the in-batch principles from this same source
// are not candidates for self-merge, and the repository query excludes the
// current sourceId so a re-ingest under a different provenance (ADR-0008
// model-mixed Canon) cannot collapse into itself.
//
// The rationale on every LLM consultation is persisted so the Owner can
// inspect dedup decisions (PRD AC #3).
//
// Concurrency (#23, PRD #21): confirms for distinct Principles within one
// Source run under a bounded worker pool — the wall-clock win is large
// because the candidate-pre-filter cap (~5) and break-on-first-`same`
// short-circuit make each Principle's confirm walk cheap, but ~265 such walks
// per Source were previously sequential. Within one Principle's candidate
// walk we KEEP the serial break-on-first short-circuit (fan-out would waste
// confirms on the merged-away tail). bulkIngest still runs Sources serially
// (ADR-0008 reproducibility — each Source dedups against a stable Canon
// snapshot).

import { provenanceTag } from './admission';
import type { CanonRepository, IngestProvider, SearchHit, SameClaimVerdict } from './ports';
import type {
  DedupDecision,
  DistilProvenance,
  LocatedQuote,
  Principle,
  Source,
} from './types';

// Bag-of-words cosine on a 128-d hash is approximate; the LLM confirm is the
// real authority. Set the prefilter low enough to catch paraphrases ("Grace
// comes before obedience") that share most content tokens.
export const DEFAULT_DEDUP_THRESHOLD = 0.4;

// Top-K candidates pulled per new Principle. 5 is enough to catch near-misses
// without ballooning LLM calls; the loop breaks on the first confirmed merge.
const DEFAULT_TOP_K = 5;

// Bounded pool for confirm fan-out across Principles within a Source. 8 keeps
// the OAuth-token rate bucket comfortable on Haiku while still collapsing the
// ~265 serial round-trips per Source into a handful of waves; the spike (#25)
// will measure P_max and the doctor/CLI can override per host.
export const DEFAULT_CONFIRM_CONCURRENCY = 8;

// 429 backoff. The Anthropic SDK retries internally (PRINCIPLEDB_MAX_RETRIES);
// this layer is the application-level safety net — if a confirm STILL throws
// 429 after SDK retries, we back off and retry inside the worker so the run
// completes rather than aborting on a transient burst.
const DEFAULT_CONFIRM_RETRIES = 5;
const DEFAULT_CONFIRM_RETRY_INITIAL_DELAY_MS = 250;

export interface DedupContext {
  provider: IngestProvider;
  repository: CanonRepository;
  threshold?: number;
  topK?: number;
  // Worker-pool size for confirm fan-out across Principles within a Source.
  // Defaults to DEFAULT_CONFIRM_CONCURRENCY. Set to 1 to recover the
  // pre-#23 serial loop (used by the parallel≡serial equivalence test).
  confirmConcurrency?: number;
  // Maximum extra attempts on HTTP 429 before propagating the error.
  confirmRetries?: number;
  // Initial backoff delay; doubles per retry.
  confirmRetryInitialDelayMs?: number;
}

export interface DedupResult {
  freshPrinciples: Principle[];
  attachedQuotes: LocatedQuote[];
  decisions: DedupDecision[];
}

interface PrincipleSlot {
  fresh?: Principle;
  attachedQuote?: LocatedQuote;
  decisions: DedupDecision[];
}

function isRateLimit(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  return (e as { status?: unknown }).status === 429;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function dedup(
  principles: Principle[],
  source: Source,
  provenance: DistilProvenance,
  ctx: DedupContext,
): Promise<DedupResult> {
  const threshold = ctx.threshold ?? DEFAULT_DEDUP_THRESHOLD;
  const topK = ctx.topK ?? DEFAULT_TOP_K;
  const concurrency = Math.max(1, ctx.confirmConcurrency ?? DEFAULT_CONFIRM_CONCURRENCY);
  const retries = Math.max(0, ctx.confirmRetries ?? DEFAULT_CONFIRM_RETRIES);
  const initialDelay = Math.max(
    0,
    ctx.confirmRetryInitialDelayMs ?? DEFAULT_CONFIRM_RETRY_INITIAL_DELAY_MS,
  );
  const tag = provenanceTag(provenance);

  // Captured once and stamped on every decision (#24, PRD #21). See
  // `IngestProvider.confirmModel` in ports.ts for why it stays outside the
  // (sourceId, provenance) slot key.
  const confirmModel = ctx.provider.confirmModel;

  // Decision IDs are derived purely from (principleIdx, candidateIdx) — no
  // shared mutable counter. Mirrors the already-safe `aq${idx}` attached-quote
  // ID scheme and keeps ADR-0008 idempotency intact under concurrency (#23):
  // the same (principle, candidate) position always mints the same ID
  // regardless of completion order in the worker pool.
  const buildDecision = (
    principleIdx: number,
    candidateIdx: number,
    candidate: SearchHit,
    candidateClaim: string,
    verdict: DedupDecision['verdict'],
    rationale: string,
  ): DedupDecision => ({
    id: `${source.id}#${tag}#d${principleIdx}_${candidateIdx}`,
    sourceId: source.id,
    candidateClaim,
    existingPrincipleId: candidate.principle.id,
    verdict,
    rationale,
    similarityScore: candidate.score,
    distilModel: provenance.distilModel,
    distilModelVersion: provenance.distilModelVersion,
    distilPromptVersion: provenance.distilPromptVersion,
    confirmModel,
  });

  const confirmWithBackoff = async (
    a: string,
    b: string,
  ): Promise<SameClaimVerdict> => {
    let delay = initialDelay;
    for (let attempt = 0; ; attempt++) {
      try {
        return await ctx.provider.confirmSameClaim(a, b);
      } catch (e) {
        if (!isRateLimit(e) || attempt >= retries) throw e;
        if (delay > 0) await sleep(delay);
        delay *= 2;
      }
    }
  };

  // Batched per-Source prefilter (#34, PRD #27). One round-trip fetches the
  // top-K candidates for every Principle in this Source instead of one query
  // per Principle. Semantically identical to the per-Principle call (same
  // threshold/topK/exclude-source) — the confirm loop below reads
  // candidatesByIdx[i] instead of re-querying. Removes ~1 pooler hop per
  // Principle, which the #33 spike identified as Phase B's real wall.
  const candidatesByIdx =
    principles.length > 0
      ? await ctx.repository.findSimilarPrinciplesForBatch(
          principles.map((p) => p.embedding),
          source.id,
          threshold,
          topK,
        )
      : [];

  const processPrinciple = async (idx: number): Promise<PrincipleSlot> => {
    const principle = principles[idx]!;
    const candidates = candidatesByIdx[idx] ?? [];

    if (candidates.length === 0) {
      return { fresh: principle, decisions: [] };
    }

    const decs: DedupDecision[] = [];
    for (const [cidx, candidate] of candidates.entries()) {
      const verdict = await confirmWithBackoff(principle.claim, candidate.principle.claim);
      if (!verdict.same) {
        decs.push(
          buildDecision(idx, cidx, candidate, principle.claim, 'kept-separate', verdict.rationale),
        );
        continue;
      }
      // Attach this source's Quote to the existing Principle. The Quote ID
      // is provenance-scoped to (sourceId, provenance, idx) so a re-ingest
      // under the same provenance writes the same row again (idempotent),
      // and a re-ingest under a different provenance is additive (distinct
      // ID).
      const original = principle.quotes[0]!;
      const attachedQuote: LocatedQuote = {
        ...original,
        id: `${source.id}#${tag}#aq${idx}`,
        principleId: candidate.principle.id,
      };
      decs.push(
        buildDecision(idx, cidx, candidate, principle.claim, 'merged', verdict.rationale),
      );
      return { attachedQuote, decisions: decs };
    }

    return { fresh: principle, decisions: decs };
  };

  // Bounded worker pool. Result slots are indexed by principle position, not
  // completion order, so the flattened output is byte-identical to the serial
  // loop regardless of scheduling — the "provably equivalent" guarantee.
  const slots = new Array<PrincipleSlot>(principles.length);
  let nextIdx = 0;
  const worker = async () => {
    while (true) {
      const i = nextIdx++;
      if (i >= principles.length) return;
      slots[i] = await processPrinciple(i);
    }
  };
  const workerCount = Math.min(concurrency, principles.length);
  await Promise.all(Array.from({ length: workerCount }, worker));

  const freshPrinciples: Principle[] = [];
  const attachedQuotes: LocatedQuote[] = [];
  const decisions: DedupDecision[] = [];
  for (const slot of slots) {
    if (slot.fresh) freshPrinciples.push(slot.fresh);
    if (slot.attachedQuote) attachedQuotes.push(slot.attachedQuote);
    decisions.push(...slot.decisions);
  }

  return { freshPrinciples, attachedQuotes, decisions };
}
