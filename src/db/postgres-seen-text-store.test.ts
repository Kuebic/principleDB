// Integration test for `PostgresSeenTextStore` — drives the shared
// `SeenTextStore` contract suite against real Postgres + the drizzle-generated
// migration. Skipped (with a clear message) when `DATABASE_URL` is absent so
// the unit suite still passes in a stripped-down dev env.
//
// Setup mirrors `postgres-bulk-progress-store.test.ts`: create a uniquely-
// named schema, apply the drizzle-generated migration into it, run the suite,
// drop the schema CASCADE.

import { afterAll, beforeAll, beforeEach, describe } from 'vitest';
import pg from 'pg';
import { runSeenTextStoreContract } from '../canon/seen-text-store.contract';
import { PostgresSeenTextStore } from './postgres-seen-text-store';
import {
  createIsolatedSchema,
  dropIsolatedSchema,
  isolatedSchemaName,
  poolForSchema,
} from './test-postgres';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('PostgresSeenTextStore (integration)', () => {
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
    await pool.query(`TRUNCATE "${schema}"."seen_text"`);
  });

  describe('contract', () => {
    runSeenTextStoreContract({
      create: () => new PostgresSeenTextStore(pool),
      reset: async () => {
        await pool.query(`TRUNCATE "${schema}"."seen_text"`);
      },
    });
  });
});
