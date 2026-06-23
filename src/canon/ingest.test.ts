import { describe, expect, it } from 'vitest';
import { FakeIngestProvider } from './fake-provider';
import { ingestSource } from './ingest';
import { InMemoryRepository } from './in-memory-repository';
import { searchPrinciples } from './search';
import type { Source } from './types';

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

describe('ingestSource', () => {
  it('admits located items, embeds them, and persists Source + Principles', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
    ]);
    const result = await ingestSource(sermon, { provider, repository });
    expect(result).toEqual({ admitted: 1, merged: 0, review: 0 });
    expect(await repository.getSource('serm1')).not.toBeNull();
  });

  it('routes no-match items to Review and not the Canon', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
      { claim: 'Drift invention.', quote: 'Something never said in the source at all.' },
    ]);
    const result = await ingestSource(sermon, { provider, repository });
    expect(result).toEqual({ admitted: 1, merged: 0, review: 1 });
    expect(repository.reviewCandidates()).toHaveLength(1);
    expect(repository.reviewCandidates()[0]!.matchTier).toBe('no-match');
  });

  it('re-ingest under the SAME provenance is idempotent (no duplicates)', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
    ]);
    await ingestSource(sermon, { provider, repository });
    await ingestSource(sermon, { provider, repository });
    await ingestSource(sermon, { provider, repository });
    const hits = await searchPrinciples('grace and obedience', {
      provider,
      repository,
      limit: 10,
    });
    expect(hits).toHaveLength(1);
  });

  it('re-ingest under DIFFERENT provenance is additive (model-mixed Canon honest)', async () => {
    const repository = new InMemoryRepository();
    const providerA = new FakeIngestProvider(
      () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }],
      { distilModel: 'claude-opus-4-8', distilModelVersion: '2026-06-19', distilPromptVersion: 'v1' },
    );
    const providerB = new FakeIngestProvider(
      () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }],
      { distilModel: 'claude-sonnet-4-6', distilModelVersion: '2026-06-19', distilPromptVersion: 'v1' },
    );
    await ingestSource(sermon, { provider: providerA, repository });
    await ingestSource(sermon, { provider: providerB, repository });
    const hits = await searchPrinciples('grace and obedience', {
      provider: providerA,
      repository,
      limit: 10,
    });
    expect(hits).toHaveLength(2);
    const models = hits.map((h) => h.principle.distilModel).sort();
    expect(models).toEqual(['claude-opus-4-8', 'claude-sonnet-4-6']);
  });
});

describe('searchPrinciples (golden test — anti-Open-Brain guard)', () => {
  it('returns the correct atomic Principle for "grace and obedience"', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
      { claim: 'The empty seat is the assignment.', quote: 'The empty seat is the assignment' },
    ]);
    await ingestSource(sermon, { provider, repository });
    const hits = await searchPrinciples('grace and obedience', { provider, repository, limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.principle.claim).toBe('Grace precedes obedience.');
  });

  it('returns a well-shaped empty array when nothing has been admitted', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => []);
    const hits = await searchPrinciples('anything', { provider, repository });
    expect(hits).toEqual([]);
  });

  it('honours the limit', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
      { claim: 'The empty seat is the assignment.', quote: 'The empty seat is the assignment' },
    ]);
    await ingestSource(sermon, { provider, repository });
    const hits = await searchPrinciples('grace', { provider, repository, limit: 1 });
    expect(hits).toHaveLength(1);
  });
});
