import { describe, expect, it } from 'vitest';
import {
  bulkIngest,
  InMemoryBulkProgressStore,
  type BulkIngestJob,
} from './bulk-ingest';
import { FakeIngestProvider } from './fake-provider';
import { ingestSource } from './ingest';
import { InMemoryRepository } from './in-memory-repository';
import { searchPrinciples } from './search';
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
  };
}

function oneClaimPerSource(input: DistilInput) {
  return [{ claim: `claim of ${input.title}.`, quote: input.text.split('\n')[0]! }];
}

function makeJob(
  source: Source,
  provider: FakeIngestProvider,
  repository: InMemoryRepository,
): BulkIngestJob {
  return {
    sourceId: source.id,
    ingest: () => ingestSource(source, { provider, repository }),
  };
}

describe('bulkIngest', () => {
  it('completes a mixed batch and persists every Source', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(oneClaimPerSource);
    const sources = [
      sermon('s1', 'Grace precedes obedience.'),
      sermon('s2', 'Service follows from love.'),
      sermon('s3', 'The empty seat is the assignment.'),
    ];

    const result = await bulkIngest(
      sources.map((s) => makeJob(s, provider, repository)),
      new InMemoryBulkProgressStore(),
    );

    expect(result.completed.map((c) => c.sourceId)).toEqual(['s1', 's2', 's3']);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.aborted).toBe(false);

    const hits = await searchPrinciples('claim', { provider, repository, limit: 100 });
    expect(hits).toHaveLength(3);
  });

  it('re-running the same batch produces no duplicate Principles (idempotent)', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(oneClaimPerSource);
    const sources = [sermon('s1', 'one'), sermon('s2', 'two')];

    // Each run uses a FRESH progress store so the orchestrator re-runs every
    // job — the idempotency we are asserting is the per-Source one provided by
    // `replacePrinciplesForSource`, not progress-store skipping.
    await bulkIngest(
      sources.map((s) => makeJob(s, provider, repository)),
      new InMemoryBulkProgressStore(),
    );
    await bulkIngest(
      sources.map((s) => makeJob(s, provider, repository)),
      new InMemoryBulkProgressStore(),
    );

    const hits = await searchPrinciples('claim', { provider, repository, limit: 100 });
    expect(hits).toHaveLength(2);
  });

  it('a failing Source yields a clear, actionable error and does not abort the batch', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(oneClaimPerSource);

    const result = await bulkIngest(
      [
        makeJob(sermon('s1', 'one'), provider, repository),
        {
          sourceId: 's2',
          ingest: async () => {
            throw new Error('OCR failed: Marker exited with code 1 — see logs/s2.log');
          },
        },
        makeJob(sermon('s3', 'three'), provider, repository),
      ],
      new InMemoryBulkProgressStore(),
    );

    expect(result.completed.map((c) => c.sourceId)).toEqual(['s1', 's3']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.sourceId).toBe('s2');
    expect(result.failed[0]!.error).toContain('s2');
    expect(result.failed[0]!.error).toContain('OCR failed');

    // The Canon kept the two good Sources; the failing one did not land.
    const hits = await searchPrinciples('claim', { provider, repository, limit: 100 });
    expect(hits).toHaveLength(2);
  });

  it('interrupt mid-batch, resume, and assert no duplicates plus all good Sources landed', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(oneClaimPerSource);
    const progress = new InMemoryBulkProgressStore();
    const sources = [
      sermon('s1', 'one'),
      sermon('s2', 'two'),
      sermon('s3', 'three'),
      sermon('s4', 'four'),
    ];

    // First pass: abort after s2 completes — s3 and s4 never run.
    const ctrl = new AbortController();
    const partial = await bulkIngest(
      sources.map((s) => ({
        sourceId: s.id,
        ingest: async () => {
          const r = await ingestSource(s, { provider, repository });
          if (s.id === 's2') ctrl.abort();
          return r;
        },
      })),
      progress,
      { signal: ctrl.signal },
    );

    expect(partial.aborted).toBe(true);
    expect(partial.completed.map((c) => c.sourceId)).toEqual(['s1', 's2']);
    expect(await progress.has('s1')).toBe(true);
    expect(await progress.has('s2')).toBe(true);
    expect(await progress.has('s3')).toBe(false);
    expect(await progress.has('s4')).toBe(false);

    // Second pass: full batch with the SAME progress store — done sources are
    // skipped, only s3/s4 actually run, and the Canon ends with exactly 4
    // Principles (no duplicates from re-attempting s1/s2).
    const ingestCalls: string[] = [];
    const resumed = await bulkIngest(
      sources.map((s) => ({
        sourceId: s.id,
        ingest: async () => {
          ingestCalls.push(s.id);
          return ingestSource(s, { provider, repository });
        },
      })),
      progress,
    );

    expect(ingestCalls).toEqual(['s3', 's4']);
    expect(resumed.skipped).toEqual(['s1', 's2']);
    expect(resumed.completed.map((c) => c.sourceId)).toEqual(['s3', 's4']);
    expect(resumed.failed).toEqual([]);
    expect(resumed.aborted).toBe(false);

    const hits = await searchPrinciples('claim', { provider, repository, limit: 100 });
    expect(hits).toHaveLength(4);
  });

  it('an aborted batch never marks the in-flight Source as done', async () => {
    // If the process is killed in the middle of a single job, the progress
    // store must NOT record that job as complete — otherwise resume would
    // silently skip a Source that never reached the repository.
    const progress = new InMemoryBulkProgressStore();
    const ctrl = new AbortController();

    const result = await bulkIngest(
      [
        {
          sourceId: 's1',
          ingest: async () => {
            ctrl.abort();
            throw new Error('killed mid-ingest');
          },
        },
      ],
      progress,
      { signal: ctrl.signal },
    );

    expect(result.aborted).toBe(true);
    expect(await progress.has('s1')).toBe(false);
  });
});
