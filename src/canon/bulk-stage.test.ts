// bulkStage — Phase A driver over many Sources (issue #30, PRD #27, ADR-0014).
//
// Parallel-across-Sources counterpart to bulkIngest. The Phase A pool is the
// lever ADR-0014 uses to collapse the ~9-day serial-distil wall into ~hours;
// the same resumability + per-Source error capture contract as bulkIngest
// applies. Distil failures leave the Source unmarked (retried on resume); a
// legitimately zero-Principle Source is marked with an empty payload (never
// retried).

import { describe, expect, it } from 'vitest';

import {
  bulkStage,
  DEFAULT_STAGE_CONCURRENCY,
  InMemoryBulkProgressStore,
  type BulkStageJob,
} from './bulk-ingest';
import { FakeIngestProvider } from './fake-provider';
import { InMemoryRepository } from './in-memory-repository';
import { InMemoryStagingStore } from './staging-store';
import { stageSource } from './ingest';
import type { DistilInput } from './ports';
import type { Source } from './types';

function sermon(id: string, text: string): Source {
  return {
    id,
    title: `Sermon ${id}`,
    author: 'Pastor X',
    kind: 'sermon',
    date: '2026-06-23',
    text,
    r2Key: null,
    structureMap: { kind: 'none' },
    editionId: 'ed_seed',
  };
}

function oneClaimPerSource(input: DistilInput) {
  return [{ claim: `claim of ${input.title}.`, quote: input.text.split('\n')[0]! }];
}

function stageJob(
  source: Source,
  provider: FakeIngestProvider,
  repository: InMemoryRepository,
  staging: InMemoryStagingStore,
): BulkStageJob {
  return {
    sourceId: source.id,
    stage: () => stageSource(source, { provider, repository, staging }),
  };
}

describe('bulkStage', () => {
  it('defaults concurrency to the ADR-0014 Haiku target (~30)', () => {
    expect(DEFAULT_STAGE_CONCURRENCY).toBeGreaterThanOrEqual(16);
  });

  it('stages every Source and marks each done', async () => {
    const repository = new InMemoryRepository();
    const staging = new InMemoryStagingStore();
    const provider = new FakeIngestProvider(oneClaimPerSource);
    const progress = new InMemoryBulkProgressStore();
    const sources = [
      sermon('s1', 'Grace precedes obedience.'),
      sermon('s2', 'Service follows from love.'),
      sermon('s3', 'The empty seat is the assignment.'),
    ];

    const result = await bulkStage(
      sources.map((s) => stageJob(s, provider, repository, staging)),
      progress,
    );

    expect(result.completed.map((c) => c.sourceId).sort()).toEqual(['s1', 's2', 's3']);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.aborted).toBe(false);

    for (const id of ['s1', 's2', 's3']) {
      expect(await progress.has(id)).toBe(true);
      const payload = await staging.read(id, provider.provenance);
      expect(payload!.principles).toHaveLength(1);
    }
  });

  it('honours a bounded concurrency: at most `concurrency` distils are in flight at once', async () => {
    // Model a slow distil. The provider records concurrency high-water then
    // resolves. With concurrency=2 across 8 Sources, no more than 2 stage()
    // calls should be alive at any moment.
    const repository = new InMemoryRepository();
    const staging = new InMemoryStagingStore();
    let inFlight = 0;
    let peak = 0;
    const provider = new FakeIngestProvider(async (input: DistilInput) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return [{ claim: `claim of ${input.title}.`, quote: input.text.split('\n')[0]! }];
    });

    const sources = Array.from({ length: 8 }, (_, i) => sermon(`s${i}`, `text ${i}`));
    const result = await bulkStage(
      sources.map((s) => stageJob(s, provider, repository, staging)),
      new InMemoryBulkProgressStore(),
      { concurrency: 2 },
    );

    expect(result.completed).toHaveLength(8);
    expect(peak).toBeLessThanOrEqual(2);
    // Sanity: the pool actually did overlap work (single-file serial would peak at 1).
    expect(peak).toBeGreaterThan(1);
  });

  it('resume: pre-marked Sources are skipped and stage() is never called', async () => {
    const repository = new InMemoryRepository();
    const staging = new InMemoryStagingStore();
    const provider = new FakeIngestProvider(oneClaimPerSource);
    const progress = new InMemoryBulkProgressStore();
    await progress.mark('s1');
    await progress.mark('s2');

    const stageCalls: string[] = [];
    const sources = [sermon('s1', 'one'), sermon('s2', 'two'), sermon('s3', 'three')];
    const result = await bulkStage(
      sources.map((s) => ({
        sourceId: s.id,
        stage: async () => {
          stageCalls.push(s.id);
          return stageSource(s, { provider, repository, staging });
        },
      })),
      progress,
    );

    expect(stageCalls).toEqual(['s3']);
    expect(result.skipped.sort()).toEqual(['s1', 's2']);
    expect(result.completed.map((c) => c.sourceId)).toEqual(['s3']);
  });

  it('distil failure: the Source is captured in `failed` and left UNMARKED (retryable on resume)', async () => {
    const repository = new InMemoryRepository();
    const staging = new InMemoryStagingStore();
    const provider = new FakeIngestProvider(oneClaimPerSource);
    const progress = new InMemoryBulkProgressStore();

    const result = await bulkStage(
      [
        stageJob(sermon('s1', 'one'), provider, repository, staging),
        {
          sourceId: 's2',
          stage: async () => {
            throw new Error('distil failed: rate limit exhausted');
          },
        },
        stageJob(sermon('s3', 'three'), provider, repository, staging),
      ],
      progress,
    );

    // The failing Source lands in `failed`, the other two land in `completed`.
    expect(result.completed.map((c) => c.sourceId).sort()).toEqual(['s1', 's3']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.sourceId).toBe('s2');
    expect(result.failed[0]!.error).toContain('s2');
    expect(result.failed[0]!.error).toContain('distil failed');

    // Load-bearing: the failing Source is NOT marked → resume retries it.
    expect(await progress.has('s1')).toBe(true);
    expect(await progress.has('s2')).toBe(false);
    expect(await progress.has('s3')).toBe(true);
    expect(await staging.read('s2', provider.provenance)).toBeNull();
  });

  it('zero-Principle Source: staged with an empty payload AND marked done (not retried)', async () => {
    // ADR-0014's failure-vs-empty distinction: a distil that legitimately
    // returned no admissible items is a success — mark the Source so the
    // resume pass skips it, but the staged payload is empty so Phase B has
    // nothing to dedup.
    const repository = new InMemoryRepository();
    const staging = new InMemoryStagingStore();
    const emptyProvider = new FakeIngestProvider(() => []);
    const progress = new InMemoryBulkProgressStore();

    const result = await bulkStage(
      [stageJob(sermon('s1', 'one'), emptyProvider, repository, staging)],
      progress,
    );

    expect(result.completed).toHaveLength(1);
    expect(result.completed[0]!.result).toEqual({ admitted: 0, review: 0 });
    expect(await progress.has('s1')).toBe(true);

    const payload = await staging.read('s1', emptyProvider.provenance);
    expect(payload).not.toBeNull();
    expect(payload!.principles).toHaveLength(0);
  });

  it('abort mid-run: never marks the in-flight Source and returns aborted=true', async () => {
    // If the abort races an in-flight stage() throw, the throw is treated as
    // the interruption — Source stays unmarked, safe to retry on resume.
    const progress = new InMemoryBulkProgressStore();
    const ctrl = new AbortController();

    const result = await bulkStage(
      [
        {
          sourceId: 's1',
          stage: async () => {
            ctrl.abort();
            throw new Error('killed mid-stage');
          },
        },
      ],
      progress,
      { signal: ctrl.signal },
    );

    expect(result.aborted).toBe(true);
    expect(await progress.has('s1')).toBe(false);
  });

  it('re-running an interrupted stage-run resumes: only unstaged Sources re-run and none are duplicated', async () => {
    // First pass aborts after 2 successes; second pass with the same progress
    // store re-runs only the un-marked Sources and every Source is staged once.
    const repository = new InMemoryRepository();
    const staging = new InMemoryStagingStore();
    const provider = new FakeIngestProvider(oneClaimPerSource);
    const progress = new InMemoryBulkProgressStore();
    const sources = [
      sermon('s1', 'one'),
      sermon('s2', 'two'),
      sermon('s3', 'three'),
      sermon('s4', 'four'),
    ];

    // First pass: serial (concurrency=1) so we know exactly when to abort.
    const ctrl = new AbortController();
    let completed = 0;
    await bulkStage(
      sources.map((s) => ({
        sourceId: s.id,
        stage: async () => {
          const r = await stageSource(s, { provider, repository, staging });
          completed++;
          if (completed === 2) ctrl.abort();
          return r;
        },
      })),
      progress,
      { signal: ctrl.signal, concurrency: 1 },
    );

    const stagedAfterAbort = (await staging.listStaged()).map((e) => e.sourceId).sort();
    expect(stagedAfterAbort).toEqual(['s1', 's2']);

    // Resume with the same progress + staging stores.
    const stageCalls: string[] = [];
    const resumed = await bulkStage(
      sources.map((s) => ({
        sourceId: s.id,
        stage: async () => {
          stageCalls.push(s.id);
          return stageSource(s, { provider, repository, staging });
        },
      })),
      progress,
    );

    expect(stageCalls.sort()).toEqual(['s3', 's4']);
    expect(resumed.skipped.sort()).toEqual(['s1', 's2']);
    expect(resumed.completed.map((c) => c.sourceId).sort()).toEqual(['s3', 's4']);

    const finalStaged = (await staging.listStaged()).map((e) => e.sourceId).sort();
    expect(finalStaged).toEqual(['s1', 's2', 's3', 's4']);
  });
});
