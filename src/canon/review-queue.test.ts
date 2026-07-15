import { describe, expect, it } from 'vitest';
import { FakeIngestProvider } from './fake-provider';
import { ingestSource } from './ingest';
import { InMemoryRepository } from './in-memory-repository';
import { listReviewQueue, resolveReviewItem } from './review-queue';
import { searchPrinciples } from './search';
import type { DistilProvenance, Source } from './types';

const sermon: Source = {
  id: 'serm1',
  title: 'Grace and obedience',
  author: 'Pastor X',
  kind: 'sermon',
  date: '2026-05-15',
  text: 'Grace precedes obedience. We are loved first.',
  r2Key: null,
  structureMap: { kind: 'none' },
  editionId: 'ed_seed',
};

const provenance: DistilProvenance = {
  distilModel: 'fake-distiller',
  distilModelVersion: '1.0',
  distilPromptVersion: 'test-v1',
};

async function seedWithDrift(): Promise<{
  repository: InMemoryRepository;
  provider: FakeIngestProvider;
  candidateId: string;
}> {
  const repository = new InMemoryRepository();
  const provider = new FakeIngestProvider(
    () => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
      { claim: 'Drift invention.', quote: 'Words never present in the source.' },
    ],
    provenance,
  );
  await ingestSource(sermon, { provider, repository });
  const candidates = repository.reviewCandidates();
  return { repository, provider, candidateId: candidates[0]!.id };
}

describe('listReviewQueue', () => {
  it('returns a summary-first shape — one row per unlocatable ReviewCandidate', async () => {
    const { repository } = await seedWithDrift();
    const listing = await listReviewQueue({}, { repository });
    expect(listing.total).toBe(1);
    expect(listing.items).toHaveLength(1);
    const item = listing.items[0]!;
    expect(item.sourceId).toBe('serm1');
    expect(item.sourceTitle).toBe('Grace and obedience');
    expect(item.claim).toBe('Drift invention.');
    expect(item.matchTier).toBe('no-match');
    expect(item.quoteTextLength).toBe('Words never present in the source.'.length);
  });

  it('truncates the quote-text preview so the summary stays short', async () => {
    const repository = new InMemoryRepository();
    const longQuote = 'NOT-IN-SOURCE-'.repeat(40);
    const provider = new FakeIngestProvider(
      () => [{ claim: 'Long drift claim.', quote: longQuote }],
      provenance,
    );
    await ingestSource(sermon, { provider, repository });
    const listing = await listReviewQueue({}, { repository });
    expect(listing.items).toHaveLength(1);
    expect(listing.items[0]!.quoteTextPreview.length).toBeLessThan(longQuote.length);
    expect(listing.items[0]!.quoteTextLength).toBe(longQuote.length);
  });

  it('honours limit and offset for pagination', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(
      () => [
        { claim: 'A.', quote: 'aaa not present' },
        { claim: 'B.', quote: 'bbb not present' },
        { claim: 'C.', quote: 'ccc not present' },
      ],
      provenance,
    );
    await ingestSource(sermon, { provider, repository });
    const page1 = await listReviewQueue({ limit: 2 }, { repository });
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(3);
    const page2 = await listReviewQueue({ limit: 2, offset: 2 }, { repository });
    expect(page2.items).toHaveLength(1);
  });

  it('returns a well-shaped empty case when the queue is empty', async () => {
    const repository = new InMemoryRepository();
    const listing = await listReviewQueue({}, { repository });
    expect(listing).toEqual({ items: [], total: 0 });
  });
});

describe('resolveReviewItem', () => {
  it('confirm admits a Principle when the candidate quote actually relocates', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(
      () => [
        // The relocate test runs at admission time; force a no-match initially by giving
        // a quote with stray punctuation/whitespace that DOES match after normalization.
        // We simulate this by inserting a clearly unlocatable quote and using `correct`
        // below. For the confirm path, the quote already appears in the source as written
        // but the AI accidentally added it as no-match (in practice this would never happen,
        // but resolveReviewItem must still re-check honestly).
        { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
      ],
      provenance,
    );
    await ingestSource(sermon, { provider, repository });
    // Manually add a no-match candidate whose quote happens to be relocatable —
    // this exercises the "confirm re-relocates" path.
    const candidateId = 'serm1#manual#r0';
    await repository.addReviewCandidates([
      {
        id: candidateId,
        sourceId: 'serm1',
        claim: 'Loved first.',
        quoteText: 'We are loved first.',
        matchTier: 'no-match',
        dedupState: 'pending',
      },
    ]);

    const result = await resolveReviewItem(
      { itemId: candidateId, action: 'confirm' },
      { provider, repository },
    );
    expect(result.resolved).toBe(true);
    if (!result.resolved) return;
    expect(result.outcome).toBe('admitted');
    if (result.outcome !== 'admitted') return;
    expect(result.matchTier).toBe('exact');
    // ReviewCandidate is gone.
    expect(repository.reviewCandidates().find((c) => c.id === candidateId)).toBeUndefined();
    // New Principle is searchable.
    const hits = await searchPrinciples('loved first', {
      provider,
      repository,
      limit: 5,
    });
    const found = hits.find((h) => h.principle.id === result.principleId);
    expect(found).toBeDefined();
    // ≥1 relocating Quote invariant (ADR-0007).
    expect(found!.principle.quotes).toHaveLength(1);
    expect(found!.principle.quotes[0]!.located).toBe(true);
  });

  it('confirm DECLINES (and keeps the candidate) when the quote still does not relocate', async () => {
    const { repository, provider, candidateId } = await seedWithDrift();
    const before = repository.reviewCandidates().length;
    const result = await resolveReviewItem(
      { itemId: candidateId, action: 'confirm' },
      { provider, repository },
    );
    expect(result.resolved).toBe(false);
    if (result.resolved) return;
    expect(result.reason).toBe('still-no-match');
    // Candidate stays in the queue.
    expect(repository.reviewCandidates().length).toBe(before);
  });

  it('correct admits the Principle after the Owner supplies a relocating quote', async () => {
    const { repository, provider, candidateId } = await seedWithDrift();
    const result = await resolveReviewItem(
      {
        itemId: candidateId,
        action: 'correct',
        quoteText: 'We are loved first.',
        claim: 'Loved first.',
      },
      { provider, repository },
    );
    expect(result.resolved).toBe(true);
    if (!result.resolved) return;
    expect(result.outcome).toBe('admitted');
    if (result.outcome !== 'admitted') return;

    expect(repository.reviewCandidates().find((c) => c.id === candidateId)).toBeUndefined();
    const hits = await searchPrinciples('loved first', { provider, repository, limit: 5 });
    const found = hits.find((h) => h.principle.id === result.principleId);
    expect(found).toBeDefined();
    expect(found!.principle.claim).toBe('Loved first.');
  });

  it('correct DECLINES when the corrected quote still does not relocate', async () => {
    const { repository, provider, candidateId } = await seedWithDrift();
    const result = await resolveReviewItem(
      {
        itemId: candidateId,
        action: 'correct',
        quoteText: 'Still nothing the source ever said.',
      },
      { provider, repository },
    );
    expect(result.resolved).toBe(false);
    if (result.resolved) return;
    expect(result.reason).toBe('still-no-match');
    expect(repository.reviewCandidates().find((c) => c.id === candidateId)).toBeDefined();
  });

  it('reject drops the candidate without admitting anything', async () => {
    const { repository, provider, candidateId } = await seedWithDrift();
    const result = await resolveReviewItem(
      { itemId: candidateId, action: 'reject' },
      { provider, repository },
    );
    expect(result.resolved).toBe(true);
    if (!result.resolved) return;
    expect(result.outcome).toBe('rejected');
    expect(repository.reviewCandidates().find((c) => c.id === candidateId)).toBeUndefined();
    // No new Principle.
    const hits = await searchPrinciples('drift', { provider, repository, limit: 5 });
    expect(hits.find((h) => h.principle.claim === 'Drift invention.')).toBeUndefined();
  });

  it('returns an unknown-item shape for a non-existent candidate id', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [], provenance);
    const result = await resolveReviewItem(
      { itemId: 'nope', action: 'confirm' },
      { provider, repository },
    );
    expect(result).toEqual({ resolved: false, reason: 'unknown-item' });
  });

  it('admits two contradictory teachings faithfully (no doctrinal adjudication at review)', async () => {
    const source: Source = {
      id: 'serm2',
      title: 'Two teachings',
      author: 'Pastor Y',
      kind: 'sermon',
      date: '2026-05-22',
      text: 'A: faith comes first. B: works come first.',
      r2Key: null,
      structureMap: { kind: 'none' },
      editionId: 'ed_seed',
    };
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [], provenance);
    await repository.upsertSource(source);
    await repository.addReviewCandidates([
      {
        id: 'serm2#manual#r0',
        sourceId: 'serm2',
        claim: 'Faith first.',
        quoteText: 'faith comes first',
        matchTier: 'no-match',
        dedupState: 'pending',
      },
      {
        id: 'serm2#manual#r1',
        sourceId: 'serm2',
        claim: 'Works first.',
        quoteText: 'works come first',
        matchTier: 'no-match',
        dedupState: 'pending',
      },
    ]);

    const a = await resolveReviewItem(
      { itemId: 'serm2#manual#r0', action: 'confirm' },
      { provider, repository },
    );
    const b = await resolveReviewItem(
      { itemId: 'serm2#manual#r1', action: 'confirm' },
      { provider, repository },
    );
    expect(a.resolved).toBe(true);
    expect(b.resolved).toBe(true);
    if (!a.resolved || !b.resolved) return;
    expect(a.outcome).toBe('admitted');
    expect(b.outcome).toBe('admitted');

    const hits = await searchPrinciples('first', { provider, repository, limit: 5 });
    const claims = hits.map((h) => h.principle.claim).sort();
    expect(claims).toContain('Faith first.');
    expect(claims).toContain('Works first.');
  });
});
