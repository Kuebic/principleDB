// Integration tests for PostgresCanonRepository — the port contract under a
// real Postgres + pgvector, behind the same CanonRepository seam the rest of
// the Canon plugs into.
//
// Setup: gate on DATABASE_URL (skip with a clear message when absent), create
// a uniquely-named schema, apply the drizzle-generated migration into it,
// run the suite, drop the schema CASCADE. Each test truncates between runs so
// assertions can use stable IDs without leaking state across tests.
//
// The repo is exercised both directly (port-contract behaviours) and through
// `ingestSource`/`searchPrinciples` (so the same end-to-end behaviour the
// in-memory repo backs is re-asserted under real Postgres).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { FakeIngestProvider } from '../canon/fake-provider';
import { ingestSource } from '../canon/ingest';
import { searchPrinciples } from '../canon/search';
import type { DistilProvenance, Source } from '../canon/types';
import { EMBEDDING_DIM } from './schema';
import { PostgresCanonRepository } from './postgres-repository';
import {
  createIsolatedSchema,
  dropIsolatedSchema,
  isolatedSchemaName,
  poolForSchema,
} from './test-postgres';

const DATABASE_URL = process.env.DATABASE_URL;

const sermon: Source = {
  id: 'serm1',
  title: 'Grace and obedience',
  author: 'Pastor X',
  kind: 'sermon',
  date: '2026-05-15',
  text: [
    'Grace precedes obedience. We are loved first, and our obedience flows from being loved.',
    'The empty seat is the assignment: God seats the person not yet here next to us.',
  ].join('\n'),
  r2Key: null,
  structureMap: { kind: 'none' },
  // workId is nullable during the backfill window (ADR-0017); an
  // unassigned Source round-trips as `null`, so pin it here for the
  // round-trip assertion.
  workId: null,
  // editionId is nullable during the ADR-0018 backfill window (issue #59): the
  // migration adds the column, then a later slice (#60) assigns every Source
  // to its Edition. New ingest paths will assign an Edition at write time.
  editionId: null,
};

const provenanceA: DistilProvenance = {
  distilModel: 'claude-opus-4-8',
  distilModelVersion: '2026-06-19',
  distilPromptVersion: 'v1',
};
const provenanceB: DistilProvenance = {
  distilModel: 'claude-sonnet-4-6',
  distilModelVersion: '2026-06-19',
  distilPromptVersion: 'v1',
};

describe.skipIf(!DATABASE_URL)('PostgresCanonRepository (integration)', () => {
  const schema = isolatedSchemaName();
  let pool: pg.Pool;
  let repo: PostgresCanonRepository;

  beforeAll(async () => {
    await createIsolatedSchema(DATABASE_URL!, schema);
    pool = poolForSchema(DATABASE_URL!, schema);
    repo = new PostgresCanonRepository(pool);
  }, 30_000);

  afterAll(async () => {
    await pool.end();
    await dropIsolatedSchema(DATABASE_URL!, schema);
  }, 30_000);

  beforeEach(async () => {
    // Clean state between tests so each can use stable IDs. Work + Figure
    // truncate last: `source.work_id → work.id` is ON DELETE RESTRICT (a Work
    // with Sources cannot be dropped), so Sources must go first; TRUNCATE on
    // one statement lifts that ordering. `edition` sits between Work and
    // Source (ADR-0018) and shares the same RESTRICT posture — folding it
    // into the same TRUNCATE statement lifts the ordering constraint too.
    await pool.query(
      `TRUNCATE "${schema}"."dedup_decision", "${schema}"."review_candidate", "${schema}"."quote", "${schema}"."principle", "${schema}"."source", "${schema}"."edition", "${schema}"."work", "${schema}"."figure" CASCADE`,
    );
  });

  it('round-trips a Source through upsert + get', async () => {
    await repo.upsertSource(sermon);
    const fetched = await repo.getSource(sermon.id);
    expect(fetched).toEqual(sermon);
  });

  it('upsertSource updates an existing row in place (no duplicate primary key)', async () => {
    await repo.upsertSource(sermon);
    await repo.upsertSource({ ...sermon, title: 'Revised title' });
    const fetched = await repo.getSource(sermon.id);
    expect(fetched?.title).toBe('Revised title');
  });

  it('returns null for an unknown Source id', async () => {
    expect(await repo.getSource('nope')).toBeNull();
  });

  it('replacePrinciplesForSource is idempotent under the SAME provenance (3× re-ingest, no duplicates)', async () => {
    const provider = new FakeIngestProvider(
      () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }],
      provenanceA,
      EMBEDDING_DIM,
    );
    await ingestSource(sermon, { provider, repository: repo });
    await ingestSource(sermon, { provider, repository: repo });
    await ingestSource(sermon, { provider, repository: repo });
    const hits = await searchPrinciples('grace and obedience', {
      provider,
      repository: repo,
      limit: 10,
    });
    expect(hits).toHaveLength(1);
  });

  it('replacePrinciplesForSource under a DIFFERENT provenance is additive (model-mixed Canon)', async () => {
    const providerA = new FakeIngestProvider(
      () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }],
      provenanceA,
      EMBEDDING_DIM,
    );
    const providerB = new FakeIngestProvider(
      () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }],
      provenanceB,
      EMBEDDING_DIM,
    );
    await ingestSource(sermon, { provider: providerA, repository: repo });
    await ingestSource(sermon, { provider: providerB, repository: repo });
    const hits = await searchPrinciples('grace and obedience', {
      provider: providerA,
      repository: repo,
      limit: 10,
    });
    expect(hits).toHaveLength(2);
    const models = hits.map((h) => h.principle.distilModel).sort();
    expect(models).toEqual(['claude-opus-4-8', 'claude-sonnet-4-6']);
  });

  it('replacePrinciplesForSource lands a dense source intact across insert chunks', async () => {
    // A quote-anthology source can distil to thousands of principles; the
    // insert runs in 128-row chunks (bind-payload bound). 300 rows crosses
    // two chunk boundaries — every row and its quote must land exactly once.
    const claims = Array.from({ length: 300 }, (_, i) => ({
      claim: `Dense-source claim number ${i}.`,
      quote: `Dense-source claim number ${i}.`,
    }));
    // Quotes must relocate in the source text or admission routes them to
    // review candidates instead of the Canon.
    const dense: Source = {
      ...sermon,
      id: 'dense1',
      text: claims.map((c) => c.quote).join('\n'),
    };
    const provider = new FakeIngestProvider(() => claims, provenanceA, EMBEDDING_DIM);
    await ingestSource(dense, { provider, repository: repo });

    const principles = await pool.query(
      `SELECT count(*)::int AS n FROM "${schema}"."principle" WHERE source_id = $1`,
      [dense.id],
    );
    const quotes = await pool.query(
      `SELECT count(*)::int AS n FROM "${schema}"."quote" WHERE source_id = $1`,
      [dense.id],
    );
    expect(principles.rows[0].n).toBe(300);
    expect(quotes.rows[0].n).toBe(300);
  });

  it('searchByEmbedding hydrates each Principle with its Quotes (the relocated spans)', async () => {
    const provider = new FakeIngestProvider(
      () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }],
      provenanceA,
      EMBEDDING_DIM,
    );
    await ingestSource(sermon, { provider, repository: repo });
    const hits = await searchPrinciples('grace and obedience', {
      provider,
      repository: repo,
      limit: 5,
    });
    expect(hits[0]?.principle.quotes).toHaveLength(1);
    const q = hits[0]!.principle.quotes[0]!;
    expect(q.located).toBe(true);
    expect(q.matchTier).toBe('exact');
    expect(sermon.text.slice(q.span.start, q.span.end)).toBe('Grace precedes obedience.');
  });

  it('returns the golden Principle ranked first for the "grace and obedience" query', async () => {
    const provider = new FakeIngestProvider(
      () => [
        { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
        { claim: 'The empty seat is the assignment.', quote: 'The empty seat is the assignment' },
      ],
      provenanceA,
      EMBEDDING_DIM,
    );
    await ingestSource(sermon, { provider, repository: repo });
    const hits = await searchPrinciples('grace and obedience', {
      provider,
      repository: repo,
      limit: 5,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.principle.claim).toBe('Grace precedes obedience.');
  });

  it('searchByEmbedding returns an empty array when no Principles are admitted', async () => {
    const provider = new FakeIngestProvider(() => [], provenanceA, EMBEDDING_DIM);
    const hits = await searchPrinciples('anything', { provider, repository: repo });
    expect(hits).toEqual([]);
  });

  it('getQuoteById round-trips the LocatedQuote and joins in the Principle claim', async () => {
    const provider = new FakeIngestProvider(
      () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }],
      provenanceA,
      EMBEDDING_DIM,
    );
    await ingestSource(sermon, { provider, repository: repo });
    const hits = await searchPrinciples('grace', { provider, repository: repo, limit: 1 });
    const quoteId = hits[0]!.principle.quotes[0]!.id;

    const record = await repo.getQuoteById(quoteId);
    expect(record).not.toBeNull();
    expect(record!.principleClaim).toBe('Grace precedes obedience.');
    expect(record!.quote.id).toBe(quoteId);
    expect(record!.quote.sourceId).toBe(sermon.id);
    expect(sermon.text.slice(record!.quote.span.start, record!.quote.span.end)).toBe(
      'Grace precedes obedience.',
    );
  });

  it('getQuoteById returns null for an unknown id', async () => {
    expect(await repo.getQuoteById('nope')).toBeNull();
  });

  describe('conservative dedup (issue #5)', () => {
    const sermonAlt: Source = {
      id: 'serm2',
      title: 'Grace before obedience',
      author: 'Pastor Y',
      kind: 'sermon',
      date: '2026-05-22',
      text: 'Grace precedes obedience here too.',
      r2Key: null,
      structureMap: { kind: 'none' },
    };

    it('attaches a near-identical claim from another Source as a Quote on the existing Principle', async () => {
      const providerA = new FakeIngestProvider(
        () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }],
        provenanceA,
        EMBEDDING_DIM,
      );
      await ingestSource(sermon, { provider: providerA, repository: repo });

      const providerB = new FakeIngestProvider(
        () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience here too.' }],
        provenanceA,
        EMBEDDING_DIM,
        () => ({ same: true, rationale: 'identical claim wording' }),
      );
      // Use the same provenance so the dedup decision is keyed under it; the
      // source differs so the cross-source rule fires.
      const result = await ingestSource(sermonAlt, { provider: providerB, repository: repo });

      expect(result).toEqual({ admitted: 0, merged: 1, review: 0 });

      const hits = await searchPrinciples('grace and obedience', {
        provider: providerA,
        repository: repo,
        limit: 10,
      });
      expect(hits).toHaveLength(1);
      expect(hits[0]!.principle.quotes).toHaveLength(2);

      const decisions = await pool.query(
        `SELECT id, source_id, verdict, rationale, existing_principle_id FROM "${schema}"."dedup_decision"`,
      );
      expect(decisions.rows).toHaveLength(1);
      expect(decisions.rows[0].verdict).toBe('merged');
      expect(decisions.rows[0].rationale).toBe('identical claim wording');
      expect(decisions.rows[0].source_id).toBe('serm2');
      expect(decisions.rows[0].existing_principle_id).not.toBeNull();
    });

    it('persists confirm_model on every dedup_decision row (#24, PRD #21)', async () => {
      const providerA = new FakeIngestProvider(
        () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }],
        provenanceA,
        EMBEDDING_DIM,
      );
      await ingestSource(sermon, { provider: providerA, repository: repo });

      const providerB = new FakeIngestProvider(
        () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience here too.' }],
        provenanceA,
        EMBEDDING_DIM,
        () => ({ same: true, rationale: 'identical claim wording' }),
        'claude-haiku-4-5',
      );
      await ingestSource(sermonAlt, { provider: providerB, repository: repo });

      const rows = await pool.query(
        `SELECT confirm_model FROM "${schema}"."dedup_decision"`,
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].confirm_model).toBe('claude-haiku-4-5');
    });

    it('re-ingest under the same provenance is idempotent — attached quotes and decisions stay at count 1', async () => {
      const providerA = new FakeIngestProvider(
        () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }],
        provenanceA,
        EMBEDDING_DIM,
      );
      await ingestSource(sermon, { provider: providerA, repository: repo });

      const providerB = new FakeIngestProvider(
        () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience here too.' }],
        provenanceA,
        EMBEDDING_DIM,
        () => ({ same: true, rationale: 'identical claim wording' }),
      );
      await ingestSource(sermonAlt, { provider: providerB, repository: repo });
      await ingestSource(sermonAlt, { provider: providerB, repository: repo });
      await ingestSource(sermonAlt, { provider: providerB, repository: repo });

      const decisions = await pool.query(
        `SELECT id FROM "${schema}"."dedup_decision"`,
      );
      expect(decisions.rows).toHaveLength(1);

      const attached = await pool.query(
        `SELECT id FROM "${schema}"."quote" WHERE source_id = 'serm2'`,
      );
      expect(attached.rows).toHaveLength(1);
    });
  });

  it('routes a no-match item to ReviewCandidates rather than the Canon (ADR-0007 invariant)', async () => {
    const provider = new FakeIngestProvider(
      () => [
        { claim: 'Drift invention.', quote: 'Something never said in the source at all.' },
      ],
      provenanceA,
      EMBEDDING_DIM,
    );
    const result = await ingestSource(sermon, { provider, repository: repo });
    expect(result).toEqual({ admitted: 0, merged: 0, review: 1 });
    const { rows } = await pool.query(
      `SELECT id, match_tier, dedup_state FROM "${schema}"."review_candidate"`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].match_tier).toBe('no-match');
    expect(rows[0].dedup_state).toBe('pending');
  });

  describe('batched prefilter (issue #34, PRD #27)', () => {
    // The batched Phase-B prefilter must return, per input embedding, the
    // same top-K results as the per-embedding query — Postgres runs one
    // LATERAL-join round-trip instead of N pooler hops. Equivalence is the
    // load-bearing property; without it, the two-phase equivalence test
    // (#32) can no longer trust dedup's merge decisions.
    const seedForBatch: Source = {
      id: 'batch-seed',
      title: 'Batch seed',
      author: 'Pastor X',
      kind: 'sermon',
      date: '2026-05-15',
      text: 'Grace precedes obedience. Faith without works is dead. Love your neighbor as yourself.',
      r2Key: null,
      structureMap: { kind: 'none' },
    };

    it('returns the same top-K per input embedding as the per-embedding path (byte-identical)', async () => {
      const seedProvider = new FakeIngestProvider(
        () => [
          { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
          { claim: 'Faith without works is dead.', quote: 'Faith without works is dead.' },
          { claim: 'Love your neighbor as yourself.', quote: 'Love your neighbor as yourself.' },
        ],
        provenanceA,
        EMBEDDING_DIM,
      );
      await ingestSource(seedForBatch, { provider: seedProvider, repository: repo });

      const queryProvider = new FakeIngestProvider(() => [], provenanceA, EMBEDDING_DIM);
      const embeddings = await queryProvider.embed([
        'Grace precedes obedience.',
        'Faith without works is dead.',
        'Love your neighbor as yourself.',
      ]);

      const perQuery = await Promise.all(
        embeddings.map((e) =>
          repo.findSimilarPrinciplesExcludingSource(e, 'unrelated-source', 0.3, 3),
        ),
      );
      const batched = await repo.findSimilarPrinciplesForBatch(
        embeddings,
        'unrelated-source',
        0.3,
        3,
      );

      expect(batched).toEqual(perQuery);
    });

    it('preserves per-row order — each qidx returns its own results, not a global top-K', async () => {
      const seedProvider = new FakeIngestProvider(
        () => [
          { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
          { claim: 'Faith without works is dead.', quote: 'Faith without works is dead.' },
          { claim: 'Love your neighbor as yourself.', quote: 'Love your neighbor as yourself.' },
        ],
        provenanceA,
        EMBEDDING_DIM,
      );
      await ingestSource(seedForBatch, { provider: seedProvider, repository: repo });

      const queryProvider = new FakeIngestProvider(() => [], provenanceA, EMBEDDING_DIM);
      const embeddings = await queryProvider.embed([
        'Grace precedes obedience.',
        'Love your neighbor as yourself.',
      ]);
      const batched = await repo.findSimilarPrinciplesForBatch(
        embeddings,
        'unrelated-source',
        0.3,
        1,
      );

      expect(batched).toHaveLength(2);
      expect(batched[0]![0]!.principle.claim).toBe('Grace precedes obedience.');
      expect(batched[1]![0]!.principle.claim).toBe('Love your neighbor as yourself.');
    });

    it('empty input returns an empty array without hitting the DB', async () => {
      const batched = await repo.findSimilarPrinciplesForBatch(
        [],
        'unrelated-source',
        0.3,
        5,
      );
      expect(batched).toEqual([]);
    });

    it('excludes principles from the given source across every input embedding', async () => {
      const providerA = new FakeIngestProvider(
        () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }],
        provenanceA,
        EMBEDDING_DIM,
      );
      await ingestSource(sermon, { provider: providerA, repository: repo });

      const queryProvider = new FakeIngestProvider(() => [], provenanceA, EMBEDDING_DIM);
      const embeddings = await queryProvider.embed([
        'Grace precedes obedience.',
        'Grace precedes obedience.',
      ]);
      const batched = await repo.findSimilarPrinciplesForBatch(
        embeddings,
        sermon.id,
        0.3,
        5,
      );
      for (const hits of batched) {
        expect(hits.every((h) => h.principle.id !== sermon.id)).toBe(true);
        expect(hits).toHaveLength(0);
      }
    });
  });

  describe('getQuotesForPrinciple — multi-quote paging (issue #65, PRD #63)', () => {
    // A host + two extras that all voice the same claim; dedup attaches each
    // extra's Quote to the host Principle. The host's Quote is the lead;
    // extras come after in stable order.
    async function seedMulti(): Promise<string> {
      const host: Source = {
        id: 'host',
        title: 'Host sermon',
        author: 'Pastor Host',
        kind: 'sermon',
        date: '2026-05-15',
        text: 'Grace precedes obedience.',
        r2Key: null,
        structureMap: { kind: 'none' },
      };
      const hostProvider = new FakeIngestProvider(
        () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }],
        provenanceA,
        EMBEDDING_DIM,
      );
      await ingestSource(host, { provider: hostProvider, repository: repo });
      for (const [i, srcId] of ['extraA', 'extraB'].entries()) {
        const extra: Source = {
          id: srcId,
          title: `Extra sermon ${i}`,
          author: `Pastor E${i}`,
          kind: 'sermon',
          date: '2026-06-01',
          text: `Grace precedes obedience ${i}.`,
          r2Key: null,
          structureMap: { kind: 'none' },
        };
        const provider = new FakeIngestProvider(
          () => [{ claim: 'Grace precedes obedience.', quote: extra.text }],
          provenanceA,
          EMBEDDING_DIM,
          () => ({ same: true, rationale: 'identical' }),
        );
        await ingestSource(extra, { provider, repository: repo });
      }
      const searchProvider = new FakeIngestProvider(() => [], provenanceA, EMBEDDING_DIM);
      const hits = await searchPrinciples('grace', {
        provider: searchProvider,
        repository: repo,
        limit: 1,
      });
      return hits[0]!.principle.id;
    }

    it('returns the lead first, then attached extras — stable order', async () => {
      const principleId = await seedMulti();
      const rows = await repo.getQuotesForPrinciple(principleId, 0, 10);
      expect(rows).toHaveLength(3);
      expect(rows[0]!.source.id).toBe('host');
      expect(new Set(rows.slice(1).map((r) => r.source.id))).toEqual(
        new Set(['extraA', 'extraB']),
      );
      // Every row carries a resolved Source (title + text present).
      for (const r of rows) {
        expect(r.source.title.length).toBeGreaterThan(0);
        expect(r.source.text.length).toBeGreaterThan(0);
      }
    });

    it('honours offset + limit: disjoint pages, correct slice', async () => {
      const principleId = await seedMulti();
      const page1 = await repo.getQuotesForPrinciple(principleId, 0, 2);
      const page2 = await repo.getQuotesForPrinciple(principleId, 2, 2);
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(1);
      const seen = new Set(page1.map((r) => r.quote.id));
      for (const r of page2) expect(seen.has(r.quote.id)).toBe(false);
    });

    it('returns [] for an unknown principle id', async () => {
      const rows = await repo.getQuotesForPrinciple('does-not-exist', 0, 10);
      expect(rows).toEqual([]);
    });
  });

  describe('live relatedness (issue #7)', () => {
    const graceSermon: Source = {
      id: 'rel-serm1',
      title: 'Grace and obedience',
      author: 'Pastor X',
      kind: 'sermon',
      date: '2026-05-15',
      text: 'Grace precedes obedience. We are loved first. Obedience flows from being loved.',
      r2Key: null,
      structureMap: { kind: 'none' },
    };
    const unrelatedSermon: Source = {
      id: 'rel-serm2',
      title: 'The empty seat',
      author: 'Pastor Y',
      kind: 'sermon',
      date: '2026-05-22',
      text: 'The empty seat is the assignment. Hospitality begins where comfort ends.',
      r2Key: null,
      structureMap: { kind: 'none' },
    };

    it('surfaces a cluster sibling for a seed and excludes the seed itself', async () => {
      const provider = new FakeIngestProvider(
        () => [
          { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
          { claim: 'Obedience flows from grace.', quote: 'Obedience flows from being loved.' },
          { claim: 'The empty seat is the assignment.', quote: 'The empty seat is the assignment.' },
        ],
        provenanceA,
        EMBEDDING_DIM,
      );
      await ingestSource(graceSermon, { provider, repository: repo });
      await ingestSource(unrelatedSermon, { provider, repository: repo });

      const hits = await searchPrinciples('grace precedes obedience', {
        provider,
        repository: repo,
        limit: 10,
      });
      const seed = hits.find((h) => h.principle.claim === 'Grace precedes obedience.')!;

      const related = await repo.findRelatedPrinciples(seed.principle.id, 0.3, 5);
      expect(related.length).toBeGreaterThan(0);
      expect(related[0]!.principle.claim).toBe('Obedience flows from grace.');
      expect(related.find((h) => h.principle.id === seed.principle.id)).toBeUndefined();
    });

    it('returns an empty array for an unknown seed id', async () => {
      const related = await repo.findRelatedPrinciples('does-not-exist', 0.3, 5);
      expect(related).toEqual([]);
    });
  });

  describe('Review queue port (slice 6)', () => {
    it('listReviewCandidates honours limit + offset and countReviewCandidates returns the total', async () => {
      await repo.upsertSource(sermon);
      await repo.addReviewCandidates([
        { id: 'serm1#m#r0', sourceId: 'serm1', claim: 'A.', quoteText: 'aaa', matchTier: 'no-match', dedupState: 'pending' },
        { id: 'serm1#m#r1', sourceId: 'serm1', claim: 'B.', quoteText: 'bbb', matchTier: 'no-match', dedupState: 'pending' },
        { id: 'serm1#m#r2', sourceId: 'serm1', claim: 'C.', quoteText: 'ccc', matchTier: 'no-match', dedupState: 'pending' },
      ]);
      expect(await repo.countReviewCandidates()).toBe(3);
      const page1 = await repo.listReviewCandidates({ limit: 2 });
      expect(page1).toHaveLength(2);
      const page2 = await repo.listReviewCandidates({ limit: 2, offset: 2 });
      expect(page2).toHaveLength(1);
    });

    it('getReviewCandidate round-trips a single candidate', async () => {
      await repo.upsertSource(sermon);
      await repo.addReviewCandidates([
        { id: 'serm1#m#r0', sourceId: 'serm1', claim: 'A.', quoteText: 'aaa', matchTier: 'no-match', dedupState: 'pending' },
      ]);
      const c = await repo.getReviewCandidate('serm1#m#r0');
      expect(c?.claim).toBe('A.');
      expect(await repo.getReviewCandidate('nope')).toBeNull();
    });

    it('removeReviewCandidate deletes the row', async () => {
      await repo.upsertSource(sermon);
      await repo.addReviewCandidates([
        { id: 'serm1#m#r0', sourceId: 'serm1', claim: 'A.', quoteText: 'aaa', matchTier: 'no-match', dedupState: 'pending' },
      ]);
      await repo.removeReviewCandidate('serm1#m#r0');
      expect(await repo.getReviewCandidate('serm1#m#r0')).toBeNull();
      expect(await repo.countReviewCandidates()).toBe(0);
    });

    it('scoped searchByEmbedding tight-scopes to a Work and still returns its best match (ADR-0017 pre-filter)', async () => {
      // Populate the same claim in TWO Sources under different Works. An
      // unscoped search sees both; a scope pinning one Source returns only
      // that Source's match — proving the filter runs BEFORE top-K, not
      // after (a post-filter over global top-K would under-return).
      const provider = new FakeIngestProvider(
        () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }],
        provenanceA,
        EMBEDDING_DIM,
      );
      await repo.upsertFigure({ id: 'fig_smm', slug: 'sun-myung-moon', displayName: 'Sun Myung Moon' });
      await repo.upsertFigure({ id: 'fig_hjh', slug: 'hak-ja-han', displayName: 'Hak Ja Han' });
      await repo.upsertWork({ id: 'work_csg', title: 'Cheon Seong Gyeong', figureId: 'fig_smm', tier: 'core' });
      await repo.upsertWork({ id: 'work_tm', title: 'True Mother Anthology', figureId: 'fig_hjh', tier: 'core' });

      const srcCsg: Source = { ...sermon, id: 'src_csg', workId: 'work_csg' };
      const srcTm: Source = { ...sermon, id: 'src_tm', workId: 'work_tm' };
      await ingestSource(srcCsg, { provider, repository: repo });
      await ingestSource(srcTm, { provider, repository: repo });

      const [embedding] = await provider.embed(['grace and obedience']);
      const scoped = await repo.searchByEmbedding(embedding!, 5, ['src_tm']);
      expect(scoped).toHaveLength(1);
      expect(scoped[0]!.principle.quotes[0]!.sourceId).toBe('src_tm');

      const unscoped = await repo.searchByEmbedding(embedding!, 5);
      expect(unscoped.length).toBeGreaterThanOrEqual(2);
    });

    it('searchByEmbedding with an empty scope short-circuits to [] (no query issued)', async () => {
      const provider = new FakeIngestProvider(
        () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }],
        provenanceA,
        EMBEDDING_DIM,
      );
      await ingestSource(sermon, { provider, repository: repo });
      const [embedding] = await provider.embed(['grace']);
      expect(await repo.searchByEmbedding(embedding!, 5, [])).toEqual([]);
    });

    it('listWorks joins each Work to its Figure; listSourceIdsInWorks returns the Sources that belong to them', async () => {
      await repo.upsertFigure({ id: 'fig_smm', slug: 'sun-myung-moon', displayName: 'Sun Myung Moon' });
      await repo.upsertWork({ id: 'work_a', title: 'A', figureId: 'fig_smm', tier: 'core' });
      await repo.upsertWork({ id: 'work_b', title: 'B', figureId: 'fig_smm', tier: 'extra' });

      await repo.upsertSource({ ...sermon, id: 's_a', workId: 'work_a' });
      await repo.upsertSource({ ...sermon, id: 's_b', workId: 'work_b' });

      const listings = await repo.listWorks();
      expect(listings).toHaveLength(2);
      const a = listings.find((l) => l.work.id === 'work_a')!;
      expect(a.work.tier).toBe('core');
      expect(a.figure.slug).toBe('sun-myung-moon');
      expect(listings.find((l) => l.work.id === 'work_b')!.work.tier).toBe('extra');

      const ids = await repo.listSourceIdsInWorks(['work_a']);
      expect(ids).toEqual(['s_a']);
      const both = await repo.listSourceIdsInWorks(['work_a', 'work_b']);
      expect(new Set(both)).toEqual(new Set(['s_a', 's_b']));
      expect(await repo.listSourceIdsInWorks([])).toEqual([]);
    });

    it('listSourceRefsForBackfill + assignSourceToWork feed the one-time backfill (issue #54)', async () => {
      // Two Sources land as unassigned (workId null — the state right after
      // the ADR-0017 schema migration and before the backfill runs).
      await repo.upsertSource({ ...sermon, id: 's_a' });
      await repo.upsertSource({ ...sermon, id: 's_b' });
      await repo.upsertFigure({ id: 'fig_smm', slug: 'sun-myung-moon', displayName: 'Sun Myung Moon' });
      await repo.upsertWork({ id: 'work_a', title: 'A', figureId: 'fig_smm', tier: 'core' });

      const refsBefore = await repo.listSourceRefsForBackfill();
      const before = refsBefore.filter((r) => r.id === 's_a' || r.id === 's_b');
      expect(before.map((r) => r.workId).sort()).toEqual([null, null]);
      // Lightweight ref — no `text` column leaks into the shape.
      expect(before[0]).not.toHaveProperty('text');

      await repo.assignSourceToWork('s_a', 'work_a');
      const idsInWorkA = await repo.listSourceIdsInWorks(['work_a']);
      expect(idsInWorkA).toEqual(['s_a']);

      const refsAfter = await repo.listSourceRefsForBackfill();
      const after = refsAfter.find((r) => r.id === 's_a')!;
      expect(after.workId).toBe('work_a');
    });

    it('upsertFigure/upsertWork are idempotent (re-upsert updates in place, no dup PK)', async () => {
      await repo.upsertFigure({ id: 'fig_smm', slug: 'sun-myung-moon', displayName: 'Sun Myung Moon' });
      await repo.upsertFigure({ id: 'fig_smm', slug: 'sun-myung-moon', displayName: 'Rev. Sun Myung Moon' });
      await repo.upsertWork({ id: 'work_x', title: 'X', figureId: 'fig_smm', tier: 'core' });
      await repo.upsertWork({ id: 'work_x', title: 'X (revised)', figureId: 'fig_smm', tier: 'extra' });

      const listings = await repo.listWorks();
      expect(listings).toHaveLength(1);
      expect(listings[0]!.work.title).toBe('X (revised)');
      expect(listings[0]!.work.tier).toBe('extra');
      expect(listings[0]!.figure.displayName).toBe('Rev. Sun Myung Moon');
    });

    it('upsertEdition + getEdition round-trip; Source.editionId FKs to edition (ADR-0018)', async () => {
      await repo.upsertFigure({ id: 'fig_smm', slug: 'sun-myung-moon', displayName: 'Sun Myung Moon' });
      await repo.upsertWork({ id: 'work_csg', title: 'Cheon Seong Gyeong', figureId: 'fig_smm', tier: 'core' });
      await repo.upsertEdition({
        id: 'ed_csg_2013',
        workId: 'work_csg',
        label: '2013 Revised',
        recension: 'ffwpu-post-2012',
        language: 'en',
        publishedDate: null,
        publisher: null,
        notes: null,
      });
      // A re-upsert with an updated label overwrites in place (idempotent PK).
      await repo.upsertEdition({
        id: 'ed_csg_2013',
        workId: 'work_csg',
        label: 'Cheon Seong Gyeong — 2013 Revised',
        recension: 'ffwpu-post-2012',
        language: 'en',
        publishedDate: '2013-01-01',
        publisher: 'FFWPU',
        notes: null,
      });
      const fetched = await repo.getEdition('ed_csg_2013');
      expect(fetched?.label).toBe('Cheon Seong Gyeong — 2013 Revised');
      expect(fetched?.publishedDate).toBe('2013-01-01');
      expect(fetched?.publisher).toBe('FFWPU');
      expect(fetched?.language).toBe('en');

      // Source carries the FK; upsert + get round-trips the assignment.
      await repo.upsertSource({ ...sermon, id: 's_csg_1', workId: 'work_csg', editionId: 'ed_csg_2013' });
      const src = await repo.getSource('s_csg_1');
      expect(src?.editionId).toBe('ed_csg_2013');
    });

    it('insertReviewAdmittedPrinciple inserts the Principle + its Quote and search surfaces it', async () => {
      await repo.upsertSource(sermon);
      const provider = new FakeIngestProvider(() => [], provenanceA, EMBEDDING_DIM);
      const [embedding] = await provider.embed(['Loved first.']);
      await repo.insertReviewAdmittedPrinciple(
        {
          id: 'review-admitted-1',
          claim: 'Loved first.',
          embedding: embedding!,
          quotes: [
            {
              id: 'review-admitted-1-q',
              principleId: 'review-admitted-1',
              sourceId: 'serm1',
              span: { start: sermon.text.indexOf('loved first'), end: sermon.text.indexOf('loved first') + 'loved first'.length },
              located: true,
              matchTier: 'exact',
              distilPromptVersion: provenanceA.distilPromptVersion,
            },
          ],
          distilModel: provenanceA.distilModel,
          distilModelVersion: provenanceA.distilModelVersion,
          distilPromptVersion: provenanceA.distilPromptVersion,
        },
        'serm1',
      );
      const hits = await searchPrinciples('loved first', { provider, repository: repo, limit: 5 });
      const found = hits.find((h) => h.principle.id === 'review-admitted-1');
      expect(found).toBeDefined();
      expect(found!.principle.quotes).toHaveLength(1);
      expect(found!.principle.quotes[0]!.located).toBe(true);
    });
  });
});

describe.skipIf(DATABASE_URL)('PostgresCanonRepository (skipped — DATABASE_URL not set)', () => {
  it('would run when DATABASE_URL points at a Postgres+pgvector instance', () => {
    expect(true).toBe(true);
  });
});
