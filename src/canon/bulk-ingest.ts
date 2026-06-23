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

import type { IngestResult } from './ingest';

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
