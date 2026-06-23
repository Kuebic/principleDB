// PostgresCanonRepository — production CanonRepository implementation sitting
// on the declarative schema in `./schema.ts` (ADR-0005). Behind the same port
// the in-memory reference repository implements, so the rest of the Canon
// (ingest pipeline, MCP tool, search) plugs in unchanged.
//
// Idempotency at the `(sourceId, provenance)` grain (ADR-0008) is enforced by
// `replacePrinciplesForSource`: delete the slot's existing rows inside a
// transaction, then insert. Different provenance occupies a different slot, so
// a model-mixed Canon stays additive and honest.

import { and, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type pg from 'pg';
import { provenanceTag } from '../canon/admission';
import type {
  CanonRepository,
  QuoteWithPrinciple,
  ReplacePrinciplesOptions,
  SearchHit,
} from '../canon/ports';
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

  async getQuoteById(quoteId: string): Promise<QuoteWithPrinciple | null> {
    const rows = await this.db
      .select({
        id: schema.quote.id,
        principleId: schema.quote.principleId,
        sourceId: schema.quote.sourceId,
        spanStart: schema.quote.spanStart,
        spanEnd: schema.quote.spanEnd,
        located: schema.quote.located,
        matchTier: schema.quote.matchTier,
        distilPromptVersion: schema.quote.distilPromptVersion,
        principleClaim: schema.principle.claim,
      })
      .from(schema.quote)
      .innerJoin(schema.principle, eq(schema.principle.id, schema.quote.principleId))
      .where(eq(schema.quote.id, quoteId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      quote: {
        id: row.id,
        principleId: row.principleId,
        sourceId: row.sourceId,
        span: { start: row.spanStart, end: row.spanEnd },
        located: true,
        matchTier: row.matchTier as LocatedQuote['matchTier'],
        distilPromptVersion: row.distilPromptVersion,
      },
      principleClaim: row.principleClaim,
    };
  }

  async replacePrinciplesForSource(
    sourceId: string,
    provenance: DistilProvenance,
    principles: Principle[],
    options?: ReplacePrinciplesOptions,
  ): Promise<void> {
    const attachedQuotes = options?.attachedQuotes ?? [];
    const decisions = options?.decisions ?? [];
    await this.db.transaction(async (tx) => {
      // 1. Drop principles owned by this (sourceId, provenance) slot.
      //    Their own quotes cascade via the principle_id FK.
      await tx.delete(schema.principle).where(
        and(
          eq(schema.principle.sourceId, sourceId),
          eq(schema.principle.distilModel, provenance.distilModel),
          eq(schema.principle.distilModelVersion, provenance.distilModelVersion),
          eq(schema.principle.distilPromptVersion, provenance.distilPromptVersion),
        ),
      );

      // 2. Drop attached quotes — quotes from THIS source whose host
      //    Principle lives under a different source (i.e. previous dedup
      //    merges). The cascade above only catches own-principle quotes;
      //    these need an explicit delete or they would leak across
      //    re-ingests. They are uniquely identifiable by ID prefix —
      //    `${sourceId}#${tag}#aq…` — where tag encodes the full
      //    provenance.
      const attachedPrefix = `${sourceId}#${provenanceTag(provenance)}#aq%`;
      await tx
        .delete(schema.quote)
        .where(sql`${schema.quote.id} LIKE ${attachedPrefix}`);

      // 3. Drop dedup decisions for this (sourceId, provenance) slot so
      //    the log stays in sync with the principles it explains.
      await tx.delete(schema.dedupDecision).where(
        and(
          eq(schema.dedupDecision.sourceId, sourceId),
          eq(schema.dedupDecision.distilModel, provenance.distilModel),
          eq(schema.dedupDecision.distilModelVersion, provenance.distilModelVersion),
          eq(schema.dedupDecision.distilPromptVersion, provenance.distilPromptVersion),
        ),
      );

      // 4. Insert fresh principles + their quotes.
      if (principles.length > 0) {
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
      }

      // 5. Insert attached quotes (dedup merges) — host Principle lives
      //    under another source's slot, but the Quote text is from THIS
      //    Source.
      if (attachedQuotes.length > 0) {
        await tx.insert(schema.quote).values(
          attachedQuotes.map((q) => ({
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

      // 6. Insert dedup decisions.
      if (decisions.length > 0) {
        await tx.insert(schema.dedupDecision).values(
          decisions.map((d) => ({
            id: d.id,
            sourceId: d.sourceId,
            candidateClaim: d.candidateClaim,
            existingPrincipleId: d.existingPrincipleId,
            verdict: d.verdict,
            rationale: d.rationale,
            similarityScore: d.similarityScore,
            distilModel: d.distilModel,
            distilModelVersion: d.distilModelVersion,
            distilPromptVersion: d.distilPromptVersion,
          })),
        );
      }
    });
  }

  async findSimilarPrinciplesExcludingSource(
    embedding: number[],
    excludeSourceId: string,
    threshold: number,
    limit: number,
  ): Promise<SearchHit[]> {
    const distance = pgCosineDistance(schema.principle.embedding, embedding);
    const score = sql<number>`1 - (${distance})`;
    const rows = await this.db
      .select({
        id: schema.principle.id,
        claim: schema.principle.claim,
        embedding: schema.principle.embedding,
        distilModel: schema.principle.distilModel,
        distilModelVersion: schema.principle.distilModelVersion,
        distilPromptVersion: schema.principle.distilPromptVersion,
        score,
      })
      .from(schema.principle)
      .where(
        and(
          ne(schema.principle.sourceId, excludeSourceId),
          sql`1 - (${distance}) >= ${threshold}`,
        ),
      )
      .orderBy(distance)
      .limit(limit);

    if (rows.length === 0) return [];

    return this.hydrateSearchHits(rows);
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
    return this.hydrateSearchHits(rows);
  }

  private async hydrateSearchHits(
    rows: ReadonlyArray<{
      id: string;
      claim: string;
      embedding: number[];
      distilModel: string;
      distilModelVersion: string;
      distilPromptVersion: string;
      score: number;
    }>,
  ): Promise<SearchHit[]> {
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
