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
    // Clean state between tests so each can use stable IDs.
    await pool.query(
      `TRUNCATE "${schema}"."dedup_decision", "${schema}"."review_candidate", "${schema}"."quote", "${schema}"."principle", "${schema}"."source" CASCADE`,
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
