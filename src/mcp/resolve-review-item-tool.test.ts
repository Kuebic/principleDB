import { describe, expect, it } from 'vitest';
import { FakeIngestProvider } from '../canon/fake-provider';
import { ingestSource } from '../canon/ingest';
import { InMemoryRepository } from '../canon/in-memory-repository';
import type { Source } from '../canon/types';
import { resolveReviewItemTool } from './resolve-review-item-tool';

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

async function seedDrift(): Promise<{
  repository: InMemoryRepository;
  provider: FakeIngestProvider;
  itemId: string;
}> {
  const repository = new InMemoryRepository();
  const provider = new FakeIngestProvider(() => [
    { claim: 'Drift.', quote: 'Words not in source.' },
  ]);
  await ingestSource(sermon, { provider, repository });
  return { repository, provider, itemId: repository.reviewCandidates()[0]!.id };
}

describe('resolveReviewItemTool', () => {
  it('confirm declines when the candidate still does not relocate', async () => {
    const { repository, provider, itemId } = await seedDrift();
    const resp = await resolveReviewItemTool(
      { itemId, action: 'confirm' },
      { provider, repository },
    );
    expect(resp).toEqual({ resolved: false, reason: 'still-no-match' });
  });

  it('correct admits when the Owner supplies a relocating quote', async () => {
    const { repository, provider, itemId } = await seedDrift();
    const resp = await resolveReviewItemTool(
      {
        itemId,
        action: 'correct',
        quoteText: 'We are loved first.',
        claim: 'Loved first.',
      },
      { provider, repository },
    );
    expect(resp.resolved).toBe(true);
    if (!resp.resolved) return;
    expect(resp.outcome).toBe('admitted');
  });

  it('reject drops the candidate', async () => {
    const { repository, provider, itemId } = await seedDrift();
    const resp = await resolveReviewItemTool(
      { itemId, action: 'reject' },
      { provider, repository },
    );
    expect(resp).toEqual({ resolved: true, outcome: 'rejected' });
    expect(repository.reviewCandidates()).toHaveLength(0);
  });

  it('returns an unknown-item shape for an unknown id', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => []);
    const resp = await resolveReviewItemTool(
      { itemId: 'nope', action: 'confirm' },
      { provider, repository },
    );
    expect(resp).toEqual({ resolved: false, reason: 'unknown-item' });
  });
});
