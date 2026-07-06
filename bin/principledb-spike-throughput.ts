#!/usr/bin/env node
// Throwaway throughput spike for the two-phase seed (issue #33, PRD #27,
// ADR-0014). Runs Phase A (parallel distil+admit+embed → staging) then Phase B
// (serial dedup drain) over a SUBSET of a real corpus, against a disposable
// isolated schema (created + dropped, never touches `public`), and reports
// distils/min · confirms/min · confirms/doc and a 690k extrapolation.
//
// NOT a unit test — a one-off measurement. Burns a small amount of Haiku API.
//
//   set -a; source ./.sandcastle/.env; set +a
//   npx tsx bin/principledb-spike-throughput.ts <corpus-path> [--limit N] [--stage-p P] [--confirm-p C]

import { performance } from 'node:perf_hooks';
import pg from 'pg';

import { AnthropicIngestProvider } from '../src/canon/anthropic-provider';
import { InMemoryBulkProgressStore } from '../src/canon/bulk-ingest';
import { createOpenAIEmbedder } from '../src/canon/openai-embedder';
import { InMemorySeenTextStore } from '../src/canon/seen-text-store';
import { ingestDirectory } from '../src/bin/ingest-dir';
import { PostgresCanonRepository } from '../src/db/postgres-repository';
import { PostgresStagingStore } from '../src/db/postgres-staging-store';
import {
  createIsolatedSchema,
  dropIsolatedSchema,
  isolatedSchemaName,
  poolForSchema,
} from '../src/db/test-postgres';

// Full-run targets for extrapolation (ADR-0013 / ADR-0014 numbers).
const FULL_DOCS = 13_000;
const FULL_PRINCIPLES = 690_000;
const STEADY_CONFIRMS_PER_PRINCIPLE = 4; // ADR-0013 measured ~5 (topK cap); 4 is a mild floor.
const HAIKU_DISTIL_MODEL = 'claude-haiku-4-5-20251001';

function flag(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  if (i < 0) return def;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : def;
}

async function count(pool: pg.Pool, table: string): Promise<number> {
  const r = await pool.query(`SELECT count(*)::int AS n FROM "${table}"`);
  return r.rows[0].n as number;
}

async function main(): Promise<void> {
  const corpus = process.argv[2];
  if (!corpus || corpus.startsWith('--')) {
    throw new Error('usage: spike-throughput <corpus-path> [--limit N] [--stage-p P] [--confirm-p C]');
  }
  const limit = flag('--limit', 8);
  const stageP = flag('--stage-p', 8);
  const confirmP = flag('--confirm-p', 16);

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL not set (source .sandcastle/.env)');

  const schema = isolatedSchemaName();
  console.log(`spike: isolated schema ${schema} (dropped on exit; never touches public)`);
  await createIsolatedSchema(dbUrl, schema);
  const pool = poolForSchema(dbUrl, schema);

  try {
    const repository = new PostgresCanonRepository(pool);
    const staging = new PostgresStagingStore(pool);
    const embed = createOpenAIEmbedder({
      apiKey: process.env.OPENAI_API_KEY!,
      ...(process.env.PRINCIPLEDB_EMBED_MODEL ? { model: process.env.PRINCIPLEDB_EMBED_MODEL } : {}),
    });
    const provider = new AnthropicIngestProvider({
      ...(process.env.ANTHROPIC_API_KEY
        ? { apiKey: process.env.ANTHROPIC_API_KEY }
        : { authToken: process.env.CLAUDE_CODE_OAUTH_TOKEN! }),
      embed,
      model: HAIKU_DISTIL_MODEL, // Haiku over the API (subscription token is Haiku-only)
    });
    const deps = { provider, repository };

    // ---- Phase A: parallel distil + admit + embed → staging ----
    console.log(`\nPhase A (distil, limit=${limit}, stage-p=${stageP}) ...`);
    const a0 = performance.now();
    const a = await ingestDirectory(corpus, deps, {
      phase: 'distil',
      staging,
      limit,
      stageConcurrency: stageP,
      progress: new InMemoryBulkProgressStore(),
      seenText: new InMemorySeenTextStore(),
    });
    const aSecs = (performance.now() - a0) / 1000;
    const staged = a.bulk!.completed.length;
    const stagedPrinciples = await count(pool, 'staged_source') > 0
      ? (a.bulk!.completed as Array<{ result: { admitted: number } }>).reduce((n, c) => n + c.result.admitted, 0)
      : 0;

    // ---- Phase B: serial dedup drain in plan order ----
    console.log(`Phase B (dedup, confirm-p=${confirmP}) ...`);
    const b0 = performance.now();
    const b = await ingestDirectory(corpus, deps, {
      phase: 'dedup',
      staging,
      confirmConcurrency: confirmP,
      progress: new InMemoryBulkProgressStore(),
      seenText: new InMemorySeenTextStore(),
    });
    const bSecs = (performance.now() - b0) / 1000;
    const deduped = b.bulk!.completed.length;

    const principles = await count(pool, 'principle');
    const quotes = await count(pool, 'quote');
    const confirms = await count(pool, 'dedup_decision');
    const review = await count(pool, 'review_candidate');
    const stagingLeft = await count(pool, 'staged_source');

    const distilsPerMin = staged / (aSecs / 60);
    const confirmsPerMin = confirms / (bSecs / 60);
    const confirmsPerPrinciple = stagedPrinciples > 0 ? confirms / stagedPrinciples : 0;

    const phaseAFullHrs = distilsPerMin > 0 ? FULL_DOCS / distilsPerMin / 60 : Infinity;
    const estTotalConfirms = FULL_PRINCIPLES * STEADY_CONFIRMS_PER_PRINCIPLE;
    const phaseBFullDays = confirmsPerMin > 0 ? estTotalConfirms / confirmsPerMin / 60 / 24 : Infinity;

    console.log('\n================ SPIKE RESULT ================');
    console.log(`corpus            : ${corpus}`);
    console.log(`docs staged (A)   : ${staged}   principles staged: ${stagedPrinciples}`);
    console.log(`docs deduped (B)  : ${deduped}   staging left: ${stagingLeft} (expect 0 — drained)`);
    console.log(`Canon after       : ${principles} principles · ${quotes} quotes · ${review} review · ${confirms} confirms`);
    console.log('---------------------------------------------');
    console.log(`Phase A wall      : ${aSecs.toFixed(1)}s  →  ${distilsPerMin.toFixed(1)} distils/min @ P=${stageP}`);
    console.log(`Phase B wall      : ${bSecs.toFixed(1)}s  →  ${confirmsPerMin.toFixed(0)} confirms/min @ P=${confirmP}`);
    console.log(`confirms/principle: ${confirmsPerPrinciple.toFixed(1)}  (near ADR steady-state ~${STEADY_CONFIRMS_PER_PRINCIPLE}; the confirm-COUNT extrapolation is sound)`);
    console.log('---------------- EXTRAPOLATION (690k) ----------------');
    console.log(`Phase A @ ${FULL_DOCS} docs : ~${phaseAFullHrs.toFixed(1)} h  (scales with distils/min; UNDERSTATED here — a ${staged}-doc corpus cannot fill a P=${stageP} pool)`);
    console.log(`Phase B @ ~${(estTotalConfirms / 1e6).toFixed(1)}M confirms : ~${phaseBFullDays.toFixed(1)} days  (scales with confirms/min; OPTIMISTIC — spike Canon is ~${principles}, so the per-principle vector prefilter is cheap; at 690k it grows costlier)`);
    console.log(`TOTAL             : ~${(phaseAFullHrs / 24 + phaseBFullDays).toFixed(1)} days  (target: one weekend ≈ 2–3 days)`);
    console.log('==============================================');
    if (b.bulk!.failed.length > 0) {
      console.log('Phase B failures:');
      for (const f of b.bulk!.failed) console.log('  ' + f.error);
    }
    if (a.bulk!.failed.length > 0) {
      console.log('Phase A failures:');
      for (const f of a.bulk!.failed) console.log('  ' + f.error);
    }
  } finally {
    await pool.end().catch(() => {});
    await dropIsolatedSchema(dbUrl, schema);
    console.log(`\nspike: dropped isolated schema ${schema}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
