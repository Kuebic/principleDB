#!/usr/bin/env node
// `npm run ingest:dir -- <path> [--kind K] [--limit N] [--dry-run] [--model haiku|opus]`
// Walk a corpus subtree, filter chrome / images / PDFs / nav pages, and run
// every kept HTML file through the existing single-file `ingestHtml` path via
// `bulkIngest` — so resumability and idempotent `(sourceId, provenance)`
// slotting come for free (ADR-0008).
//
// Bulk progress is **durable**: the walker writes "Source X is done" rows
// into the `bulk_progress` Postgres table (`PostgresBulkProgressStore`, issue
// #15), keyed by a path-based deterministic Source id. Restarting after a
// crash skips completed Sources by id without re-reading their HTML — which
// is essential over 100k+ files.
//
// Distil model defaults to **Haiku** for the long tail, because Opus's quality
// premium is not worth the rate-limit cost on hundreds of cheap doctrine files
// (PRD #11). `--model opus` reserves Opus for the high-value canon.
//
// All design surface lives in `src/bin/ingest-dir.ts` (parse + walk + plan +
// dry-run summary) and `src/bin/build-deps.ts` (env → real Postgres +
// Anthropic deps); this file is just the impure shell.

import {
  buildPrincipleDbDepsFromEnv,
  type BuildDepsEnv,
} from '../src/bin/build-deps';
import {
  formatDryRunSummary,
  ingestDirectory,
  parseIngestDirArgs,
} from '../src/bin/ingest-dir';
import { PostgresBulkProgressStore } from '../src/db/postgres-bulk-progress-store';
import { PostgresSeenTextStore } from '../src/db/postgres-seen-text-store';
import { PostgresStagingStore } from '../src/db/postgres-staging-store';

// Default to Haiku for directory walks. The single-file `ingest:html` /
// `ingest:text` paths keep Opus as their default (already wired through
// `buildPrincipleDbDepsFromEnv`) — those are used for the small canon, where
// the quality premium is worth the rate-limit cost.
const HAIKU_MODEL_ID = 'claude-haiku-4-5-20251001';
const OPUS_MODEL_ID = 'claude-opus-4-8';

async function main(): Promise<void> {
  const args = parseIngestDirArgs(process.argv.slice(2));

  const env: BuildDepsEnv = { ...process.env, PRINCIPLEDB_DISTIL_MODEL: resolveModel(args.model) };
  const { deps, pool, close } = buildPrincipleDbDepsFromEnv(env);
  try {
    // Reuse the same Postgres pool for the durable progress + dedup stores
    // so the walker doesn't open extra connection pools just to record state.
    // Two-phase seed (issue #30, PRD #27, ADR-0014): Phase A marks under
    // `ingest:dir:distil` and writes to the Canon-invisible staging store;
    // Phase B (issue #31) marks under `ingest:dir:dedup` and drains staging.
    // Single-phase runs keep the historical `ingest:dir` phase label so an
    // existing durable progress row is not orphaned.
    const progressPhase =
      args.phase === 'distil'
        ? 'ingest:dir:distil'
        : args.phase === 'dedup'
          ? 'ingest:dir:dedup'
          : 'ingest:dir';
    const progress = new PostgresBulkProgressStore(pool, { phase: progressPhase });
    const seenText = new PostgresSeenTextStore(pool);
    const staging = args.phase === 'distil' ? new PostgresStagingStore(pool) : undefined;
    const result = await ingestDirectory(args.path, deps, {
      progress,
      seenText,
      ...(args.dryRun !== undefined ? { dryRun: args.dryRun } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.kind !== undefined ? { kind: args.kind } : {}),
      ...(args.phase !== undefined ? { phase: args.phase } : {}),
      ...(staging !== undefined ? { staging } : {}),
    });

    if (result.dryRun) {
      console.log(`dry-run plan for ${args.path}`);
      console.log(formatDryRunSummary(result.plan));
      console.log('(no distil calls made, no Canon writes)');
      return;
    }

    const bulk = result.bulk!;
    const verb = args.phase === 'distil' ? 'staged' : 'ingested';
    console.log(`Walked ${args.path}${args.phase ? ` (--phase ${args.phase})` : ''}`);
    console.log(`  jobs planned : ${result.plan.jobs.length}`);
    console.log(`  ${verb} : ${bulk.completed.length}`);
    console.log(`  skipped (already done) : ${bulk.skipped.length}`);
    console.log(`  failed : ${bulk.failed.length}`);
    console.log(`  aborted : ${bulk.aborted}`);
    if (bulk.failed.length > 0) {
      console.log('failures:');
      for (const f of bulk.failed) console.log(`  ${f.error}`);
    }
  } finally {
    await close().catch(() => {});
  }
}

// Resolve `--model haiku|opus` → a concrete Anthropic model id. The CLI flag
// wins over `PRINCIPLEDB_DISTIL_MODEL` in the env per the PRD. When neither is
// given, default to Haiku for the long-tail walker.
function resolveModel(choice: 'haiku' | 'opus' | undefined): string {
  if (choice === 'opus') return OPUS_MODEL_ID;
  if (choice === 'haiku') return HAIKU_MODEL_ID;
  return process.env.PRINCIPLEDB_DISTIL_MODEL ?? HAIKU_MODEL_ID;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
