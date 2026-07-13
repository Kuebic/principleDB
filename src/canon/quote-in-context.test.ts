import { describe, expect, it } from 'vitest';
import { FakeIngestProvider } from './fake-provider';
import { ingestSource } from './ingest';
import { InMemoryRepository } from './in-memory-repository';
import { getQuoteInContext, getQuoteReader } from './quote-in-context';
import type { Source } from './types';

const sermon: Source = {
  id: 'serm1',
  title: 'Grace and obedience',
  author: 'Pastor X',
  kind: 'sermon',
  date: '2026-05-15',
  text: [
    'Grace precedes obedience. ',
    'We are loved first, and our obedience flows from being loved. ',
    'The empty seat is the assignment.',
  ].join(''),
  r2Key: null,
  structureMap: { kind: 'none' },
};

async function seed(quote: string): Promise<{
  repository: InMemoryRepository;
  quoteId: string;
}> {
  const repository = new InMemoryRepository();
  const provider = new FakeIngestProvider(() => [{ claim: 'Grace precedes obedience.', quote }]);
  await ingestSource(sermon, { provider, repository });
  const hits = await repository.searchByEmbedding((await provider.embed(['anything']))[0]!, 10);
  return { repository, quoteId: hits[0]!.principle.quotes[0]!.id };
}

describe('getQuoteInContext', () => {
  it("returns the source's own words at the snapped span, plus before/after context", async () => {
    const { repository, quoteId } = await seed('Grace precedes obedience.');
    const result = await getQuoteInContext(quoteId, { repository });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.quote.text).toBe('Grace precedes obedience.');
    expect(result.quote.contextBefore).toBe('');
    expect(result.quote.contextAfter).toContain('We are loved first');
    expect(result.source.title).toBe('Grace and obedience');
    expect(result.source.kind).toBe('sermon');
    expect(result.principle.claim).toBe('Grace precedes obedience.');
  });

  it('clips the context window to a configurable character budget', async () => {
    const { repository, quoteId } = await seed('We are loved first');
    const result = await getQuoteInContext(quoteId, { repository, contextChars: 10 });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.quote.contextBefore.length).toBeLessThanOrEqual(10);
    expect(result.quote.contextAfter.length).toBeLessThanOrEqual(10);
    expect(result.quote.text).toBe('We are loved first');
  });

  it('derives a page label from a PDF structureMap (ADR-0009: label derived on read)', async () => {
    const pdf: Source = {
      id: 'pdf1',
      title: 'A Book',
      author: 'A',
      kind: 'book',
      date: '2026-01-01',
      text: 'page one content here. and more on page two now.',
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
    const hits = await repository.searchByEmbedding(
      (await provider.embed(['anything']))[0]!,
      1,
    );
    const quoteId = hits[0]!.principle.quotes[0]!.id;
    const result = await getQuoteInContext(quoteId, { repository });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.quote.label).toBe('page 1');
  });

  it('derives an enclosing heading from a text-headings structureMap', async () => {
    const article: Source = {
      id: 'art1',
      title: 'Article',
      author: 'A',
      kind: 'article',
      date: '2026-01-01',
      text: 'Intro paragraph here.\n\nSection: Grace\n\nGrace is unearned. Love comes first.',
      r2Key: null,
      structureMap: {
        kind: 'text-headings',
        headings: [
          { offset: 0, heading: 'Intro' },
          { offset: 22, heading: 'Section: Grace' },
        ],
      },
    };
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace is unearned.', quote: 'Grace is unearned.' },
    ]);
    await ingestSource(article, { provider, repository });
    const hits = await repository.searchByEmbedding(
      (await provider.embed(['anything']))[0]!,
      1,
    );
    const quoteId = hits[0]!.principle.quotes[0]!.id;
    const result = await getQuoteInContext(quoteId, { repository });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.quote.label).toBe('Section: Grace');
  });

  it('returns a well-shaped not-found result for an unknown Quote id', async () => {
    const repository = new InMemoryRepository();
    const result = await getQuoteInContext('does-not-exist', { repository });
    expect(result).toEqual({ found: false });
  });
});

describe('getQuoteReader (issue #48 — Reader shape, whole Source)', () => {
  it("returns the whole source text and structureMap alongside the located span", async () => {
    const { repository, quoteId } = await seed('Grace precedes obedience.');
    const result = await getQuoteReader(quoteId, { repository });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.source.text).toBe(sermon.text);
    expect(result.source.structureMap).toEqual({ kind: 'none' });
    expect(result.quote.span.start).toBe(0);
    expect(result.quote.span.end).toBe('Grace precedes obedience.'.length);
    expect(result.quote.label).toMatch(/~\d+% in/);
    expect(result.principle.claim).toBe('Grace precedes obedience.');
  });

  it('carries the source structureMap so the outline can be rendered', async () => {
    const article: Source = {
      id: 'art1',
      title: 'Article',
      author: 'A',
      kind: 'article',
      date: '2026-01-01',
      text: 'Intro paragraph here.\n\nSection: Grace\n\nGrace is unearned. Love comes first.',
      r2Key: null,
      structureMap: {
        kind: 'text-headings',
        headings: [
          { offset: 0, heading: 'Intro' },
          { offset: 22, heading: 'Section: Grace' },
        ],
      },
    };
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace is unearned.', quote: 'Grace is unearned.' },
    ]);
    await ingestSource(article, { provider, repository });
    const hits = await repository.searchByEmbedding(
      (await provider.embed(['anything']))[0]!,
      1,
    );
    const quoteId = hits[0]!.principle.quotes[0]!.id;
    const result = await getQuoteReader(quoteId, { repository });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.source.structureMap).toEqual({
      kind: 'text-headings',
      headings: [
        { offset: 0, heading: 'Intro' },
        { offset: 22, heading: 'Section: Grace' },
      ],
    });
    expect(result.quote.label).toBe('Section: Grace');
  });

  it('returns { found: false } for an unknown Quote id', async () => {
    const repository = new InMemoryRepository();
    const result = await getQuoteReader('does-not-exist', { repository });
    expect(result).toEqual({ found: false });
  });
});
