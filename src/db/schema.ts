// Declarative Drizzle schema — the single source of truth that migrations generate
// from (ADR-0005). Mirrors src/canon/types.ts; PostgresCanonRepository will sit on
// top of these tables behind the existing CanonRepository port (src/canon/ports.ts).
//
// Notes that aren't obvious from the column list:
// - `quote.span` is split into `span_start`/`span_end` int columns rather than a JSON
//   blob so a future range query (e.g. "quotes overlapping offset N") is cheap and
//   indexable. The domain Span is reassembled on read.
// - `source.structure_map` is jsonb — it's a discriminated union (ADR-0009: PDF
//   pages / transcript timecodes / text headings / none) where the variants share no
//   common shape, so jsonb is the honest type, and the label is *derived on read*
//   (deriveLabel), never stored on the Quote.
// - `principle.embedding` is pgvector(EMBEDDING_DIM). Dimension is pinned so a change
//   is a deliberate migration; the default (1536) matches the prototype-validated
//   text-embedding-3-small, which is what the spike measured against.
// - Foreign keys cascade on Source delete so removing a Source removes its derived
//   Principles/Quotes/ReviewCandidates — the Canon stays consistent with its inputs.

import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  vector,
} from 'drizzle-orm/pg-core';
import type { StructureMap } from '../canon/types';

export const EMBEDDING_DIM = 1536 as const;

export const source = pgTable('source', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  author: text('author').notNull(),
  kind: text('kind').notNull(),
  date: text('date').notNull(),
  text: text('text').notNull(),
  r2Key: text('r2_key'),
  structureMap: jsonb('structure_map').$type<StructureMap>().notNull(),
});

export const principle = pgTable('principle', {
  id: text('id').primaryKey(),
  sourceId: text('source_id')
    .notNull()
    .references(() => source.id, { onDelete: 'cascade' }),
  claim: text('claim').notNull(),
  embedding: vector('embedding', { dimensions: EMBEDDING_DIM }).notNull(),
  distilModel: text('distil_model').notNull(),
  distilModelVersion: text('distil_model_version').notNull(),
  distilPromptVersion: text('distil_prompt_version').notNull(),
});

export const quote = pgTable('quote', {
  id: text('id').primaryKey(),
  principleId: text('principle_id')
    .notNull()
    .references(() => principle.id, { onDelete: 'cascade' }),
  sourceId: text('source_id')
    .notNull()
    .references(() => source.id, { onDelete: 'cascade' }),
  spanStart: integer('span_start').notNull(),
  spanEnd: integer('span_end').notNull(),
  located: boolean('located').notNull(),
  matchTier: text('match_tier').notNull(),
  distilPromptVersion: text('distil_prompt_version').notNull(),
});

export const reviewCandidate = pgTable('review_candidate', {
  id: text('id').primaryKey(),
  sourceId: text('source_id')
    .notNull()
    .references(() => source.id, { onDelete: 'cascade' }),
  claim: text('claim').notNull(),
  quoteText: text('quote_text').notNull(),
  matchTier: text('match_tier').notNull(),
  dedupState: text('dedup_state').notNull(),
});

// Conservative-dedup audit trail (issue #5, ADR-0006). One row per LLM
// "same claim?" consultation. The Owner can inspect why a candidate merged
// (or stayed separate) without re-running the model.
//
// `existing_principle_id` is `set null` on cascade so dropping a host
// Principle does not silently drop the historical record of why something
// merged into it — the row stays with a null pointer.
//
// Provenance columns mirror principle/quote: same (sourceId + provenance)
// slot wipes its decisions on re-ingest so the log stays in sync with the
// principles it explains.
export const dedupDecision = pgTable('dedup_decision', {
  id: text('id').primaryKey(),
  sourceId: text('source_id')
    .notNull()
    .references(() => source.id, { onDelete: 'cascade' }),
  candidateClaim: text('candidate_claim').notNull(),
  existingPrincipleId: text('existing_principle_id').references(() => principle.id, {
    onDelete: 'set null',
  }),
  verdict: text('verdict').notNull(),
  rationale: text('rationale').notNull(),
  similarityScore: doublePrecision('similarity_score').notNull(),
  distilModel: text('distil_model').notNull(),
  distilModelVersion: text('distil_model_version').notNull(),
  distilPromptVersion: text('distil_prompt_version').notNull(),
});

// Durable bulk-ingest progress (issue #15, PRD #11). Keyed `(phase, source_id)`
// so multiple ingest passes (e.g. the dir walker vs. a future re-distil sweep)
// share one table without colliding. Backs `PostgresBulkProgressStore`, which
// implements the existing `BulkProgressStore` port — the port itself stays
// untouched, and `InMemoryBulkProgressStore` stays for tests.
//
// No FK to `source`: the orchestrator only marks a Source after its `ingest()`
// returns, so the row always points at a Source that already exists. The FK
// is omitted so cascade deletes can't silently rewind progress for work that
// already completed downstream — progress is treated as a free audit log.
export const bulkProgress = pgTable(
  'bulk_progress',
  {
    phase: text('phase').notNull(),
    sourceId: text('source_id').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.phase, t.sourceId] }),
  }),
);
