import { describe, expect, it } from 'vitest';
import { FakeIngestProvider } from '../canon/fake-provider';
import { ingestSource } from '../canon/ingest';
import { InMemoryRepository } from '../canon/in-memory-repository';
import type { Source } from '../canon/types';
import {
  getQuoteInContextTool,
  type GetQuoteInContextResponse,
} from './get-quote-in-context-tool';

const sermon: Source = {
  id: 'serm1',
  title: 'Grace and obedience',
  author: 'Pastor X',
  kind: 'sermon',
  date: '2026-05-15',
  text: 'Grace precedes obedience. We are loved first, and our obedience flows from being loved.',
  r2Key: null,
  structureMap: { kind: 'none' },
};

async function seed(quote: string): Promise<{ repository: InMemoryRepository; quoteId: string }> {
  const repository = new InMemoryRepository();
  const provider = new FakeIngestProvider(() => [{ claim: 'Grace precedes obedience.', quote }]);
  await ingestSource(sermon, { provider, repository });
  const hits = await repository.searchByEmbedding((await provider.embed(['x']))[0]!, 1);
  return { repository, quoteId: hits[0]!.principle.quotes[0]!.id };
}

describe('getQuoteInContextTool', () => {
  it("returns the source's own words at the snapped span plus context window", async () => {
    const { repository, quoteId } = await seed('Grace precedes obedience.');
    const resp: GetQuoteInContextResponse = await getQuoteInContextTool({ quoteId }, { repository });
    expect(resp.found).toBe(true);
    if (!resp.found) return;
    expect(resp.quote.text).toBe('Grace precedes obedience.');
    expect(resp.quote.contextAfter).toContain('loved first');
    expect(resp.source.title).toBe('Grace and obedience');
    expect(resp.principle.claim).toBe('Grace precedes obedience.');
  });

  it('returns a well-shaped not-found result for an unknown Quote id', async () => {
    const repository = new InMemoryRepository();
    const resp = await getQuoteInContextTool({ quoteId: 'nope' }, { repository });
    expect(resp).toEqual({ found: false });
  });
});
