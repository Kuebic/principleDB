#!/usr/bin/env node
// `npm run ingest:pdf -- <file.pdf|dir> --author A [--title T] [--kind K]
//    [--date YYYY-MM-DD] [--target cpu|remote-gpu] [--limit N] [--dry-run] [--no-archive]`
//
// Seed the Canon from a PDF book — a single PDF or a directory of per-chapter
// PDFs (e.g. the tparents mirror's `ChambumoGyeong/`, `PHG14/`). Each PDF is
// Marker-extracted to page-anchored markdown, archived to R2, and run through
// the shared distil→admit→embed→dedup→persist tail. Resumable + idempotent via
// the durable `bulk_progress` store (phase `ingest:pdf`, ADR-0008).
//
// All design surface lives in `src/bin/ingest-pdf.ts` (parse + plan + dry-run +
// orchestrate) and `src/bin/build-pdf-deps.ts` (env → Postgres + R2 + Marker);
// this file is the impure shell.
//
// Requires the Marker wrapper for the chosen target to be configured:
// MARKER_CPU_SCRIPT (default) or MARKER_REMOTE_SCRIPT. Distil runs on whatever
// PRINCIPLEDB_DISTIL_MODEL / the credential entitles — Haiku by default.

import { buildPdfIngestDepsFromEnv, type PdfDepsEnv } from '../src/bin/build-pdf-deps';
import {
  formatPdfDryRunSummary,
  ingestPdfSources,
  parseIngestPdfArgs,
  planPdfSources,
  type DistilModelChoice,
} from '../src/bin/ingest-pdf';
import { PostgresBulkProgressStore } from '../src/db/postgres-bulk-progress-store';

// Distil defaults to Haiku: the Claude Code OAuth token is Haiku-entitled, and
// Opus (the provider's built-in default) is gated and 429s. `--model opus` only
// works with an API key that carries the entitlement. Mirrors `ingest:dir`.
const HAIKU_MODEL_ID = 'claude-haiku-4-5-20251001';
const OPUS_MODEL_ID = 'claude-opus-4-8';

function resolveModel(choice: DistilModelChoice | undefined): string {
  if (choice === 'opus') return OPUS_MODEL_ID;
  if (choice === 'haiku') return HAIKU_MODEL_ID;
  return process.env.PRINCIPLEDB_DISTIL_MODEL ?? HAIKU_MODEL_ID;
}

async function main(): Promise<void> {
  const args = parseIngestPdfArgs(process.argv.slice(2));

  // Dry-run is pure: it only walks the filesystem to build the plan. No Marker,
  // R2, DB, or distil — so it needs none of that env configured.
  if (args.dryRun) {
    const plan = planPdfSources(args);
    console.log(`dry-run plan for ${args.path}`);
    console.log(formatPdfDryRunSummary(plan));
    console.log('(no Marker extraction, no R2 upload, no Canon writes)');
    return;
  }

  // Fail fast if the Marker wrapper for the chosen target is not set, before we
  // open a pool or read a single PDF.
  const scriptVar = args.target === 'remote-gpu' ? 'MARKER_REMOTE_SCRIPT' : 'MARKER_CPU_SCRIPT';
  if (!process.env[scriptVar]) {
    throw new Error(
      `${scriptVar} is not set — point it at the zettle Marker wrapper ` +
        `(ingest_pdf.py for cpu, ingest_remote.sh for remote-gpu) that extracts one ` +
        `PDF to page-anchored markdown on stdout (ADR-0010).`,
    );
  }

  // Force the distil model (Haiku by default) so the Opus-defaulting provider
  // can't slip through with a Haiku-only token.
  const env: PdfDepsEnv = { ...process.env, PRINCIPLEDB_DISTIL_MODEL: resolveModel(args.model) };
  const { deps, pool, close } = buildPdfIngestDepsFromEnv(env, {
    archive: args.archive,
  });
  try {
    const progress = new PostgresBulkProgressStore(pool, { phase: 'ingest:pdf' });
    const { plan, bulk } = await ingestPdfSources(args, deps, { progress });

    console.log(`Ingested PDFs under ${args.path}${args.archive ? '' : ' (--no-archive)'}`);
    console.log(`  PDFs planned : ${plan.jobs.length}`);
    console.log(`  ingested : ${bulk.completed.length}`);
    console.log(`  skipped (already done) : ${bulk.skipped.length}`);
    console.log(`  failed : ${bulk.failed.length}`);
    if (bulk.failed.length > 0) {
      console.log('failures:');
      for (const f of bulk.failed) console.log(`  ${f.error}`);
    }
  } finally {
    await close().catch(() => {});
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
