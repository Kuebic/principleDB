import { describe, expect, it } from 'vitest';
import { FakeIngestProvider } from '../canon/fake-provider';
import { ingestSource } from '../canon/ingest';
import { InMemoryRepository } from '../canon/in-memory-repository';
import type { Source } from '../canon/types';
import { searchPrinciplesTool } from './search-principles-tool';

const sermon: Source = {
  id: 'serm1',
  title: 'Grace and obedience',
  author: 'Pastor X',
  kind: 'sermon',
  date: '2026-05-15',
  text: 'Grace precedes obedience. We are loved first.',
  r2Key: null,
  structureMap: { kind: 'none' },
};

describe('searchPrinciplesTool', () => {
  it("golden test: displayed quote is the source's own words at the snapped span", async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
    ]);
    await ingestSource(sermon, { provider, repository });

    const resp = await searchPrinciplesTool({ query: 'grace and obedience' }, { provider, repository });
    expect(resp.hits).toHaveLength(1);
    const hit = resp.hits[0]!;
    expect(hit.principleId).toMatch(/^serm1#[0-9a-f]{8}#p0$/);
    expect(hit.claim).toBe('Grace precedes obedience.');
    expect(hit.quote.text).toBe('Grace precedes obedience.');
    expect(hit.source.title).toBe('Grace and obedience');
    expect(hit.source.author).toBe('Pastor X');
    expect(hit.source.kind).toBe('sermon');
  });

  it('returns a well-shaped empty case ({ hits: [] })', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => []);
    const resp = await searchPrinciplesTool({ query: 'anything' }, { provider, repository });
    expect(resp).toEqual({ hits: [] });
  });

  it('derives a "page N" label for a span on a single page', async () => {
    const pdf: Source = {
      id: 'pdf1',
      title: 'A Book',
      author: 'A',
      kind: 'book',
      date: '2026-01-01',
      text: 'page one content here. and more.',
      r2Key: 'r2://k',
      structureMap: {
        kind: 'pdf-pages',
        pages: [
          { offset: 0, page: 1 },
          { offset: 22, page: 2 },
        ],
      },
    };
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Page one stuff.', quote: 'page one content here.' },
    ]);
    await ingestSource(pdf, { provider, repository });
    const resp = await searchPrinciplesTool({ query: 'page one' }, { provider, repository });
    expect(resp.hits[0]!.quote.label).toBe('page 1');
  });

  it('derives a "pages N–M" label for a span that crosses a page break (ADR-0009: no special case)', async () => {
    const pdf: Source = {
      id: 'pdf2',
      title: 'A Book',
      author: 'A',
      kind: 'book',
      date: '2026-01-01',
      text: 'page one ends here.\npage two begins here.',
      r2Key: 'r2://k',
      structureMap: {
        kind: 'pdf-pages',
        pages: [
          { offset: 0, page: 1 },
          { offset: 20, page: 2 },
        ],
      },
    };
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Spans a break.', quote: 'ends here. page two begins' },
    ]);
    await ingestSource(pdf, { provider, repository });
    const resp = await searchPrinciplesTool({ query: 'spans a break' }, { provider, repository });
    expect(resp.hits[0]!.quote.label).toBe('pages 1–2');
  });

  it('derives a "~NN% in" position fraction for a Source with no structure map', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Loved first.', quote: 'We are loved first.' },
    ]);
    await ingestSource(sermon, { provider, repository });
    const resp = await searchPrinciplesTool({ query: 'loved first' }, { provider, repository });
    expect(resp.hits[0]!.quote.label).toMatch(/^~\d+% in$/);
  });

  it('honours the default limit (5) and accepts an override', async () => {
    const items = Array.from({ length: 7 }, (_, i) => ({
      claim: `Claim ${i}.`,
      quote: i % 2 === 0 ? 'Grace precedes obedience.' : 'We are loved first.',
    }));
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => items);
    await ingestSource(sermon, { provider, repository });
    const defaultResp = await searchPrinciplesTool({ query: 'grace' }, { provider, repository });
    expect(defaultResp.hits.length).toBeLessThanOrEqual(5);
    const widerResp = await searchPrinciplesTool({ query: 'grace', limit: 10 }, { provider, repository });
    expect(widerResp.hits.length).toBeGreaterThan(defaultResp.hits.length);
  });
});
