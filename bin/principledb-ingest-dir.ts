#!/usr/bin/env node
// `npm run ingest:dir -- <path> [--kind K] [--limit N] [--dry-run] [--model haiku|opus]`
// Walk a corpus subtree, filter chrome / images / PDFs / nav pages, and run
// every kept HTML file through the existing single-file `ingestHtml` path via
// `bulkIngest` — so resumability and idempotent `(sourceId, provenance)`
// slotting come for free (ADR-0008). The first slice that operates on a whole
// corpus tier at once; the durable Postgres progress store is a later slice
// (#15).
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

// Default to Haiku for directory walks. The single-file `ingest:html` /
// `ingest:text` paths keep Opus as their default (already wired through
// `buildPrincipleDbDepsFromEnv`) — those are used for the small canon, where
// the quality premium is worth the rate-limit cost.
const HAIKU_MODEL_ID = 'claude-haiku-4-5-20251001';
const OPUS_MODEL_ID = 'claude-opus-4-8';

async function main(): Promise<void> {
  const args = parseIngestDirArgs(process.argv.slice(2));

  const env: BuildDepsEnv = { ...process.env, PRINCIPLEDB_DISTIL_MODEL: resolveModel(args.model) };
  const { deps, close } = buildPrincipleDbDepsFromEnv(env);
  try {
    const result = await ingestDirectory(args.path, deps, {
      ...(args.dryRun !== undefined ? { dryRun: args.dryRun } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.kind !== undefined ? { kind: args.kind } : {}),
    });

    if (result.dryRun) {
      console.log(`dry-run plan for ${args.path}`);
      console.log(formatDryRunSummary(result.plan));
      console.log('(no distil calls made, no Canon writes)');
      return;
    }

    const bulk = result.bulk!;
    console.log(`Walked ${args.path}`);
    console.log(`  jobs planned        : ${result.plan.jobs.length}`);
    console.log(`  ingested            : ${bulk.completed.length}`);
    console.log(`  skipped (already done): ${bulk.skipped.length}`);
    console.log(`  failed              : ${bulk.failed.length}`);
    console.log(`  aborted             : ${bulk.aborted}`);
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
