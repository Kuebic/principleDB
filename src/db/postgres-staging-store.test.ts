// Integration test for `PostgresStagingStore` — drives the shared
// `StagingStore` contract suite against real Postgres + the drizzle-generated
// migration, plus a Canon-invisibility assertion that only makes sense for a
// real repository: staged rows must never surface through
// `findSimilarPrinciplesExcludingSource`, the query the dedup loop relies on.
//
// Skipped (with a clear message) when `DATABASE_URL` is absent so the unit
// suite still passes in a stripped-down dev env.
//
// Setup mirrors `postgres-bulk-progress-store.test.ts`: create a uniquely-
// named schema, apply the drizzle-generated migration into it, run the suite,
// drop the schema CASCADE.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { runStagingStoreContract } from '../canon/staging-store.contract';
import type { DistilProvenance, Principle } from '../canon/types';
import { PostgresStagingStore } from './postgres-staging-store';
import { PostgresCanonRepository } from './postgres-repository';
import {
  createIsolatedSchema,
  dropIsolatedSchema,
  isolatedSchemaName,
  poolForSchema,
} from './test-postgres';

const DATABASE_URL = process.env.DATABASE_URL;

const PROVENANCE: DistilProvenance = {
  distilModel: 'claude-opus-4-8',
  distilModelVersion: 'opus-4-8-2026-01',
  distilPromptVersion: 'v3',
};

describe.skipIf(!DATABASE_URL)('PostgresStagingStore (integration)', () => {
  const schema = isolatedSchemaName();
  let pool: pg.Pool;

  beforeAll(async () => {
    await createIsolatedSchema(DATABASE_URL!, schema);
    pool = poolForSchema(DATABASE_URL!, schema);
  }, 30_000);

  afterAll(async () => {
    await pool.end();
    await dropIsolatedSchema(DATABASE_URL!, schema);
  }, 30_000);

  beforeEach(async () => {
    await pool.query(`TRUNCATE "${schema}"."staged_source"`);
  });

  describe('contract', () => {
    runStagingStoreContract({
      create: () => new PostgresStagingStore(pool),
      reset: async () => {
        await pool.query(`TRUNCATE "${schema}"."staged_source"`);
      },
    });
  });

  it('staged rows are Canon-invisible: the dedup query does not see them (ADR-0014)', async () => {
    // The load-bearing guardrail of the whole two-phase seed. If
    // `findSimilarPrinciplesExcludingSource` could see staged rows, Phase B
    // would find un-deduped siblings as merge candidates and first-Source-
    // wins (ADR-0008) would break. This test proves it cannot — with a
    // staged row on disk and NO row in `principle`, the dedup query
    // returns [].
    const store = new PostgresStagingStore(pool);
    const repo = new PostgresCanonRepository(pool);

    const embedding = new Array(1536).fill(0);
    embedding[0] = 1;

    const staged: Principle = {
      id: 'src-staged#p0',
      claim: 'a staged claim that is not yet in the Canon',
      embedding,
      quotes: [
        {
          id: 'src-staged#p0#q',
          principleId: 'src-staged#p0',
          sourceId: 'src-staged',
          span: { start: 0, end: 10 },
          located: true,
          matchTier: 'exact',
          distilPromptVersion: 'v3',
        },
      ],
      distilModel: PROVENANCE.distilModel,
      distilModelVersion: PROVENANCE.distilModelVersion,
      distilPromptVersion: PROVENANCE.distilPromptVersion,
    };

    await store.stage('src-staged', PROVENANCE, {
      provenance: PROVENANCE,
      principles: [staged],
      reviewCandidates: [],
    });

    // Query the Canon with the same embedding at a permissive threshold —
    // the staged Principle would be an exact match if it were visible.
    const hits = await repo.findSimilarPrinciplesExcludingSource(
      embedding,
      'some-other-source',
      0.0,
      10,
    );
    expect(hits).toHaveLength(0);
  });

  it('staging is a distinct table — the `principle` table is untouched by stage()', async () => {
    // Contract-level sanity: `stage` writes to `staged_source`, not
    // `principle`. If staging ever regressed into a flag on `principle`, the
    // Canon-invisibility guarantee above would silently rot; this catches
    // it at the row-count level too.
    const store = new PostgresStagingStore(pool);
    const embedding = new Array(1536).fill(0);
    embedding[0] = 1;
    await store.stage('src-x', PROVENANCE, {
      provenance: PROVENANCE,
      principles: [
        {
          id: 'src-x#p0',
          claim: 'claim',
          embedding,
          quotes: [],
          distilModel: PROVENANCE.distilModel,
          distilModelVersion: PROVENANCE.distilModelVersion,
          distilPromptVersion: PROVENANCE.distilPromptVersion,
        },
      ],
      reviewCandidates: [],
    });

    const principleRows = await pool.query(
      `SELECT count(*)::int AS n FROM "${schema}"."principle"`,
    );
    const stagedRows = await pool.query(
      `SELECT count(*)::int AS n FROM "${schema}"."staged_source"`,
    );
    expect(principleRows.rows[0].n).toBe(0);
    expect(stagedRows.rows[0].n).toBe(1);
  });
});
