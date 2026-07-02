// PostgresStagingStore — durable `StagingStore` implementation backing the
// two-phase seed (issue #29, PRD #27, ADR-0014).
//
// Implements the same port as `InMemoryStagingStore` so the port itself is
// untouched and the in-memory impl stays for tests. The table is keyed on the
// same tuple `replacePrinciplesForSource` uses so re-staging under the same
// provenance replaces (idempotent) via `ON CONFLICT … DO UPDATE`. Payload is
// one `jsonb` blob per Source; the domain types round-trip through JSON.

import { and, eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import type {
  StagedEntry,
  StagingPayload,
  StagingStore,
} from '../canon/staging-store';
import type { DistilProvenance } from '../canon/types';
import * as schema from './schema';

export class PostgresStagingStore implements StagingStore {
  private readonly db: NodePgDatabase<typeof schema>;

  constructor(pool: pg.Pool) {
    this.db = drizzle(pool, { schema });
  }

  async stage(
    sourceId: string,
    provenance: DistilProvenance,
    payload: StagingPayload,
  ): Promise<void> {
    await this.db
      .insert(schema.stagedSource)
      .values({
        sourceId,
        distilModel: provenance.distilModel,
        distilModelVersion: provenance.distilModelVersion,
        distilPromptVersion: provenance.distilPromptVersion,
        payload,
      })
      .onConflictDoUpdate({
        target: [
          schema.stagedSource.sourceId,
          schema.stagedSource.distilModel,
          schema.stagedSource.distilModelVersion,
          schema.stagedSource.distilPromptVersion,
        ],
        set: { payload },
      });
  }

  async read(
    sourceId: string,
    provenance: DistilProvenance,
  ): Promise<StagingPayload | null> {
    const rows = await this.db
      .select({ payload: schema.stagedSource.payload })
      .from(schema.stagedSource)
      .where(whereKey(sourceId, provenance))
      .limit(1);
    if (rows.length === 0) return null;
    return rows[0]!.payload as StagingPayload;
  }

  async listStaged(): Promise<StagedEntry[]> {
    const rows = await this.db
      .select({
        sourceId: schema.stagedSource.sourceId,
        distilModel: schema.stagedSource.distilModel,
        distilModelVersion: schema.stagedSource.distilModelVersion,
        distilPromptVersion: schema.stagedSource.distilPromptVersion,
      })
      .from(schema.stagedSource);
    return rows.map((r) => ({
      sourceId: r.sourceId,
      provenance: {
        distilModel: r.distilModel,
        distilModelVersion: r.distilModelVersion,
        distilPromptVersion: r.distilPromptVersion,
      },
    }));
  }

  async delete(sourceId: string, provenance: DistilProvenance): Promise<void> {
    await this.db.delete(schema.stagedSource).where(whereKey(sourceId, provenance));
  }
}

function whereKey(sourceId: string, provenance: DistilProvenance) {
  return and(
    eq(schema.stagedSource.sourceId, sourceId),
    eq(schema.stagedSource.distilModel, provenance.distilModel),
    eq(schema.stagedSource.distilModelVersion, provenance.distilModelVersion),
    eq(schema.stagedSource.distilPromptVersion, provenance.distilPromptVersion),
  );
}
