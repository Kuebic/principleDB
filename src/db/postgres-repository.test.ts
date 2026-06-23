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
      `TRUNCATE "${schema}"."review_candidate", "${schema}"."quote", "${schema}"."principle", "${schema}"."source" CASCADE`,
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

  it('routes a no-match item to ReviewCandidates rather than the Canon (ADR-0007 invariant)', async () => {
    const provider = new FakeIngestProvider(
      () => [
        { claim: 'Drift invention.', quote: 'Something never said in the source at all.' },
      ],
      provenanceA,
      EMBEDDING_DIM,
    );
    const result = await ingestSource(sermon, { provider, repository: repo });
    expect(result).toEqual({ admitted: 0, review: 1 });
    const { rows } = await pool.query(
      `SELECT id, match_tier, dedup_state FROM "${schema}"."review_candidate"`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].match_tier).toBe('no-match');
    expect(rows[0].dedup_state).toBe('pending');
  });
});

describe.skipIf(DATABASE_URL)('PostgresCanonRepository (skipped — DATABASE_URL not set)', () => {
  it('would run when DATABASE_URL points at a Postgres+pgvector instance', () => {
    expect(true).toBe(true);
  });
});
