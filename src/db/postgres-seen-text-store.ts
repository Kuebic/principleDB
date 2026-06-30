// PostgresSeenTextStore — durable `SeenTextStore` implementation backing the
// dir walker's normalized-text dedup pre-pass (issue #16, PRD #11).
//
// `record` uses `ON CONFLICT DO NOTHING` so re-recording an already-seen hash
// is a no-op — the walker may record the same hash twice on resume (or on two
// whitespace-variant captures landing in the same run) and a duplicate insert
// must not surface as an error.

import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import type { SeenTextStore } from '../canon/seen-text-store';
import * as schema from './schema';

export class PostgresSeenTextStore implements SeenTextStore {
  private readonly db: NodePgDatabase<typeof schema>;

  constructor(pool: pg.Pool) {
    this.db = drizzle(pool, { schema });
  }

  async seen(hash: string): Promise<boolean> {
    const rows = await this.db
      .select({ hash: schema.seenText.hash })
      .from(schema.seenText)
      .where(eq(schema.seenText.hash, hash))
      .limit(1);
    return rows.length > 0;
  }

  async record(hash: string): Promise<void> {
    await this.db
      .insert(schema.seenText)
      .values({ hash })
      .onConflictDoNothing({ target: schema.seenText.hash });
  }
}
