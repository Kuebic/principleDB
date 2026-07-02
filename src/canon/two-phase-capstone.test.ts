// Two-phase seed capstone (issue #32, PRD #27, ADR-0014).
//
// Correctness gate for the two-phase split earned across #29/#30/#31: proves
// end-to-end that Phase A (stage) then Phase B (drain) produces the same Canon
// today's single-phase `ingestSource` loop would for the same scripted distil
// results, plus the cross-phase resumability guarantees. Everything runs
// through `FakeIngestProvider` + `InMemoryRepository` + `InMemoryStagingStore` +
// `InMemoryBulkProgressStore` — no DB, no network.
//
// The load-bearing claims (mirroring the AC on #32):
//   - Two-phase ≡ single-phase: byte-identical Canon for the same distil results.
//   - Plan-order determinism: shuffling Phase-A completion order does not
//     change Phase-B merges (order comes from the plan replay).
//   - Phase-A resumability: a mid-Phase-A crash re-distils only unmarked.
//   - Phase-B resumability: a mid-Phase-B crash re-dedups only unmarked.
//   - Failure vs. empty: a distil failure is retryable; an empty distil is not.
//   - Canon-invisibility under drain: during Phase B, a Source's candidates
//     never include a staged-but-not-yet-deduped sibling.

import { describe, expect, it } from 'vitest';

import {
  bulkDedup,
  bulkIngest,
  bulkStage,
  InMemoryBulkProgressStore,
  type BulkDedupJob,
  type BulkIngestJob,
  type BulkStageJob,
} from './bulk-ingest';
import { FakeIngestProvider, type DistilScript, type SameClaimScript } from './fake-provider';
import { dedupStagedSource, ingestSource, stageSource } from './ingest';
import { InMemoryRepository } from './in-memory-repository';
import { InMemoryStagingStore } from './staging-store';
import type { DistilInput, SameClaimVerdict } from './ports';
import type { DedupDecision, DistilProvenance, LocatedQuote, ReviewCandidate, Source } from './types';

// ---------- Fixture ----------
//
// Plan-walk order is [s1, s2, s3, s4]. The scripted distils exercise every
// branch a single dedup pass can take:
//   - s1: two fresh admits (nothing in the Canon yet) + one unlocatable → Review.
//   - s2: one merge into s1's "Grace precedes obedience", one kept-separate that
//     tripped the prefilter but the LLM said no.
//   - s3: one fresh admit (unrelated wording, no candidates).
//   - s4: one merge into s1's Grace (targets the same Principle again).

function mkSource(id: string, text: string): Source {
  return {
    id,
    title: `Sermon ${id}`,
    author: 'Pastor X',
    kind: 'sermon',
    date: '2026-06-23',
    text,
    r2Key: null,
    structureMap: { kind: 'none' },
  };
}

const s1 = mkSource(
  's1',
  [
    'Grace precedes obedience.',
    'Faith without works is dead.',
    'Real prose — no invented pull quote here.',
  ].join(' '),
);
const s2 = mkSource(
  's2',
  'Grace precedes obedience here too. Distinct grace obedience framing follows.',
);
const s3 = mkSource('s3', 'The empty seat is the assignment for us today.');
const s4 = mkSource('s4', 'Grace precedes obedience once more, restated.');

const PLAN_ORDER: Source[] = [s1, s2, s3, s4];

const distilByTitle: Record<string, DistilScript> = {
  [s1.title]: () => [
    { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
    { claim: 'Faith without works is dead.', quote: 'Faith without works is dead.' },
    // Quote text is not a verbatim slice of s1.text → routed to Review.
    { claim: 'Invented drift.', quote: 'A completely fabricated span that is not in the source.' },
  ],
  [s2.title]: () => [
    { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience here too.' },
    { claim: 'Distinct grace obedience framing.', quote: 'Distinct grace obedience framing follows.' },
  ],
  [s3.title]: () => [
    { claim: 'The empty seat is the assignment.', quote: 'The empty seat is the assignment for us today.' },
  ],
  [s4.title]: () => [
    { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience once more, restated.' },
  ],
};

const scriptedDistil = (input: DistilInput) => {
  const s = distilByTitle[input.title];
  if (!s) throw new Error(`no scripted distil for ${input.title}`);
  return s(input);
};

// Same-claim verdict script: merge only exact "Grace precedes obedience." vs
// itself. Anything else stays kept-separate. Deterministic and independent of
// call order — needed for the shuffle test to preserve equivalence.
const verdictScript: SameClaimScript = (a: string, _b: string): SameClaimVerdict =>
  a === 'Grace precedes obedience.'
    ? { same: true, rationale: 'identical claim wording' }
    : { same: false, rationale: 'distinct framing' };

function mkProvider(distil: DistilScript = scriptedDistil): FakeIngestProvider {
  return new FakeIngestProvider(distil, undefined, undefined, verdictScript);
}

// ---------- Snapshot helper ----------
//
// The AC asks for byte-identical output. Comparing the raw Canon state gives us
// exactly that — same Principles (with their attached Quotes joined in), same
// dedup_decision rows, same Review candidates. Everything is sorted by ID so
// insertion order across the two runs is not a confound; every ID is
// deterministic from (sourceId, provenance, idx) via ADR-0008 so this is a
// true equivalence check, not a "close enough" one.

interface CanonSnapshot {
  principles: Array<{
    id: string;
    claim: string;
    quotes: LocatedQuote[];
    distilModel: string;
    distilModelVersion: string;
    distilPromptVersion: string;
  }>;
  decisions: DedupDecision[];
  review: ReviewCandidate[];
}

async function snapshotCanon(repository: InMemoryRepository): Promise<CanonSnapshot> {
  // A high-limit vector search enumerates every Principle (with its attached
  // Quotes joined in) — the exact observable Canon the MCP tools see.
  const query = new Array(128).fill(0) as number[];
  query[0] = 1;
  const hits = await repository.searchByEmbedding(query, 10_000);
  const principles = hits
    .map((h) => ({
      id: h.principle.id,
      claim: h.principle.claim,
      quotes: [...h.principle.quotes].sort((a, b) => a.id.localeCompare(b.id)),
      distilModel: h.principle.distilModel,
      distilModelVersion: h.principle.distilModelVersion,
      distilPromptVersion: h.principle.distilPromptVersion,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const decisions = [...repository.dedupDecisions()].sort((a, b) => a.id.localeCompare(b.id));
  const review = [...repository.reviewCandidates()].sort((a, b) => a.id.localeCompare(b.id));
  return { principles, decisions, review };
}

// ---------- Run harnesses ----------

async function runSinglePhase(order: Source[]): Promise<InMemoryRepository> {
  const repository = new InMemoryRepository();
  const provider = mkProvider();
  const jobs: BulkIngestJob[] = order.map((s) => ({
    sourceId: s.id,
    ingest: () => ingestSource(s, { provider, repository }),
  }));
  await bulkIngest(jobs, new InMemoryBulkProgressStore());
  return repository;
}

// Build Phase-B dedup jobs from staging in plan-walk order: each job reads
// the payload, dedups against the Canon-so-far, and deletes the staging row.
// Sources absent from staging (e.g. Phase A failed for them) are skipped.
async function buildDedupJobs(
  order: Source[],
  staging: InMemoryStagingStore,
  deps: { provider: FakeIngestProvider; repository: InMemoryRepository },
): Promise<BulkDedupJob[]> {
  const stagedProv = new Map<string, DistilProvenance>(
    (await staging.listStaged()).map((e) => [e.sourceId, e.provenance] as const),
  );
  return order.flatMap((s) => {
    const prov = stagedProv.get(s.id);
    if (prov === undefined) return [];
    return [{
      sourceId: s.id,
      dedup: async () => {
        const payload = await staging.read(s.id, prov);
        const result = await dedupStagedSource(s.id, payload!, deps);
        await staging.delete(s.id, prov);
        return result;
      },
    }];
  });
}

async function runTwoPhase(
  order: Source[],
  options: { stageConcurrency?: number; stageDelayMs?: (source: Source) => number } = {},
): Promise<{ repository: InMemoryRepository; staging: InMemoryStagingStore }> {
  const repository = new InMemoryRepository();
  const staging = new InMemoryStagingStore();
  const provider = mkProvider(async (input) => {
    const delayMs = options.stageDelayMs?.(order.find((s) => s.title === input.title)!) ?? 0;
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return scriptedDistil(input);
  });

  // Phase A — parallel stage.
  const stageJobs: BulkStageJob[] = order.map((s) => ({
    sourceId: s.id,
    stage: () => stageSource(s, { provider, repository, staging }),
  }));
  await bulkStage(stageJobs, new InMemoryBulkProgressStore(), {
    ...(options.stageConcurrency !== undefined ? { concurrency: options.stageConcurrency } : {}),
  });

  // Phase B — serial drain in PLAN-WALK order (not staging insertion order).
  const dedupJobs = await buildDedupJobs(order, staging, { provider, repository });
  await bulkDedup(dedupJobs, new InMemoryBulkProgressStore());

  return { repository, staging };
}

// ---------- Tests ----------

describe('two-phase seed capstone (issue #32, PRD #27, ADR-0014)', () => {
  it('two-phase ≡ single-phase: byte-identical Canon for the same scripted distil', async () => {
    const singleRepo = await runSinglePhase(PLAN_ORDER);
    const { repository: twoRepo, staging } = await runTwoPhase(PLAN_ORDER);

    // Staging is fully drained after Phase B.
    expect(await staging.listStaged()).toEqual([]);

    const single = await snapshotCanon(singleRepo);
    const two = await snapshotCanon(twoRepo);
    expect(two).toEqual(single);

    // Sanity: the fixture actually exercises the branches this test claims.
    const verdicts = single.decisions.map((d) => d.verdict);
    expect(verdicts).toContain('merged');
    expect(verdicts).toContain('kept-separate');
    expect(single.review.length).toBeGreaterThan(0);
    // s1's Grace principle collected quotes from s1, s2, s4 → 3 quotes total.
    const grace = single.principles.find((p) => p.claim === 'Grace precedes obedience.');
    expect(grace).toBeDefined();
    expect(grace!.quotes.map((q) => q.sourceId).sort()).toEqual(['s1', 's2', 's4']);
  });

  it('plan-order determinism: shuffled Phase-A completion order → identical Canon', async () => {
    // Sanity-check that Phase-A worker scheduling has no effect on Phase-B
    // output. Run two-phase twice: once with a fast->slow completion order
    // (short Sources finish first) and once with the reverse (long Sources
    // finish first). Phase B walks the same plan order both times, so the
    // Canon must be byte-identical.
    const fastFirst = await runTwoPhase(PLAN_ORDER, {
      stageConcurrency: 4,
      stageDelayMs: (s) => s.id.charCodeAt(1) * 3, // s1=147, s2=150, ... increasing
    });
    const slowFirst = await runTwoPhase(PLAN_ORDER, {
      stageConcurrency: 4,
      stageDelayMs: (s) => 200 - s.id.charCodeAt(1) * 3, // reverse
    });
    const a = await snapshotCanon(fastFirst.repository);
    const b = await snapshotCanon(slowFirst.repository);
    expect(a).toEqual(b);
  });

  it('Phase-A resumability: a mid-Phase-A crash re-distils only unmarked Sources', async () => {
    // Run Phase A serially so we know exactly when to abort — after two
    // completions. Resume against the same progress + staging stores. Every
    // Source ends up staged exactly once; the un-marked pair re-distils.
    const repository = new InMemoryRepository();
    const staging = new InMemoryStagingStore();
    const progress = new InMemoryBulkProgressStore();

    const distilCallsRun1: string[] = [];
    const provider1 = mkProvider((input) => {
      distilCallsRun1.push(input.title);
      return scriptedDistil(input);
    });

    const ctrl = new AbortController();
    let completed = 0;
    await bulkStage(
      PLAN_ORDER.map((s) => ({
        sourceId: s.id,
        stage: async () => {
          const r = await stageSource(s, { provider: provider1, repository, staging });
          completed++;
          if (completed === 2) ctrl.abort();
          return r;
        },
      })),
      progress,
      { signal: ctrl.signal, concurrency: 1 },
    );

    expect(distilCallsRun1.sort()).toEqual([s1.title, s2.title].sort());
    const afterAbort = (await staging.listStaged()).map((e) => e.sourceId).sort();
    expect(afterAbort).toEqual(['s1', 's2']);

    // Resume: the same progress store skips s1, s2; only s3, s4 re-distil.
    const distilCallsRun2: string[] = [];
    const provider2 = mkProvider((input) => {
      distilCallsRun2.push(input.title);
      return scriptedDistil(input);
    });
    await bulkStage(
      PLAN_ORDER.map((s) => ({
        sourceId: s.id,
        stage: () => stageSource(s, { provider: provider2, repository, staging }),
      })),
      progress,
    );

    expect(distilCallsRun2.sort()).toEqual([s3.title, s4.title].sort());
    const finalStaged = (await staging.listStaged()).map((e) => e.sourceId).sort();
    expect(finalStaged).toEqual(['s1', 's2', 's3', 's4']);
  });

  it('Phase-B resumability: a mid-Phase-B crash re-dedups only unmarked, final Canon matches uninterrupted', async () => {
    const stagePhaseA = async () => {
      const repository = new InMemoryRepository();
      const staging = new InMemoryStagingStore();
      const provider = mkProvider();
      await bulkStage(
        PLAN_ORDER.map((s) => ({
          sourceId: s.id,
          stage: () => stageSource(s, { provider, repository, staging }),
        })),
        new InMemoryBulkProgressStore(),
      );
      return { repository, staging, provider };
    };

    // Uninterrupted reference — the Canon a clean Phase B produces.
    const clean = await stagePhaseA();
    await bulkDedup(
      await buildDedupJobs(PLAN_ORDER, clean.staging, {
        provider: clean.provider,
        repository: clean.repository,
      }),
      new InMemoryBulkProgressStore(),
    );
    const reference = await snapshotCanon(clean.repository);

    // Interrupted run — same fixture, abort after 2 drains, then resume.
    const inter = await stagePhaseA();
    const interIndex = new Map(
      (await inter.staging.listStaged()).map((e) => [e.sourceId, e.provenance] as const),
    );
    const dedupProgress = new InMemoryBulkProgressStore();
    const ctrl = new AbortController();
    let drained = 0;
    await bulkDedup(
      PLAN_ORDER.map((s) => ({
        sourceId: s.id,
        dedup: async () => {
          const prov = interIndex.get(s.id)!;
          const payload = await inter.staging.read(s.id, prov);
          const r = await dedupStagedSource(s.id, payload!, {
            provider: inter.provider,
            repository: inter.repository,
          });
          await inter.staging.delete(s.id, prov);
          drained++;
          if (drained === 2) ctrl.abort();
          return r;
        },
      })),
      dedupProgress,
      { signal: ctrl.signal },
    );
    expect(await dedupProgress.has('s1')).toBe(true);
    expect(await dedupProgress.has('s2')).toBe(true);
    expect(await dedupProgress.has('s3')).toBe(false);
    expect(await dedupProgress.has('s4')).toBe(false);

    // Resume — the two already-marked Sources are skipped, s3 and s4 drain.
    const dedupCalls: string[] = [];
    await bulkDedup(
      PLAN_ORDER.map((s) => ({
        sourceId: s.id,
        dedup: async () => {
          dedupCalls.push(s.id);
          const prov = interIndex.get(s.id)!;
          const payload = await inter.staging.read(s.id, prov);
          const r = await dedupStagedSource(s.id, payload!, {
            provider: inter.provider,
            repository: inter.repository,
          });
          await inter.staging.delete(s.id, prov);
          return r;
        },
      })),
      dedupProgress,
    );
    expect(dedupCalls).toEqual(['s3', 's4']);

    // Final Canon matches the uninterrupted reference — no double-writes, no
    // missing merges, decisions with the same IDs and verdicts.
    const resumed = await snapshotCanon(inter.repository);
    expect(resumed).toEqual(reference);
  });

  it('failure vs empty: a Phase-A distil failure is retryable; a zero-Principle Source is marked and not', async () => {
    const repository = new InMemoryRepository();
    const staging = new InMemoryStagingStore();
    const progress = new InMemoryBulkProgressStore();

    // Two Sources: one whose distil throws, one whose distil returns an empty
    // list. Both go through the same driver call.
    let failThrows = 0;
    const provider = mkProvider(async (input) => {
      if (input.title === s1.title) {
        failThrows++;
        throw new Error('distil failed: rate limit exhausted');
      }
      if (input.title === s2.title) return []; // legitimately zero-Principle
      return scriptedDistil(input);
    });

    const stageResult = await bulkStage(
      [
        { sourceId: s1.id, stage: () => stageSource(s1, { provider, repository, staging }) },
        { sourceId: s2.id, stage: () => stageSource(s2, { provider, repository, staging }) },
      ],
      progress,
    );

    // Failing Source: captured in `failed`, UNMARKED, no staging row.
    expect(stageResult.failed.map((f) => f.sourceId)).toEqual(['s1']);
    expect(await progress.has(s1.id)).toBe(false);
    expect(await staging.read(s1.id, provider.provenance)).toBeNull();

    // Empty Source: staged with an empty payload AND marked done.
    expect(stageResult.completed.map((c) => c.sourceId)).toEqual(['s2']);
    expect(await progress.has(s2.id)).toBe(true);
    const emptyPayload = await staging.read(s2.id, provider.provenance);
    expect(emptyPayload).not.toBeNull();
    expect(emptyPayload!.principles).toEqual([]);

    // Resume Phase A with a distil that succeeds — only s1 re-runs; s2 is not
    // retried (its mark is load-bearing here).
    const distilOnResume: string[] = [];
    const provider2 = mkProvider((input) => {
      distilOnResume.push(input.title);
      // If s2 were retried, this would throw because the failing branch is gone.
      return scriptedDistil(input);
    });
    await bulkStage(
      [
        { sourceId: s1.id, stage: () => stageSource(s1, { provider: provider2, repository, staging }) },
        { sourceId: s2.id, stage: () => stageSource(s2, { provider: provider2, repository, staging }) },
      ],
      progress,
    );
    expect(distilOnResume).toEqual([s1.title]);
    expect(failThrows).toBe(1);

    // Drain Phase B against what's in staging. The empty s2 payload contributes
    // nothing to the Canon; s1's distil results land.
    await bulkDedup(
      await buildDedupJobs([s1, s2], staging, { provider: provider2, repository }),
      new InMemoryBulkProgressStore(),
    );
    const snap = await snapshotCanon(repository);
    const countPrinciples = (sourceId: string) =>
      snap.principles.filter((p) => p.id.startsWith(`${sourceId}#`)).length;
    expect(countPrinciples('s1')).toBe(2); // Grace + Faith
    expect(countPrinciples('s2')).toBe(0); // empty distil contributed nothing
  });

  it('Canon-invisibility under drain: staged-but-not-yet-deduped siblings are not dedup candidates', async () => {
    // The load-bearing guarantee behind ADR-0014's Canon-independence split.
    // Two Sources whose Grace claims would collide are both staged. Phase B
    // walks in plan order; when draining s2, s1's Principle should already be
    // in the Canon so s2's Grace attaches. But when draining s1, s2's staged
    // payload MUST be invisible — no candidates, no confirm calls.
    const repository = new InMemoryRepository();
    const staging = new InMemoryStagingStore();
    let confirmCalls = 0;
    const provider = new FakeIngestProvider(
      (input) => {
        if (input.title === s1.title)
          return [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }];
        if (input.title === s2.title)
          return [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience here too.' }];
        return [];
      },
      undefined,
      undefined,
      (_a: string, _b: string) => {
        confirmCalls++;
        return { same: true, rationale: 'identical' };
      },
    );

    // Phase A stages both.
    await bulkStage(
      [
        { sourceId: s1.id, stage: () => stageSource(s1, { provider, repository, staging }) },
        { sourceId: s2.id, stage: () => stageSource(s2, { provider, repository, staging }) },
      ],
      new InMemoryBulkProgressStore(),
    );

    // Drain s1 first. Both payloads sit in staging; s2's Grace principle must
    // NOT be a candidate for s1's dedup, so no confirm call fires.
    const prov1 = provider.provenance;
    const payload1 = await staging.read(s1.id, prov1);
    await dedupStagedSource(s1.id, payload1!, { provider, repository });
    expect(confirmCalls).toBe(0);

    // Drain s2. Now s1 IS in the Canon; s2's Grace attaches — one confirm call.
    const payload2 = await staging.read(s2.id, prov1);
    const r2 = await dedupStagedSource(s2.id, payload2!, { provider, repository });
    expect(confirmCalls).toBe(1);
    expect(r2).toEqual({ admitted: 0, merged: 1, review: 0 });

    // Final Canon: one Grace Principle with quotes from both Sources.
    const snap = await snapshotCanon(repository);
    const grace = snap.principles.find((p) => p.claim === 'Grace precedes obedience.');
    expect(grace).toBeDefined();
    expect(grace!.quotes.map((q) => q.sourceId).sort()).toEqual(['s1', 's2']);
  });
});
