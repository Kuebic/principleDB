// Integration test for `PostgresBulkProgressStore` — drives the shared
// `BulkProgressStore` contract suite against real Postgres + the
// drizzle-generated migration, plus a small phase-isolation check that only
// makes sense for a multi-tenant table.
//
// Setup mirrors `postgres-repository.test.ts`: gate on `DATABASE_URL` (skip
// with a clear message when absent), create a uniquely-named schema, apply
// the drizzle-generated migration into it, run the suite, drop the schema
// CASCADE.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { runBulkProgressStoreContract } from '../canon/bulk-progress-store.contract';
import { PostgresBulkProgressStore } from './postgres-bulk-progress-store';
import {
  createIsolatedSchema,
  dropIsolatedSchema,
  isolatedSchemaName,
  poolForSchema,
} from './test-postgres';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('PostgresBulkProgressStore (integration)', () => {
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
    await pool.query(`TRUNCATE "${schema}"."bulk_progress"`);
  });

  describe('contract', () => {
    runBulkProgressStoreContract({
      create: () => new PostgresBulkProgressStore(pool, { phase: 'test' }),
      reset: async () => {
        await pool.query(`TRUNCATE "${schema}"."bulk_progress"`);
      },
    });
  });

  it('marks are scoped by phase — the walker does not see another phase\'s marks', async () => {
    const dir = new PostgresBulkProgressStore(pool, { phase: 'ingest:dir' });
    const sweep = new PostgresBulkProgressStore(pool, { phase: 'redistil-sweep' });

    await dir.mark('src-path-aaaaaaaabbbbbbbb');

    expect(await dir.has('src-path-aaaaaaaabbbbbbbb')).toBe(true);
    expect(await sweep.has('src-path-aaaaaaaabbbbbbbb')).toBe(false);
  });
});
