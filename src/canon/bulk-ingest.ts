// bulkIngest — slice 8 / issue #10. Orchestrates an Owner's seed-the-Canon
// run: many mixed Sources (text + digital PDF + scanned PDF + large books),
// over hours, possibly interrupted, possibly with a handful of unprocessable
// outliers. The orchestrator's job is to keep the batch going.
//
// Resumability lives in `BulkProgressStore`: a Source is recorded as done
// ONLY after its `ingest()` thunk returns successfully, so resume after a
// crash re-runs anything that hadn't completed — which is safe because
// `replacePrinciplesForSource` is idempotent at the `(sourceId, provenance)`
// grain (ADR-0008). Per-Source errors are captured into `failed` and the
// batch continues; the Owner gets a single summary instead of a half-failed
// log to grep through. `AbortSignal` simulates the process getting killed —
// the orchestrator stops at the next safe point and `aborted: true` tells the
// caller "this run was not exhaustive".

import type { IngestResult, StageResult } from './ingest';

export interface BulkIngestJob {
  sourceId: string;
  ingest: () => Promise<IngestResult>;
}

export interface BulkProgressStore {
  has(sourceId: string): Promise<boolean>;
  mark(sourceId: string): Promise<void>;
}

export class InMemoryBulkProgressStore implements BulkProgressStore {
  private readonly done = new Set<string>();

  async has(sourceId: string): Promise<boolean> {
    return this.done.has(sourceId);
  }

  async mark(sourceId: string): Promise<void> {
    this.done.add(sourceId);
  }

  size(): number {
    return this.done.size;
  }
}

export interface BulkIngestOptions {
  signal?: AbortSignal;
}

export interface BulkIngestSuccess {
  sourceId: string;
  result: IngestResult;
}

export interface BulkIngestFailure {
  sourceId: string;
  error: string;
}

export interface BulkIngestResult {
  completed: BulkIngestSuccess[];
  failed: BulkIngestFailure[];
  skipped: string[];
  aborted: boolean;
}

export async function bulkIngest(
  jobs: BulkIngestJob[],
  progress: BulkProgressStore,
  options: BulkIngestOptions = {},
): Promise<BulkIngestResult> {
  const completed: BulkIngestSuccess[] = [];
  const failed: BulkIngestFailure[] = [];
  const skipped: string[] = [];

  for (const job of jobs) {
    if (options.signal?.aborted) {
      return { completed, failed, skipped, aborted: true };
    }
    if (await progress.has(job.sourceId)) {
      skipped.push(job.sourceId);
      continue;
    }
    try {
      const result = await job.ingest();
      // Mark BEFORE pushing into `completed` so a kill between the two leaves
      // progress in a state consistent with "this Source has been admitted".
      await progress.mark(job.sourceId);
      completed.push({ sourceId: job.sourceId, result });
    } catch (e) {
      // If the abort fired during this job, treat the throw as the
      // interruption rather than a per-Source failure — the Source's state in
      // the repository is unknown, and we do not want to record either
      // success (progress.mark already skipped) or a permanent failure.
      if (options.signal?.aborted) {
        return { completed, failed, skipped, aborted: true };
      }
      failed.push({ sourceId: job.sourceId, error: formatError(job.sourceId, e) });
    }
  }

  return { completed, failed, skipped, aborted: options.signal?.aborted ?? false };
}

function formatError(sourceId: string, e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return `[${sourceId}] ${msg}`;
}

// Phase A driver — issue #30, PRD #27, ADR-0014.
//
// Parallel-across-Sources counterpart to `bulkIngest`. Where bulkIngest runs
// Sources strictly serially (so each Source dedups against a stable Canon
// snapshot, ADR-0008), bulkStage runs the Canon-independent head of the
// pipeline (distil + admit + embed → stage) under a bounded worker pool. This
// is the lever that collapses the ~9-day serial-distil wall in the 690k seed
// into ~hours; the serial-across dedup Phase B (issue #31) preserves
// reproducibility.
//
// The failure-vs-empty distinction is load-bearing: a distil failure leaves
// the Source unmarked (retried on resume); a legitimately zero-Principle
// Source is staged with an empty payload AND marked done (never retried).
// This is what earns ADR-0014's "the mark, not the row count, distinguishes
// failure from empty."

export interface BulkStageJob {
  sourceId: string;
  stage: () => Promise<StageResult>;
}

export interface BulkStageOptions {
  signal?: AbortSignal;
  // Worker-pool size for the Phase A fan-out. Default ~30 targets the Haiku
  // rate ceiling the #25 spike verified (0 429s at P=32, ceiling unknown).
  concurrency?: number;
}

export interface BulkStageSuccess {
  sourceId: string;
  result: StageResult;
}

export interface BulkStageFailure {
  sourceId: string;
  error: string;
}

export interface BulkStageResult {
  completed: BulkStageSuccess[];
  failed: BulkStageFailure[];
  skipped: string[];
  aborted: boolean;
}

export const DEFAULT_STAGE_CONCURRENCY = 30;

export async function bulkStage(
  jobs: BulkStageJob[],
  progress: BulkProgressStore,
  options: BulkStageOptions = {},
): Promise<BulkStageResult> {
  const completed: BulkStageSuccess[] = [];
  const failed: BulkStageFailure[] = [];
  const skipped: string[] = [];
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_STAGE_CONCURRENCY);

  let nextIdx = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      if (options.signal?.aborted) return;
      const i = nextIdx++;
      if (i >= jobs.length) return;
      const job = jobs[i]!;

      if (await progress.has(job.sourceId)) {
        skipped.push(job.sourceId);
        continue;
      }

      try {
        const result = await job.stage();
        // Mark BEFORE recording success so a kill between the two leaves
        // progress consistent with "this Source is staged". If the mark
        // itself throws, the staged row is already present and the resume
        // pass will re-stage (idempotent) then re-mark.
        await progress.mark(job.sourceId);
        completed.push({ sourceId: job.sourceId, result });
      } catch (e) {
        // Same abort-races-a-throw contract as bulkIngest: if the abort fired
        // during this job, the throw IS the interruption — the Source stays
        // unmarked (resume retries), we do not record a permanent failure.
        if (options.signal?.aborted) return;
        failed.push({ sourceId: job.sourceId, error: formatError(job.sourceId, e) });
      }
    }
  };

  const workerCount = Math.min(concurrency, jobs.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return { completed, failed, skipped, aborted: options.signal?.aborted ?? false };
}
