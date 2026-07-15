// relatedPrinciples — live, computed-at-query-time relatedness over pgvector
// (issue #7, PRD user story 32, ADR-0006: nothing stored, no graph).
//
// Golden test: a known cluster surfaces its siblings; an unrelated Principle does not.

import { describe, expect, it } from 'vitest';
import { FakeIngestProvider } from './fake-provider';
import { ingestSource } from './ingest';
import { InMemoryRepository } from './in-memory-repository';
import { relatedPrinciples } from './related';
import type { Source } from './types';

const graceSermon: Source = {
  id: 'serm1',
  title: 'Grace and obedience',
  author: 'Pastor X',
  kind: 'sermon',
  date: '2026-05-15',
  text: 'Grace precedes obedience. We are loved first. Obedience flows from being loved. Mercy comes before judgment in every age.',
  r2Key: null,
  structureMap: { kind: 'none' },
  editionId: 'ed_seed',
};

const unrelatedSermon: Source = {
  id: 'serm2',
  title: 'The empty seat',
  author: 'Pastor Y',
  kind: 'sermon',
  date: '2026-05-22',
  text: 'The empty seat is the assignment. Hospitality begins where comfort ends.',
  r2Key: null,
  structureMap: { kind: 'none' },
  editionId: 'ed_seed',
};

describe('relatedPrinciples', () => {
  it('golden test: surfaces a cluster sibling when queried for a member of the cluster', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
      { claim: 'Obedience flows from grace.', quote: 'Obedience flows from being loved.' },
      { claim: 'The empty seat is the assignment.', quote: 'The empty seat is the assignment.' },
    ]);
    await ingestSource(graceSermon, { provider, repository });
    await ingestSource(unrelatedSermon, { provider, repository });

    const hits = await repository.searchByEmbedding(
      (await provider.embed(['grace precedes obedience']))[0]!,
      10,
    );
    const seed = hits.find((h) => h.principle.claim === 'Grace precedes obedience.')!;

    const related = await relatedPrinciples(seed.principle.id, { repository });
    expect(related.length).toBeGreaterThan(0);
    // The cluster sibling (shares 'obedience' / 'grace' tokens) ranks first.
    expect(related[0]!.principle.claim).toBe('Obedience flows from grace.');
    // Self is excluded.
    expect(related.find((h) => h.principle.id === seed.principle.id)).toBeUndefined();
  });

  it('an unrelated Principle does not surface the cluster siblings (golden test, negative)', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
      { claim: 'Obedience flows from grace.', quote: 'Obedience flows from being loved.' },
      { claim: 'Mercy comes before judgment.', quote: 'Mercy comes before judgment in every age.' },
      { claim: 'The empty seat is the assignment.', quote: 'The empty seat is the assignment.' },
    ]);
    await ingestSource(graceSermon, { provider, repository });
    await ingestSource(unrelatedSermon, { provider, repository });

    const hits = await repository.searchByEmbedding(
      (await provider.embed(['empty seat assignment']))[0]!,
      10,
    );
    const outsider = hits.find((h) => h.principle.claim === 'The empty seat is the assignment.')!;

    const related = await relatedPrinciples(outsider.principle.id, { repository });
    const claims = related.map((h) => h.principle.claim);
    expect(claims).not.toContain('Grace precedes obedience.');
    expect(claims).not.toContain('Obedience flows from grace.');
    expect(claims).not.toContain('Mercy comes before judgment.');
  });

  it('returns an empty array for an unknown principle id', async () => {
    const repository = new InMemoryRepository();
    const related = await relatedPrinciples('does-not-exist', { repository });
    expect(related).toEqual([]);
  });

  it('honours the limit (default 5, override accepted)', async () => {
    const repository = new InMemoryRepository();
    const items = Array.from({ length: 10 }, (_, i) => ({
      claim: `Grace claim ${i}.`,
      quote: 'Grace precedes obedience.',
    }));
    const provider = new FakeIngestProvider(() => items);
    await ingestSource(graceSermon, { provider, repository });

    const hits = await repository.searchByEmbedding(
      (await provider.embed(['grace']))[0]!,
      1,
    );
    const seed = hits[0]!.principle;

    const def = await relatedPrinciples(seed.id, { repository });
    expect(def.length).toBeLessThanOrEqual(5);

    const wider = await relatedPrinciples(seed.id, { repository, limit: 8 });
    expect(wider.length).toBeGreaterThan(def.length);
  });

  it('orders results by descending score (most-related first)', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
      { claim: 'Obedience flows from grace.', quote: 'Obedience flows from being loved.' },
      { claim: 'Mercy comes before judgment.', quote: 'Mercy comes before judgment in every age.' },
    ]);
    await ingestSource(graceSermon, { provider, repository });

    const hits = await repository.searchByEmbedding(
      (await provider.embed(['grace precedes obedience']))[0]!,
      10,
    );
    const seed = hits.find((h) => h.principle.claim === 'Grace precedes obedience.')!;

    const related = await relatedPrinciples(seed.principle.id, { repository });
    for (let i = 1; i < related.length; i++) {
      expect(related[i - 1]!.score).toBeGreaterThanOrEqual(related[i]!.score);
    }
  });
});
