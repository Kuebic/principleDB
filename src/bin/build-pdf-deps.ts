// Production wiring for `bin/principledb-ingest-pdf.ts`.
//
// Composes the shared Canon deps (provider + repository + pool) from
// `buildPrincipleDbDepsFromEnv` with the two ports the PDF path additionally
// needs: a BlobStore (R2, the blob lake) and a PdfExtractor (the Marker CLI
// wrapper). Kept out of `build-deps.ts` so the MCP server's dep graph stays
// free of R2 / Marker concerns it never uses.

import type pg from 'pg';

import { InMemoryBlobStore } from '../canon/blob-store';
import { MarkerCliExtractor } from '../canon/marker-cli';
import { createR2BlobStoreFromEnv, type R2Env } from '../canon/r2-blob-store';
import { buildPrincipleDbDepsFromEnv, type BuildDepsEnv } from './build-deps';
import type { IngestPdfDeps } from './ingest-pdf';

export interface PdfDepsEnv extends BuildDepsEnv, R2Env {
  // Paths to the zettle vault's Marker wrappers (ADR-0010). The CPU script runs
  // Marker locally; the remote script rsyncs to the A4500 GPU box. Each must
  // print the extracted, page-anchored markdown to stdout for one PDF argument.
  MARKER_CPU_SCRIPT?: string;
  MARKER_REMOTE_SCRIPT?: string;
}

export interface BuiltPdfDeps {
  deps: IngestPdfDeps;
  pool: pg.Pool;
  close: () => Promise<void>;
}

export function buildPdfIngestDepsFromEnv(
  env: PdfDepsEnv,
  opts: { archive: boolean },
): BuiltPdfDeps {
  const base = buildPrincipleDbDepsFromEnv(env);

  const blobs = opts.archive ? requireR2(env) : new InMemoryBlobStore();
  const extractor = new MarkerCliExtractor({
    cpuScript: env.MARKER_CPU_SCRIPT ?? '',
    remoteScript: env.MARKER_REMOTE_SCRIPT ?? '',
  });

  return {
    deps: { ...base.deps, blobs, extractor },
    pool: base.pool,
    close: base.close,
  };
}

function requireR2(env: R2Env) {
  const r2 = createR2BlobStoreFromEnv(env);
  if (!r2) {
    throw new Error(
      'PDF ingest archives originals to R2 — set R2_ENDPOINT (or R2_ACCOUNT_ID) + ' +
        'R2_BUCKET + R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY, or pass --no-archive to skip archival.',
    );
  }
  return r2;
}
