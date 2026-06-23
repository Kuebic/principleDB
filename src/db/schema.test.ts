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
  EMBEDDING_DIM,
  principle,
  quote,
  reviewCandidate,
  source,
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
  it('declares the four Canon tables', () => {
    expect(getTableConfig(source).name).toBe('source');
    expect(getTableConfig(principle).name).toBe('principle');
    expect(getTableConfig(quote).name).toBe('quote');
    expect(getTableConfig(reviewCandidate).name).toBe('review_candidate');
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

  it('EMBEDDING_DIM matches the prototype-validated text-embedding-3-small (1536)', () => {
    // A change here means a migration. Pin it so a silent drift fails CI.
    expect(EMBEDDING_DIM).toBe(1536);
  });
});
