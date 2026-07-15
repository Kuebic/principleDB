// PostgresCanonRepository — production CanonRepository implementation sitting
// on the declarative schema in `./schema.ts` (ADR-0005). Behind the same port
// the in-memory reference repository implements, so the rest of the Canon
// (ingest pipeline, MCP tool, search) plugs in unchanged.
//
// Idempotency at the `(sourceId, provenance)` grain (ADR-0008) is enforced by
// `replacePrinciplesForSource`: delete the slot's existing rows inside a
// transaction, then insert. Different provenance occupies a different slot, so
// a model-mixed Canon stays additive and honest.

import { and, asc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type pg from 'pg';
import { provenanceTag } from '../canon/admission';
import type {
  CanonRepository,
  ListReviewCandidatesOptions,
  QuoteWithPrinciple,
  QuoteWithSource,
  ReplacePrinciplesOptions,
  SearchHit,
  SourceRefForBackfill,
  WorkWithFigure,
} from '../canon/ports';
import type {
  DistilProvenance,
  Edition,
  Figure,
  LocatedQuote,
  Principle,
  ReviewCandidate,
  Source,
  SourceKind,
  StructureMap,
  Work,
  WorkTier,
} from '../canon/types';
import * as schema from './schema';

function pgCosineDistance(column: PgColumn, value: number[]): SQL {
  return sql`${column} <=> ${JSON.stringify(value)}::vector`;
}

// pgvector serializes a `vector` column as a JSON-shaped text literal ("[1,2,…]"),
// so parsing it is a single JSON.parse. Only called by the batched-prefilter
// path, which reaches for raw SQL because drizzle's select builder does not
// speak LATERAL — the typed builders elsewhere let drizzle hydrate the column
// as number[] directly.
function parseVector(raw: string): number[] {
  return JSON.parse(raw) as number[];
}

// Run a bulk insert in bounded slices so neither the pooler's bind-payload
// tolerance nor the wire protocol's 65535-param cap is ever in play. Sequential
// on purpose: callers hand in a transaction-bound insert, and interleaving
// writes on one tx connection is not safe.
async function insertInChunks<T>(
  chunkSize: number,
  rows: T[],
  insert: (batch: T[]) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    await insert(rows.slice(i, i + chunkSize));
  }
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
      workId: source.workId ?? null,
      editionId: source.editionId ?? null,
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
      workId: row.workId,
      editionId: row.editionId,
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

      // 4. Insert fresh principles + their quotes. Chunked like
      //    findSimilarPrinciplesForBatch: each principle row carries a
      //    1536-float embedding (~30 KB as a bind param), so one flat insert
      //    for a dense source (a quote-anthology PDF distils to thousands of
      //    principles) builds a multi-MB bind payload the Supabase pooler
      //    rejects — and >9362 rows would overflow the 65535-param protocol
      //    cap outright. 128 rows/insert ≈ 4 MB worst case; all chunks share
      //    the surrounding transaction so replace stays atomic.
      if (principles.length > 0) {
        await insertInChunks(128, principles, (batch) =>
          tx.insert(schema.principle).values(
            batch.map((p) => ({
              id: p.id,
              sourceId,
              claim: p.claim,
              embedding: p.embedding,
              distilModel: p.distilModel,
              distilModelVersion: p.distilModelVersion,
              distilPromptVersion: p.distilPromptVersion,
            })),
          ),
        );

        const quotes = principles.flatMap((p) => p.quotes);
        await insertInChunks(2000, quotes, (batch) =>
          tx.insert(schema.quote).values(
            batch.map((q) => ({
              id: q.id,
              principleId: q.principleId,
              sourceId: q.sourceId,
              spanStart: q.span.start,
              spanEnd: q.span.end,
              located: q.located,
              matchTier: q.matchTier,
              distilPromptVersion: q.distilPromptVersion,
            })),
          ),
        );
      }

      // 5. Insert attached quotes (dedup merges) — host Principle lives
      //    under another source's slot, but the Quote text is from THIS
      //    Source.
      await insertInChunks(2000, attachedQuotes, (batch) =>
        tx.insert(schema.quote).values(
          batch.map((q) => ({
            id: q.id,
            principleId: q.principleId,
            sourceId: q.sourceId,
            spanStart: q.span.start,
            spanEnd: q.span.end,
            located: q.located,
            matchTier: q.matchTier,
            distilPromptVersion: q.distilPromptVersion,
          })),
        ),
      );

      // 6. Insert dedup decisions.
      await insertInChunks(2000, decisions, (batch) =>
        tx.insert(schema.dedupDecision).values(
          batch.map((d) => ({
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
            confirmModel: d.confirmModel,
          })),
        ),
      );
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

  async findSimilarPrinciplesForBatch(
    embeddings: number[][],
    excludeSourceId: string,
    threshold: number,
    limit: number,
  ): Promise<SearchHit[][]> {
    // Chunk the batch so a single query's bind payload stays bounded: each
    // ::vector param carries a 1536-float embedding (~14 KB), so a source with
    // ~1300 Principles would ship a ~20 MB query the pooler rejects. 128
    // query-vectors ≈ 1.8 MB/query — safe, one round-trip per chunk. Results
    // concatenate in order, preserving the caller's indexing.
    if (embeddings.length === 0) return [];
    const CHUNK = 128;
    const out: SearchHit[][] = [];
    for (let i = 0; i < embeddings.length; i += CHUNK) {
      out.push(
        ...(await this.findSimilarBatchChunk(
          embeddings.slice(i, i + CHUNK),
          excludeSourceId,
          threshold,
          limit,
        )),
      );
    }
    return out;
  }

  private async findSimilarBatchChunk(
    embeddings: number[][],
    excludeSourceId: string,
    threshold: number,
    limit: number,
  ): Promise<SearchHit[][]> {
    // Batched Phase-B prefilter (#34, PRD #27). Same semantics as N calls to
    // `findSimilarPrinciplesExcludingSource`, but one pooler round-trip: a
    // VALUES table of (qidx, embedding) LATERAL-joined against `principle`
    // returns each row's top-K in a single query. Removes one pooler hop per
    // Principle from the confirm critical path.
    if (embeddings.length === 0) return [];

    const valueRows = embeddings.map(
      (emb, i) => sql`(${i}::int, ${JSON.stringify(emb)}::vector)`,
    );
    const values = sql.join(valueRows, sql`, `);
    const query = sql`
      WITH q(qidx, q) AS (VALUES ${values})
      SELECT q.qidx AS qidx,
             p.id AS id,
             p.claim AS claim,
             p.embedding::text AS embedding,
             p.distil_model AS distil_model,
             p.distil_model_version AS distil_model_version,
             p.distil_prompt_version AS distil_prompt_version,
             (1 - (p.embedding <=> q.q))::float8 AS score
      FROM q
      JOIN LATERAL (
        SELECT id, claim, embedding, distil_model, distil_model_version, distil_prompt_version
        FROM ${schema.principle}
        WHERE source_id <> ${excludeSourceId}
          AND (1 - (embedding <=> q.q)) >= ${threshold}
        ORDER BY embedding <=> q.q
        LIMIT ${limit}
      ) p ON true
      ORDER BY q.qidx, (p.embedding <=> q.q)
    `;

    const result = await this.db.execute(query);
    const rawRows = result.rows as Array<{
      qidx: number;
      id: string;
      claim: string;
      embedding: string;
      distil_model: string;
      distil_model_version: string;
      distil_prompt_version: string;
      score: number;
    }>;

    if (rawRows.length === 0) {
      return embeddings.map(() => []);
    }

    // Group rows by qidx and hydrate all their Quotes in one round-trip.
    const hydratable = rawRows.map((r) => ({
      qidx: Number(r.qidx),
      id: r.id,
      claim: r.claim,
      embedding: parseVector(r.embedding),
      distilModel: r.distil_model,
      distilModelVersion: r.distil_model_version,
      distilPromptVersion: r.distil_prompt_version,
      score: Number(r.score),
    }));
    const hydrated = await this.hydrateSearchHits(hydratable);

    const grouped: SearchHit[][] = embeddings.map(() => []);
    for (let i = 0; i < hydratable.length; i++) {
      grouped[hydratable[i]!.qidx]!.push(hydrated[i]!);
    }
    return grouped;
  }

  async getQuotesForPrinciple(
    principleId: string,
    offset: number,
    limit: number,
  ): Promise<QuoteWithSource[]> {
    // Stable order: the host Source's Quote first (`principle.source_id ==
    // quote.source_id`), then attached extras from cross-source dedup merges
    // (issue #65, PRD #63). Within each group we order by quote.id so a
    // Principle with many extras pages deterministically. Read the host
    // source_id in the same query via a correlated subquery so the join is
    // one round-trip.
    const hostFilter = sql`(SELECT source_id FROM ${schema.principle} WHERE id = ${principleId})`;
    const rows = await this.db
      .select({
        quoteId: schema.quote.id,
        quotePrincipleId: schema.quote.principleId,
        quoteSourceId: schema.quote.sourceId,
        spanStart: schema.quote.spanStart,
        spanEnd: schema.quote.spanEnd,
        located: schema.quote.located,
        matchTier: schema.quote.matchTier,
        distilPromptVersion: schema.quote.distilPromptVersion,
        sourceId: schema.source.id,
        sourceTitle: schema.source.title,
        sourceAuthor: schema.source.author,
        sourceKind: schema.source.kind,
        sourceDate: schema.source.date,
        sourceText: schema.source.text,
        sourceR2Key: schema.source.r2Key,
        sourceStructureMap: schema.source.structureMap,
        sourceWorkId: schema.source.workId,
        sourceEditionId: schema.source.editionId,
      })
      .from(schema.quote)
      .innerJoin(schema.source, eq(schema.quote.sourceId, schema.source.id))
      .where(eq(schema.quote.principleId, principleId))
      .orderBy(
        sql`(${schema.quote.sourceId} = ${hostFilter}) DESC`,
        asc(schema.quote.id),
      )
      .limit(limit)
      .offset(offset);

    return rows.map((r) => ({
      quote: {
        id: r.quoteId,
        principleId: r.quotePrincipleId,
        sourceId: r.quoteSourceId,
        span: { start: r.spanStart, end: r.spanEnd },
        located: true,
        matchTier: r.matchTier as LocatedQuote['matchTier'],
        distilPromptVersion: r.distilPromptVersion,
      },
      source: {
        id: r.sourceId,
        title: r.sourceTitle,
        author: r.sourceAuthor,
        kind: r.sourceKind as SourceKind,
        date: r.sourceDate,
        text: r.sourceText,
        r2Key: r.sourceR2Key,
        structureMap: r.sourceStructureMap as StructureMap,
        workId: r.sourceWorkId,
        editionId: r.sourceEditionId,
      },
    }));
  }

  async findRelatedPrinciples(
    principleId: string,
    threshold: number,
    limit: number,
    scopedSourceIds?: readonly string[],
  ): Promise<SearchHit[]> {
    // An empty scope is a deliberate "nothing selected" — short-circuit before
    // the seed read so an empty inArray() never reaches Postgres (mirrors
    // searchByEmbedding).
    if (scopedSourceIds && scopedSourceIds.length === 0) return [];

    // Look up the seed embedding directly. A correlated subquery would push
    // this into the same plan, but the lookup is cheap (PK) and keeping it as
    // a separate read makes the "seed missing ⇒ []" branch explicit.
    const seedRows = await this.db
      .select({ embedding: schema.principle.embedding })
      .from(schema.principle)
      .where(eq(schema.principle.id, principleId))
      .limit(1);
    const seed = seedRows[0];
    if (!seed) return [];

    const distance = pgCosineDistance(schema.principle.embedding, seed.embedding);
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
          ne(schema.principle.id, principleId),
          sql`1 - (${distance}) >= ${threshold}`,
          // Tier/scope pre-filter (ADR-0017): keep only relatives whose home
          // Source is in scope. `undefined` ⇒ no filter (unscoped callers).
          scopedSourceIds
            ? inArray(schema.principle.sourceId, scopedSourceIds)
            : undefined,
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

  async listReviewCandidates(opts: ListReviewCandidatesOptions): Promise<ReviewCandidate[]> {
    const builder = this.db
      .select()
      .from(schema.reviewCandidate)
      .orderBy(asc(schema.reviewCandidate.id));
    if (opts.limit !== undefined) builder.limit(opts.limit);
    if (opts.offset !== undefined) builder.offset(opts.offset);
    const rows = await builder;
    return rows.map(toReviewCandidate);
  }

  async countReviewCandidates(): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.reviewCandidate);
    return Number(rows[0]?.count ?? 0);
  }

  async getReviewCandidate(id: string): Promise<ReviewCandidate | null> {
    const rows = await this.db
      .select()
      .from(schema.reviewCandidate)
      .where(eq(schema.reviewCandidate.id, id))
      .limit(1);
    const row = rows[0];
    return row ? toReviewCandidate(row) : null;
  }

  async removeReviewCandidate(id: string): Promise<void> {
    await this.db.delete(schema.reviewCandidate).where(eq(schema.reviewCandidate.id, id));
  }

  async insertReviewAdmittedPrinciple(
    principle: Principle,
    sourceId: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(schema.principle).values({
        id: principle.id,
        sourceId,
        claim: principle.claim,
        embedding: principle.embedding,
        distilModel: principle.distilModel,
        distilModelVersion: principle.distilModelVersion,
        distilPromptVersion: principle.distilPromptVersion,
      });
      if (principle.quotes.length > 0) {
        await tx.insert(schema.quote).values(
          principle.quotes.map((q) => ({
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

  async searchByEmbedding(
    queryEmbedding: number[],
    limit: number,
    scopedSourceIds?: readonly string[],
  ): Promise<SearchHit[]> {
    // pgvector's <=> operator requires an explicit ::vector cast on the
    // parameter — drizzle's `cosineDistance` helper ships the value as an
    // untyped string parameter, which Postgres won't auto-coerce.
    //
    // `scopedSourceIds` (ADR-0017) is applied as a WHERE-clause pre-filter
    // *before* ORDER BY, so a tight scope (e.g. a 4-Source Work) still gets
    // its top-K rather than an under-filled slice from the global ranking.
    // An empty array is a valid, deliberate "nothing selected" — short-circuit
    // to [] rather than shipping an empty inArray() that Postgres rejects.
    if (scopedSourceIds && scopedSourceIds.length === 0) return [];
    const distance = pgCosineDistance(schema.principle.embedding, queryEmbedding);
    const scopeFilter = scopedSourceIds
      ? inArray(schema.principle.sourceId, scopedSourceIds)
      : undefined;
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
      .where(scopeFilter)
      .orderBy(distance)
      .limit(limit);

    if (rows.length === 0) return [];
    return this.hydrateSearchHits(rows);
  }

  async upsertFigure(figure: Figure): Promise<void> {
    const row = {
      id: figure.id,
      slug: figure.slug,
      displayName: figure.displayName,
    };
    await this.db
      .insert(schema.figure)
      .values(row)
      .onConflictDoUpdate({ target: schema.figure.id, set: row });
  }

  async upsertWork(work: Work): Promise<void> {
    const row = {
      id: work.id,
      title: work.title,
      figureId: work.figureId,
      tier: work.tier,
    };
    await this.db
      .insert(schema.work)
      .values(row)
      .onConflictDoUpdate({ target: schema.work.id, set: row });
  }

  async upsertEdition(edition: Edition): Promise<void> {
    const row = {
      id: edition.id,
      workId: edition.workId,
      label: edition.label,
      recension: edition.recension,
      language: edition.language,
      publishedDate: edition.publishedDate,
      publisher: edition.publisher,
      notes: edition.notes,
    };
    await this.db
      .insert(schema.edition)
      .values(row)
      .onConflictDoUpdate({ target: schema.edition.id, set: row });
  }

  async getEdition(id: string): Promise<Edition | null> {
    const rows = await this.db
      .select()
      .from(schema.edition)
      .where(eq(schema.edition.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      workId: row.workId,
      label: row.label,
      recension: row.recension,
      language: row.language,
      publishedDate: row.publishedDate,
      publisher: row.publisher,
      notes: row.notes,
    };
  }

  async listWorks(): Promise<WorkWithFigure[]> {
    const rows = await this.db
      .select({
        workId: schema.work.id,
        workTitle: schema.work.title,
        workTier: schema.work.tier,
        figureId: schema.figure.id,
        figureSlug: schema.figure.slug,
        figureDisplayName: schema.figure.displayName,
      })
      .from(schema.work)
      .innerJoin(schema.figure, eq(schema.work.figureId, schema.figure.id));
    return rows.map((r) => ({
      work: {
        id: r.workId,
        title: r.workTitle,
        figureId: r.figureId,
        tier: r.workTier as WorkTier,
      },
      figure: {
        id: r.figureId,
        slug: r.figureSlug,
        displayName: r.figureDisplayName,
      },
    }));
  }

  async listSourceIdsInWorks(workIds: string[]): Promise<string[]> {
    if (workIds.length === 0) return [];
    const rows = await this.db
      .select({ id: schema.source.id })
      .from(schema.source)
      .where(inArray(schema.source.workId, workIds));
    return rows.map((r) => r.id);
  }

  async listSourceRefsForBackfill(): Promise<SourceRefForBackfill[]> {
    return this.db
      .select({
        id: schema.source.id,
        author: schema.source.author,
        title: schema.source.title,
        workId: schema.source.workId,
      })
      .from(schema.source);
  }

  async assignSourceToWork(sourceId: string, workId: string): Promise<void> {
    await this.db
      .update(schema.source)
      .set({ workId })
      .where(eq(schema.source.id, sourceId));
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

function toReviewCandidate(row: {
  id: string;
  sourceId: string;
  claim: string;
  quoteText: string;
  matchTier: string;
  dedupState: string;
}): ReviewCandidate {
  return {
    id: row.id,
    sourceId: row.sourceId,
    claim: row.claim,
    quoteText: row.quoteText,
    matchTier: row.matchTier as ReviewCandidate['matchTier'],
    dedupState: row.dedupState as ReviewCandidate['dedupState'],
  };
}
