// Shape tests for the declarative Drizzle schema (ADR-0005).
//
// The schema is the single source of truth that migrations generate from, and that
// PostgresCanonRepository will sit on top of behind the existing CanonRepository
// port. These tests pin: (a) each domain entity from src/canon/types.ts has a
// table; (b) every type field has a matching column with the right type/nullability;
// (c) primary keys and foreign keys exist where the domain demands them; (d) the
// pgvector embedding column carries the EMBEDDING_DIM dimension so a future
// dimension change is a one-line migration, not a silent drift.

import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  bulkProgress,
  dedupDecision,
  edition,
  EMBEDDING_DIM,
  figure,
  principle,
  quote,
  reviewCandidate,
  source,
  work,
} from './schema';

function column(table: PgTable, name: string) {
  const col = getTableConfig(table).columns.find((c) => c.name === name);
  if (!col) throw new Error(`column ${name} not found on table ${getTableConfig(table).name}`);
  return col;
}

function fkTargets(table: PgTable): Array<{
  column: string;
  refTable: string;
  refColumn: string;
}> {
  return getTableConfig(table).foreignKeys.map((fk) => {
    const ref = fk.reference();
    return {
      column: ref.columns[0]!.name,
      refTable: getTableConfig(ref.foreignTable).name,
      refColumn: ref.foreignColumns[0]!.name,
    };
  });
}

describe('declarative Drizzle schema (ADR-0005)', () => {
  it('declares the five Canon tables', () => {
    expect(getTableConfig(source).name).toBe('source');
    expect(getTableConfig(principle).name).toBe('principle');
    expect(getTableConfig(quote).name).toBe('quote');
    expect(getTableConfig(reviewCandidate).name).toBe('review_candidate');
    expect(getTableConfig(dedupDecision).name).toBe('dedup_decision');
  });

  describe('source table mirrors Source type', () => {
    it('has every field from the domain type with the right type/nullability', () => {
      expect(column(source, 'id').primary).toBe(true);
      expect(column(source, 'id').notNull).toBe(true);
      for (const name of ['title', 'author', 'kind', 'date', 'text']) {
        expect(column(source, name).notNull).toBe(true);
      }
      // r2Key is nullable (Source.r2Key: string | null)
      expect(column(source, 'r2_key').notNull).toBe(false);
      // structureMap is jsonb (a discriminated union — stored as JSON)
      expect(column(source, 'structure_map').columnType).toBe('PgJsonb');
      expect(column(source, 'structure_map').notNull).toBe(true);
    });
  });

  describe('principle table mirrors Principle type + provenance (ADR-0008)', () => {
    it('has id PK, claim, FK to source, the three provenance columns', () => {
      expect(column(principle, 'id').primary).toBe(true);
      expect(column(principle, 'claim').notNull).toBe(true);
      expect(column(principle, 'source_id').notNull).toBe(true);
      for (const name of ['distil_model', 'distil_model_version', 'distil_prompt_version']) {
        expect(column(principle, name).notNull).toBe(true);
      }
      const fks = fkTargets(principle);
      expect(fks).toContainEqual({ column: 'source_id', refTable: 'source', refColumn: 'id' });
    });

    it('embedding is a pgvector column at EMBEDDING_DIM', () => {
      const col = column(principle, 'embedding') as unknown as {
        columnType: string;
        dimensions: number;
        notNull: boolean;
      };
      expect(col.columnType).toBe('PgVector');
      expect(col.dimensions).toBe(EMBEDDING_DIM);
      expect(col.notNull).toBe(true);
    });
  });

  describe('quote table mirrors LocatedQuote with the relocated span (ADR-0007)', () => {
    it('has id PK, FKs to principle + source, the split span, located flag, matchTier, prompt-version', () => {
      expect(column(quote, 'id').primary).toBe(true);
      expect(column(quote, 'principle_id').notNull).toBe(true);
      expect(column(quote, 'source_id').notNull).toBe(true);
      // Span stored as two int columns — easier to index/compare than a JSON blob.
      expect(column(quote, 'span_start').notNull).toBe(true);
      expect(column(quote, 'span_end').notNull).toBe(true);
      expect(column(quote, 'located').notNull).toBe(true);
      expect(column(quote, 'match_tier').notNull).toBe(true);
      expect(column(quote, 'distil_prompt_version').notNull).toBe(true);

      const fks = fkTargets(quote);
      expect(fks).toContainEqual({
        column: 'principle_id',
        refTable: 'principle',
        refColumn: 'id',
      });
      expect(fks).toContainEqual({ column: 'source_id', refTable: 'source', refColumn: 'id' });
    });
  });

  describe('review_candidate table mirrors ReviewCandidate', () => {
    it('has id PK, FK to source, claim, quoteText, matchTier, dedupState', () => {
      expect(column(reviewCandidate, 'id').primary).toBe(true);
      expect(column(reviewCandidate, 'source_id').notNull).toBe(true);
      expect(column(reviewCandidate, 'claim').notNull).toBe(true);
      expect(column(reviewCandidate, 'quote_text').notNull).toBe(true);
      expect(column(reviewCandidate, 'match_tier').notNull).toBe(true);
      expect(column(reviewCandidate, 'dedup_state').notNull).toBe(true);

      const fks = fkTargets(reviewCandidate);
      expect(fks).toContainEqual({ column: 'source_id', refTable: 'source', refColumn: 'id' });
    });
  });

  describe('dedup_decision table mirrors DedupDecision (issue #5)', () => {
    it('has id PK, FKs to source + principle, verdict/rationale, score, provenance', () => {
      expect(column(dedupDecision, 'id').primary).toBe(true);
      expect(column(dedupDecision, 'source_id').notNull).toBe(true);
      expect(column(dedupDecision, 'candidate_claim').notNull).toBe(true);
      // existing_principle_id is nullable so historical records survive a
      // host Principle being dropped (FK uses ON DELETE SET NULL).
      expect(column(dedupDecision, 'existing_principle_id').notNull).toBe(false);
      expect(column(dedupDecision, 'verdict').notNull).toBe(true);
      expect(column(dedupDecision, 'rationale').notNull).toBe(true);
      expect(column(dedupDecision, 'similarity_score').notNull).toBe(true);
      for (const name of ['distil_model', 'distil_model_version', 'distil_prompt_version']) {
        expect(column(dedupDecision, name).notNull).toBe(true);
      }
      const fks = fkTargets(dedupDecision);
      expect(fks).toContainEqual({ column: 'source_id', refTable: 'source', refColumn: 'id' });
      expect(fks).toContainEqual({
        column: 'existing_principle_id',
        refTable: 'principle',
        refColumn: 'id',
      });
    });

    it('carries a confirm_model audit column independent of distil provenance (#24, PRD #21)', () => {
      // The confirm model rides on every row but does NOT participate in
      // the (sourceId, provenance) slot key — the distil provenance still
      // owns idempotency. The column is notNull so a future audit can join
      // on it without coping with missing values.
      expect(column(dedupDecision, 'confirm_model').notNull).toBe(true);
    });
  });

  describe('bulk_progress table backs `PostgresBulkProgressStore` (issue #15)', () => {
    it('has a composite (phase, source_id) primary key, both notNull', () => {
      const cfg = getTableConfig(bulkProgress);
      expect(cfg.name).toBe('bulk_progress');
      expect(column(bulkProgress, 'phase').notNull).toBe(true);
      expect(column(bulkProgress, 'source_id').notNull).toBe(true);
      // Composite PK lives on `extraConfigs`, not on individual columns.
      const pkColumns = cfg.primaryKeys[0]?.columns.map((c) => c.name).sort();
      expect(pkColumns).toEqual(['phase', 'source_id']);
    });
  });

  describe('figure + work tables back source-filtering (ADR-0017)', () => {
    it('figure has id PK, unique slug, display name', () => {
      expect(column(figure, 'id').primary).toBe(true);
      expect(column(figure, 'slug').notNull).toBe(true);
      expect(column(figure, 'display_name').notNull).toBe(true);
      // Slug uniqueness lets the backfill upsert idempotently by natural key
      // and gives URLs/MCP a stable, human-readable handle per Figure.
      expect(column(figure, 'slug').isUnique).toBe(true);
    });

    it('work has id PK, title, tier, and a FK to figure', () => {
      expect(column(work, 'id').primary).toBe(true);
      expect(column(work, 'title').notNull).toBe(true);
      expect(column(work, 'tier').notNull).toBe(true);
      expect(column(work, 'figure_id').notNull).toBe(true);
      expect(fkTargets(work)).toContainEqual({
        column: 'figure_id',
        refTable: 'figure',
        refColumn: 'id',
      });
    });

    it('source.work_id has been retired (ADR-0018 slice #61)', () => {
      // Post-#61 Work is resolved through Edition; the second-drifting-path-
      // to-identity risk ADR-0017 removed cannot reappear.
      const columns = getTableConfig(source).columns.map((c) => c.name);
      expect(columns).not.toContain('work_id');
      const fks = fkTargets(source);
      expect(fks.some((fk) => fk.column === 'work_id')).toBe(false);
    });
  });

  describe('edition + source.edition_id back the Editions/Recension provenance layer (ADR-0018)', () => {
    it('edition has id PK, label, recension, language, and a FK to work', () => {
      expect(column(edition, 'id').primary).toBe(true);
      expect(column(edition, 'work_id').notNull).toBe(true);
      expect(column(edition, 'label').notNull).toBe(true);
      // `recension` is a text column — a documented controlled vocabulary,
      // not a table (mirrors `work.tier`). Promotion is deferred until a
      // recension needs its own metadata.
      expect(column(edition, 'recension').notNull).toBe(true);
      // `language` is not-null and defaults to 'en' so existing single-language
      // ingest paths need no code change.
      expect(column(edition, 'language').notNull).toBe(true);
      // Publication provenance is nullable — we don't always know it.
      expect(column(edition, 'published_date').notNull).toBe(false);
      expect(column(edition, 'publisher').notNull).toBe(false);
      expect(column(edition, 'notes').notNull).toBe(false);
      expect(fkTargets(edition)).toContainEqual({
        column: 'work_id',
        refTable: 'work',
        refColumn: 'id',
      });
    });

    it('source.edition_id is NOT NULL and FKs to edition — the single link up the hierarchy (ADR-0018 slice #61)', () => {
      // After #61 the expand-then-contract landed: `edition_id` is the sole
      // link from Source up the hierarchy (Source → Edition → Work → Figure).
      expect(column(source, 'edition_id').notNull).toBe(true);
      expect(fkTargets(source)).toContainEqual({
        column: 'edition_id',
        refTable: 'edition',
        refColumn: 'id',
      });
    });
  });

  it('EMBEDDING_DIM matches the prototype-validated text-embedding-3-small (1536)', () => {
    // A change here means a migration. Pin it so a silent drift fails CI.
    expect(EMBEDDING_DIM).toBe(1536);
  });
});
