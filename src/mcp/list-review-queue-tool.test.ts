import { describe, expect, it } from 'vitest';
import { FakeIngestProvider } from '../canon/fake-provider';
import { ingestSource } from '../canon/ingest';
import { InMemoryRepository } from '../canon/in-memory-repository';
import type { Source } from '../canon/types';
import { listReviewQueueTool } from './list-review-queue-tool';

const sermon: Source = {
  id: 'serm1',
  title: 'Grace and obedience',
  author: 'Pastor X',
  kind: 'sermon',
  date: '2026-05-15',
  text: 'Grace precedes obedience.',
  r2Key: null,
  structureMap: { kind: 'none' },
};

describe('listReviewQueueTool', () => {
  it('returns the queue with sourceTitle joined for each row', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Drift.', quote: 'Words never in the source.' },
    ]);
    await ingestSource(sermon, { provider, repository });
    const resp = await listReviewQueueTool({}, { repository });
    expect(resp.total).toBe(1);
    expect(resp.items[0]!.sourceTitle).toBe('Grace and obedience');
  });

  it('returns a well-shaped empty case when the queue is empty', async () => {
    const repository = new InMemoryRepository();
    const resp = await listReviewQueueTool({}, { repository });
    expect(resp).toEqual({ items: [], total: 0 });
  });
});
