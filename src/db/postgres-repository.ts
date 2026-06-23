// PostgresCanonRepository — production CanonRepository implementation sitting
// on the declarative schema in `./schema.ts` (ADR-0005). Behind the same port
// the in-memory reference repository implements, so the rest of the Canon
// (ingest pipeline, MCP tool, search) plugs in unchanged.
//
// Idempotency at the `(sourceId, provenance)` grain (ADR-0008) is enforced by
// `replacePrinciplesForSource`: delete the slot's existing rows inside a
// transaction, then insert. Different provenance occupies a different slot, so
// a model-mixed Canon stays additive and honest.

import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type pg from 'pg';
import type { CanonRepository, SearchHit } from '../canon/ports';
import type {
  DistilProvenance,
  LocatedQuote,
  Principle,
  ReviewCandidate,
  Source,
  SourceKind,
  StructureMap,
} from '../canon/types';
import * as schema from './schema';

function pgCosineDistance(column: PgColumn, value: number[]): SQL {
  return sql`${column} <=> ${JSON.stringify(value)}::vector`;
}

export class PostgresCanonRepository implements CanonRepository {
  private readonly db: NodePgDatabase<typeof schema>;

  constructor(pool: pg.Pool) {
    this.db = drizzle(pool, { schema });
  }

  async upsertSource(source: Source): Promise<void> {
    const row = {
      id: source.id,
      title: source.title,
      author: source.author,
      kind: source.kind,
      date: source.date,
      text: source.text,
      r2Key: source.r2Key,
      structureMap: source.structureMap,
    };
    await this.db
      .insert(schema.source)
      .values(row)
      .onConflictDoUpdate({ target: schema.source.id, set: row });
  }

  async getSource(id: string): Promise<Source | null> {
    const rows = await this.db
      .select()
      .from(schema.source)
      .where(eq(schema.source.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      author: row.author,
      kind: row.kind as SourceKind,
      date: row.date,
      text: row.text,
      r2Key: row.r2Key,
      structureMap: row.structureMap as StructureMap,
    };
  }

  async replacePrinciplesForSource(
    sourceId: string,
    provenance: DistilProvenance,
    principles: Principle[],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Quotes cascade via the principle_id FK.
      await tx.delete(schema.principle).where(
        and(
          eq(schema.principle.sourceId, sourceId),
          eq(schema.principle.distilModel, provenance.distilModel),
          eq(schema.principle.distilModelVersion, provenance.distilModelVersion),
          eq(schema.principle.distilPromptVersion, provenance.distilPromptVersion),
        ),
      );

      if (principles.length === 0) return;

      await tx.insert(schema.principle).values(
        principles.map((p) => ({
          id: p.id,
          sourceId,
          claim: p.claim,
          embedding: p.embedding,
          distilModel: p.distilModel,
          distilModelVersion: p.distilModelVersion,
          distilPromptVersion: p.distilPromptVersion,
        })),
      );

      const quotes = principles.flatMap((p) => p.quotes);
      if (quotes.length > 0) {
        await tx.insert(schema.quote).values(
          quotes.map((q) => ({
            id: q.id,
            principleId: q.principleId,
            sourceId: q.sourceId,
            spanStart: q.span.start,
            spanEnd: q.span.end,
            located: q.located,
            matchTier: q.matchTier,
            distilPromptVersion: q.distilPromptVersion,
          })),
        );
      }
    });
  }

  async addReviewCandidates(candidates: ReviewCandidate[]): Promise<void> {
    if (candidates.length === 0) return;
    await this.db.insert(schema.reviewCandidate).values(
      candidates.map((c) => ({
        id: c.id,
        sourceId: c.sourceId,
        claim: c.claim,
        quoteText: c.quoteText,
        matchTier: c.matchTier,
        dedupState: c.dedupState,
      })),
    );
  }

  async searchByEmbedding(queryEmbedding: number[], limit: number): Promise<SearchHit[]> {
    // pgvector's <=> operator requires an explicit ::vector cast on the
    // parameter — drizzle's `cosineDistance` helper ships the value as an
    // untyped string parameter, which Postgres won't auto-coerce.
    const distance = pgCosineDistance(schema.principle.embedding, queryEmbedding);
    const rows = await this.db
      .select({
        id: schema.principle.id,
        claim: schema.principle.claim,
        embedding: schema.principle.embedding,
        distilModel: schema.principle.distilModel,
        distilModelVersion: schema.principle.distilModelVersion,
        distilPromptVersion: schema.principle.distilPromptVersion,
        score: sql<number>`1 - (${distance})`,
      })
      .from(schema.principle)
      .orderBy(distance)
      .limit(limit);

    if (rows.length === 0) return [];

    const principleIds = rows.map((r) => r.id);
    const quoteRows = await this.db
      .select()
      .from(schema.quote)
      .where(inArray(schema.quote.principleId, principleIds));

    const quotesById = new Map<string, LocatedQuote[]>();
    for (const q of quoteRows) {
      const lq: LocatedQuote = {
        id: q.id,
        principleId: q.principleId,
        sourceId: q.sourceId,
        span: { start: q.spanStart, end: q.spanEnd },
        located: true,
        matchTier: q.matchTier as LocatedQuote['matchTier'],
        distilPromptVersion: q.distilPromptVersion,
      };
      const arr = quotesById.get(q.principleId) ?? [];
      arr.push(lq);
      quotesById.set(q.principleId, arr);
    }

    return rows.map((r) => ({
      principle: {
        id: r.id,
        claim: r.claim,
        embedding: r.embedding,
        quotes: quotesById.get(r.id) ?? [],
        distilModel: r.distilModel,
        distilModelVersion: r.distilModelVersion,
        distilPromptVersion: r.distilPromptVersion,
      },
      score: Number(r.score),
    }));
  }
}
