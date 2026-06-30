// PostgresBulkProgressStore — durable `BulkProgressStore` implementation
// backing resumable directory walks (issue #15, PRD #11). Implements the
// existing `has`/`mark` contract (`bulk-ingest.ts`), so the port itself is
// untouched and `InMemoryBulkProgressStore` stays for tests.
//
// The table is keyed `(phase, source_id)` so multiple ingest passes (e.g. the
// `ingest:dir` walker today, a future re-distil sweep tomorrow) share one
// table without colliding. `mark` uses `ON CONFLICT DO NOTHING` so re-marking
// a Source on resume is a no-op — `bulkIngest` would not call mark twice in a
// single run, but a partially-replayed resume (process crashed after `mark`
// completed but before the next job started) must not surface as an error.

import { and, eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import type { BulkProgressStore } from '../canon/bulk-ingest';
import * as schema from './schema';

export interface PostgresBulkProgressStoreOptions {
  // Distinguishes ingest passes inside the shared table — e.g. `'ingest:dir'`
  // for the walker, future tools get their own labels.
  phase: string;
}

export class PostgresBulkProgressStore implements BulkProgressStore {
  private readonly db: NodePgDatabase<typeof schema>;
  private readonly phase: string;

  constructor(pool: pg.Pool, options: PostgresBulkProgressStoreOptions) {
    this.db = drizzle(pool, { schema });
    this.phase = options.phase;
  }

  async has(sourceId: string): Promise<boolean> {
    const rows = await this.db
      .select({ phase: schema.bulkProgress.phase })
      .from(schema.bulkProgress)
      .where(
        and(
          eq(schema.bulkProgress.phase, this.phase),
          eq(schema.bulkProgress.sourceId, sourceId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async mark(sourceId: string): Promise<void> {
    await this.db
      .insert(schema.bulkProgress)
      .values({ phase: this.phase, sourceId })
      .onConflictDoNothing({
        target: [schema.bulkProgress.phase, schema.bulkProgress.sourceId],
      });
  }
}
