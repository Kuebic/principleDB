// bulkDedup — Phase B driver over many Sources (issue #31, PRD #27, ADR-0014).
//
// Serial-across-Sources counterpart to `bulkStage`. Where Phase A runs distil
// under a parallel pool (Canon-independent), Phase B runs dedup one Source at
// a time in plan-walk order so each Source dedups against a stable Canon
// snapshot (ADR-0008 first-Source-wins). The within-Source confirm pool
// (ADR-0013) is unchanged and lives inside `dedup()`; this driver just walks
// the queue.
//
// Same resumability + failure-capture contract as `bulkIngest`: a Source is
// marked done ONLY after its `dedup()` thunk returns; per-Source errors land
// in `failed`; an `AbortSignal` mid-run leaves the in-flight Source unmarked
// and reports `aborted: true`.

import { describe, expect, it } from 'vitest';

import {
  bulkDedup,
  InMemoryBulkProgressStore,
  type BulkDedupJob,
} from './bulk-ingest';
import type { IngestResult } from './ingest';

function job(sourceId: string, result: IngestResult): BulkDedupJob {
  return { sourceId, dedup: async () => result };
}

describe('bulkDedup', () => {
  it('drains every Source in the given order and marks each done', async () => {
    const progress = new InMemoryBulkProgressStore();
    const order: string[] = [];
    const result = await bulkDedup(
      [
        { sourceId: 's1', dedup: async () => { order.push('s1'); return { admitted: 1, merged: 0, review: 0 }; } },
        { sourceId: 's2', dedup: async () => { order.push('s2'); return { admitted: 0, merged: 1, review: 0 }; } },
        { sourceId: 's3', dedup: async () => { order.push('s3'); return { admitted: 1, merged: 0, review: 1 }; } },
      ],
      progress,
    );

    // Order matches input — the plan walk order Phase B is handed.
    expect(order).toEqual(['s1', 's2', 's3']);
    expect(result.completed.map((c) => c.sourceId)).toEqual(['s1', 's2', 's3']);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.aborted).toBe(false);
    for (const id of ['s1', 's2', 's3']) {
      expect(await progress.has(id)).toBe(true);
    }
  });

  it('runs Sources strictly serially — never overlaps two dedup() calls', async () => {
    // Load-bearing for ADR-0008: parallelism across Sources would race the
    // Canon (two dedups could each miss the other's Principles). Assert here
    // that no two thunks are ever alive at the same moment.
    let inFlight = 0;
    let peak = 0;
    const slow = (id: string): BulkDedupJob => ({
      sourceId: id,
      dedup: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { admitted: 1, merged: 0, review: 0 };
      },
    });

    await bulkDedup(
      Array.from({ length: 6 }, (_, i) => slow(`s${i}`)),
      new InMemoryBulkProgressStore(),
    );
    expect(peak).toBe(1);
  });

  it('resume: pre-marked Sources are skipped and dedup() is never called', async () => {
    const progress = new InMemoryBulkProgressStore();
    await progress.mark('s1');
    await progress.mark('s2');
    const dedupCalls: string[] = [];

    const result = await bulkDedup(
      [
        { sourceId: 's1', dedup: async () => { dedupCalls.push('s1'); return { admitted: 0, merged: 0, review: 0 }; } },
        { sourceId: 's2', dedup: async () => { dedupCalls.push('s2'); return { admitted: 0, merged: 0, review: 0 }; } },
        { sourceId: 's3', dedup: async () => { dedupCalls.push('s3'); return { admitted: 1, merged: 0, review: 0 }; } },
      ],
      progress,
    );

    expect(dedupCalls).toEqual(['s3']);
    expect(result.skipped.sort()).toEqual(['s1', 's2']);
    expect(result.completed.map((c) => c.sourceId)).toEqual(['s3']);
  });

  it('a dedup failure lands in `failed` and leaves the Source unmarked (retryable on resume)', async () => {
    const progress = new InMemoryBulkProgressStore();

    const result = await bulkDedup(
      [
        job('s1', { admitted: 1, merged: 0, review: 0 }),
        {
          sourceId: 's2',
          dedup: async () => {
            throw new Error('confirm 429 — retries exhausted');
          },
        },
        job('s3', { admitted: 1, merged: 0, review: 0 }),
      ],
      progress,
    );

    expect(result.completed.map((c) => c.sourceId).sort()).toEqual(['s1', 's3']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.sourceId).toBe('s2');
    expect(result.failed[0]!.error).toContain('s2');
    expect(result.failed[0]!.error).toContain('confirm 429');

    // Load-bearing: the failing Source is NOT marked → resume retries it.
    expect(await progress.has('s1')).toBe(true);
    expect(await progress.has('s2')).toBe(false);
    expect(await progress.has('s3')).toBe(true);
  });

  it('abort mid-run: never marks the in-flight Source and reports aborted=true', async () => {
    const progress = new InMemoryBulkProgressStore();
    const ctrl = new AbortController();

    const result = await bulkDedup(
      [
        {
          sourceId: 's1',
          dedup: async () => {
            ctrl.abort();
            throw new Error('killed mid-dedup');
          },
        },
      ],
      progress,
      { signal: ctrl.signal },
    );

    expect(result.aborted).toBe(true);
    expect(await progress.has('s1')).toBe(false);
  });

  it('resumes an interrupted run: only unfinished Sources re-run, none are double-persisted', async () => {
    // First pass aborts after 2 completions; second pass with the same
    // progress store re-runs only the un-marked Sources.
    const progress = new InMemoryBulkProgressStore();
    const sources = ['s1', 's2', 's3', 's4'];

    const ctrl = new AbortController();
    let completed = 0;
    await bulkDedup(
      sources.map((id) => ({
        sourceId: id,
        dedup: async () => {
          completed++;
          if (completed === 2) ctrl.abort();
          return { admitted: 1, merged: 0, review: 0 };
        },
      })),
      progress,
      { signal: ctrl.signal },
    );

    expect(await progress.has('s1')).toBe(true);
    expect(await progress.has('s2')).toBe(true);
    expect(await progress.has('s3')).toBe(false);
    expect(await progress.has('s4')).toBe(false);

    const dedupCalls: string[] = [];
    const resumed = await bulkDedup(
      sources.map((id) => ({
        sourceId: id,
        dedup: async () => {
          dedupCalls.push(id);
          return { admitted: 1, merged: 0, review: 0 };
        },
      })),
      progress,
    );

    expect(dedupCalls).toEqual(['s3', 's4']);
    expect(resumed.skipped.sort()).toEqual(['s1', 's2']);
    expect(resumed.completed.map((c) => c.sourceId).sort()).toEqual(['s3', 's4']);
    expect(resumed.failed).toEqual([]);
  });
});
