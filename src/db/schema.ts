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
  // The model that produced the `confirmSameClaim` verdict (issue #24, PRD
  // #21). Stamped on every row alongside the distil provenance so a
  // model-mixed Canon's audit trail stays honest. Intentionally NOT part of
  // the slot-key tuple (see `replacePrinciplesForSource`): the confirm model
  // changes the merge decision, not what was said.
  confirmModel: text('confirm_model').notNull(),
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

// Normalized-text near-dupe guard (issue #16, PRD #11). One row per normalized
// hash the dir walker has admitted, used as a pre-distil cache so whitespace-
// variant mirror captures of the same document skip distil instead of paying
// for it. Backs `PostgresSeenTextStore`, which implements the `SeenTextStore`
// port; the port stays separate from `BulkProgressStore` so the three dedup
// layers of PRD #11 stay distinct (ADR-0008 slot / this pre-pass / ADR-0012
// semantic dedup).
//
// No FK to `source`: a recorded hash is a content-fingerprint cache, not a
// pointer to a specific Source — the same normalized text could re-enter the
// pipeline under a different path / id and should still hit the cache.
export const seenText = pgTable('seen_text', {
  hash: text('hash').primaryKey(),
});

// Canon-invisible staging for the two-phase seed (issue #29, PRD #27,
// ADR-0014). Phase A writes each Source's admitted + embedded Principles +
// Review candidates here; Phase B drains and dedups against the Canon-so-far.
//
// Load-bearing property: this is a *separate* table, not a flag on
// `principle` — the dedup query (`findSimilarPrinciplesExcludingSource`)
// selects `FROM principle` and cannot see staging by construction. If it
// could, Phase B would find un-deduped siblings as merge candidates and
// first-Source-wins (ADR-0008) would break.
//
// Keyed on the same tuple `replacePrinciplesForSource` uses so a re-stage
// under the same provenance replaces (idempotent). Payload is one `jsonb`
// blob per Source — the whole admitted-Principles + Review-candidates +
// provenance bundle — chosen for the smallest slice; a mirror of
// `principle`/`quote` with a real `vector` column stays an option under the
// same port if a reviewer prefers it later.
//
// No FK to `source`: Phase A upserts the Source before staging, but a staged
// row is a *transient buffer* between phases (deleted after Phase B persists),
// not a canonical child of the Source. Keeping the FK off matches
// `bulk_progress` — staging is an audit-free operational cache.
export const stagedSource = pgTable(
  'staged_source',
  {
    sourceId: text('source_id').notNull(),
    distilModel: text('distil_model').notNull(),
    distilModelVersion: text('distil_model_version').notNull(),
    distilPromptVersion: text('distil_prompt_version').notNull(),
    // The whole admitted-Principles (with embeddings + Quotes) + Review-
    // candidates + provenance bundle. Phase B rehydrates domain types from
    // this blob; embeddings are stored as JSON arrays of numbers rather than
    // a real pgvector column because staged Principles never participate in
    // a similarity search — Phase B just replays them into the existing
    // dedup loop, which vector-queries the live `principle` table.
    payload: jsonb('payload').notNull(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [
        t.sourceId,
        t.distilModel,
        t.distilModelVersion,
        t.distilPromptVersion,
      ],
    }),
  }),
);
