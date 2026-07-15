// stageSource / stageDistilledItems — Phase A of the two-phase seed
// (issue #30, PRD #27, ADR-0014).
//
// The Canon-independent head of the pipeline: distil + admit + embed → write
// the admitted Principles + Review candidates + provenance to a Canon-invisible
// StagingStore. Never touches `principle`/`quote`/`review_candidate` tables in
// the repository; dedup + persistence are Phase B's job (issue #31).

import { describe, expect, it } from 'vitest';

import { FakeIngestProvider } from './fake-provider';
import { InMemoryRepository } from './in-memory-repository';
import { InMemoryStagingStore } from './staging-store';
import { stageDistilledItems, stageSource } from './ingest';
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
  editionId: 'ed_seed',
};

describe('stageSource', () => {
  it('stages admit+embed output for a fixture Source (Principles carry embeddings + provenance)', async () => {
    const repository = new InMemoryRepository();
    const staging = new InMemoryStagingStore();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
      { claim: 'The empty seat is the assignment.', quote: 'The empty seat is the assignment' },
    ]);

    const result = await stageSource(sermon, { provider, repository, staging });

    expect(result).toEqual({ admitted: 2, review: 0 });

    const payload = await staging.read(sermon.id, provider.provenance);
    expect(payload).not.toBeNull();
    expect(payload!.provenance).toEqual(provider.provenance);
    expect(payload!.principles).toHaveLength(2);
    expect(payload!.reviewCandidates).toHaveLength(0);
    // Embeddings were populated by provider.embed and preserved in staging.
    for (const p of payload!.principles) {
      expect(p.embedding.length).toBeGreaterThan(0);
      expect(p.embedding.some((v) => v !== 0)).toBe(true);
      expect(p.distilModel).toBe(provider.provenance.distilModel);
      expect(p.quotes).toHaveLength(1);
      expect(p.quotes[0]!.located).toBe(true);
    }
  });

  it('routes no-match items to review candidates in the staged payload (not the Canon)', async () => {
    const repository = new InMemoryRepository();
    const staging = new InMemoryStagingStore();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
      { claim: 'Drift invention.', quote: 'Something never said in the source at all.' },
    ]);

    const result = await stageSource(sermon, { provider, repository, staging });
    expect(result).toEqual({ admitted: 1, review: 1 });

    const payload = await staging.read(sermon.id, provider.provenance);
    expect(payload!.principles).toHaveLength(1);
    expect(payload!.reviewCandidates).toHaveLength(1);
    expect(payload!.reviewCandidates[0]!.matchTier).toBe('no-match');

    // The Canon-invisible guarantee: staged review candidates never reached
    // the live review queue (Phase B is the one that persists them).
    expect(repository.reviewCandidates()).toHaveLength(0);
  });

  it('upserts the Source but leaves the Canon principle store empty', async () => {
    const repository = new InMemoryRepository();
    const staging = new InMemoryStagingStore();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
    ]);

    await stageSource(sermon, { provider, repository, staging });

    expect(await repository.getSource(sermon.id)).not.toBeNull();
    // No Canon writes — searchByEmbedding returns nothing.
    const [vec] = await provider.embed(['grace']);
    const hits = await repository.searchByEmbedding(vec!, 10);
    expect(hits).toHaveLength(0);
  });

  it('a zero-Principle distil result stages an empty payload (marked-not-retried semantic)', async () => {
    // Legitimately-empty is Phase A's "success with nothing to admit" case:
    // the ADR distinguishes it from a distil *failure* (the latter leaves the
    // Source unmarked so resume retries; the former marks the Source and
    // never re-runs it).
    const repository = new InMemoryRepository();
    const staging = new InMemoryStagingStore();
    const provider = new FakeIngestProvider(() => []);

    const result = await stageSource(sermon, { provider, repository, staging });
    expect(result).toEqual({ admitted: 0, review: 0 });

    const payload = await staging.read(sermon.id, provider.provenance);
    expect(payload).not.toBeNull();
    expect(payload!.principles).toHaveLength(0);
    expect(payload!.reviewCandidates).toHaveLength(0);
  });

  it('re-stage under the SAME provenance replaces (idempotent) — no double payload', async () => {
    const repository = new InMemoryRepository();
    const staging = new InMemoryStagingStore();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
    ]);

    await stageSource(sermon, { provider, repository, staging });
    await stageSource(sermon, { provider, repository, staging });

    const payload = await staging.read(sermon.id, provider.provenance);
    expect(payload!.principles).toHaveLength(1);
  });
});

describe('stageDistilledItems', () => {
  it('accepts pre-distilled items so multi-chunk callers can stage without re-distil', async () => {
    // Mirrors the ingestDistilledItems entry point (large-book-ingest uses it
    // per-chunk). A caller with distil output already in hand can stage
    // directly without going through provider.distil.
    const repository = new InMemoryRepository();
    const staging = new InMemoryStagingStore();
    const provider = new FakeIngestProvider(() => []);

    const result = await stageDistilledItems(
      sermon,
      [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }],
      { provider, repository, staging },
    );
    expect(result).toEqual({ admitted: 1, review: 0 });

    const payload = await staging.read(sermon.id, provider.provenance);
    expect(payload!.principles).toHaveLength(1);
  });
});
