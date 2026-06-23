import { describe, expect, it } from 'vitest';
import { InMemoryBlobStore } from './blob-store';
import { deriveLabel } from './derive-label';
import { FakeIngestProvider } from './fake-provider';
import { InMemoryRepository } from './in-memory-repository';
import { ingestLargeBookSource } from './large-book-ingest';
import { FakeSectionedPdfExtractor, type MarkerChunk } from './marker-sections';
import { r2KeyForPdfSource } from './pdf-ingest';
import type { DistilInput } from './ports';
import type { DistilledItem } from './types';

// A three-chunk book: a preface, a body chapter, and an index. Each chunk
// preserves the original-PDF page anchors (`{N}---`) — the splitter does not
// renumber them. The body chunk's page anchor jumps from 0 to 4 because pages
// 2–4 of the original PDF held the preface's body that we've broken apart.
const fixture: MarkerChunk[] = [
  {
    index: 0,
    sectionLabel: 'Preface',
    bookmarkDepth: 1,
    startPage: 1,
    markdown: '{0}---\nThis is the preface.',
  },
  {
    index: 1,
    sectionLabel: 'Chapter 1: Grace',
    bookmarkDepth: 1,
    startPage: 5,
    markdown: '{4}---\nGrace precedes obedience. We are loved first.',
  },
  {
    index: 2,
    sectionLabel: 'Index',
    bookmarkDepth: 1,
    startPage: 50,
    markdown: '{49}---\nIndex entries.',
  },
];

// Script the provider per chunk: each call's `title` carries the section label
// so the test can route distillation per chunk (the unit ADR-0010 mandates).
function perChunkScript(input: DistilInput): DistilledItem[] {
  if (input.title.endsWith('Preface')) {
    return [{ claim: 'The preface introduces the book.', quote: 'This is the preface.' }];
  }
  if (input.title.endsWith('Chapter 1: Grace')) {
    return [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
      { claim: 'We are loved first.', quote: 'We are loved first.' },
    ];
  }
  if (input.title.endsWith('Index')) {
    return [];
  }
  return [];
}

describe('ingestLargeBookSource', () => {
  it('distils per chunk, relocates against the unified Source text, and persists one Source', async () => {
    const repository = new InMemoryRepository();
    const blobs = new InMemoryBlobStore();
    const extractor = new FakeSectionedPdfExtractor(fixture);
    const provider = new FakeIngestProvider(perChunkScript);
    const pdfBytes = new TextEncoder().encode('%PDF-1.4 fake');

    const result = await ingestLargeBookSource(
      '/tmp/big-book.pdf',
      { id: 'big1', title: 'Big Book', author: 'Author', date: '2026-06-23' },
      { sectionedExtractor: extractor, blobs, provider, repository },
      { readPdf: async () => pdfBytes },
    );

    // The PDF lands in R2 under the standard key; the query store only has the pointer.
    expect(blobs.has(r2KeyForPdfSource('big1'))).toBe(true);
    const source = await repository.getSource('big1');
    expect(source).not.toBeNull();
    expect(source!.r2Key).toBe(r2KeyForPdfSource('big1'));

    // Marker page anchors are stripped from the unified text; original page
    // numbers survive in the structureMap.
    expect(source!.text).not.toContain('{0}');
    expect(source!.text).toContain('This is the preface.');
    expect(source!.text).toContain('Grace precedes obedience.');
    expect(source!.text).toContain('Index entries.');
    if (source!.structureMap.kind !== 'pdf-pages') throw new Error('expected pdf-pages');
    expect(source!.structureMap.pages.map((p) => p.page)).toEqual([1, 5, 50]);

    // Two body principles admitted, one preface principle admitted, index has nothing.
    expect(result.admitted).toBe(3);
    expect(result.review).toBe(0);

    // Each chunk's reported metadata is positioned correctly — front/body/back.
    expect(result.chunks).toEqual([
      { index: 0, sectionLabel: 'Preface', startPage: 1, position: 'front' },
      { index: 1, sectionLabel: 'Chapter 1: Grace', startPage: 5, position: 'body' },
      { index: 2, sectionLabel: 'Index', startPage: 50, position: 'back' },
    ]);

    // Each Principle's Quote relocates against the UNIFIED Source.text, so the
    // page label resolves through the unified structureMap (the original-PDF
    // page numbers, not 1/2/3 chunk-locals).
    const hits = await repository.searchByEmbedding(new Array(128).fill(0), 10);
    const byClaim = new Map(hits.map((h) => [h.principle.claim, h.principle]));

    const grace = byClaim.get('Grace precedes obedience.')!;
    expect(grace.quotes).toHaveLength(1);
    expect(grace.quotes[0]!.located).toBe(true);
    expect(deriveLabel(source!.structureMap, grace.quotes[0]!.span, source!.text.length)).toBe(
      'page 5',
    );

    const preface = byClaim.get('The preface introduces the book.')!;
    expect(deriveLabel(source!.structureMap, preface.quotes[0]!.span, source!.text.length)).toBe(
      'page 1',
    );
  });

  it('normalizes section boundaries before distil — a leaked paragraph is not double-counted', async () => {
    // The body chunk's distil output exists; the next chunk leaks the same
    // closing line. After boundary normalization that leak is gone, so the
    // model only ever sees the leaked paragraph in one chunk.
    const chunks: MarkerChunk[] = [
      {
        index: 0,
        sectionLabel: 'Chapter 1',
        bookmarkDepth: 1,
        startPage: 1,
        markdown: '{0}---\nGrace precedes obedience.\n\nThe seam paragraph here.',
      },
      {
        index: 1,
        sectionLabel: 'Chapter 2',
        bookmarkDepth: 1,
        startPage: 5,
        markdown: '{4}---\nThe seam paragraph here.\n\nA new claim follows.',
      },
    ];

    const seenChunkTexts: string[] = [];
    const provider = new FakeIngestProvider((input) => {
      seenChunkTexts.push(input.text);
      if (input.title.endsWith('Chapter 1')) {
        return [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }];
      }
      if (input.title.endsWith('Chapter 2')) {
        // Returns a claim about the seam paragraph that, post-normalization,
        // appears only in chunk 1's view of the world — chunk 2 no longer
        // contains it, so it should NOT show up when distilling chunk 2.
        return [{ claim: 'A new claim.', quote: 'A new claim follows.' }];
      }
      return [];
    });
    const extractor = new FakeSectionedPdfExtractor(chunks);
    const repository = new InMemoryRepository();
    const blobs = new InMemoryBlobStore();

    const result = await ingestLargeBookSource(
      '/tmp/x.pdf',
      { id: 'x', title: 'X', author: 'Y', date: '2026-06-23' },
      { sectionedExtractor: extractor, blobs, provider, repository },
      { readPdf: async () => new Uint8Array() },
    );

    // The boundary actions log records exactly one drop, between chunks 0 and 1.
    expect(result.boundaryActions).toHaveLength(1);
    expect(result.boundaryActions[0]!.betweenChunks).toEqual([0, 1]);
    expect(result.boundaryActions[0]!.droppedParagraph).toContain('seam paragraph');

    // Chunk 2's text as seen by the model NO longer contains the leaked seam.
    const chunk2Text = seenChunkTexts.find((t) => t.includes('A new claim follows'))!;
    expect(chunk2Text).toBeDefined();
    expect(chunk2Text).not.toContain('The seam paragraph here.');
  });

  it('re-ingest under the same provenance is idempotent — no duplicate Principles', async () => {
    const repository = new InMemoryRepository();
    const blobs = new InMemoryBlobStore();
    const extractor = new FakeSectionedPdfExtractor(fixture);
    const provider = new FakeIngestProvider(perChunkScript);

    await ingestLargeBookSource(
      '/tmp/big-book.pdf',
      { id: 'big1', title: 'Big Book', author: 'Author', date: '2026-06-23' },
      { sectionedExtractor: extractor, blobs, provider, repository },
      { readPdf: async () => new Uint8Array() },
    );
    const second = await ingestLargeBookSource(
      '/tmp/big-book.pdf',
      { id: 'big1', title: 'Big Book', author: 'Author', date: '2026-06-23' },
      { sectionedExtractor: extractor, blobs, provider, repository },
      { readPdf: async () => new Uint8Array() },
    );

    expect(second.admitted).toBe(3);
    const hits = await repository.searchByEmbedding(new Array(128).fill(0), 100);
    // Across two ingests, still 3 principles total.
    expect(hits).toHaveLength(3);
  });

  it('forwards the extraction target to the SectionedPdfExtractor', async () => {
    const repository = new InMemoryRepository();
    const blobs = new InMemoryBlobStore();
    const extractor = new FakeSectionedPdfExtractor(fixture);
    const provider = new FakeIngestProvider(() => []);

    await ingestLargeBookSource(
      '/tmp/big.pdf',
      { id: 'big2', title: 'B', author: 'A', date: '2026-06-23' },
      { sectionedExtractor: extractor, blobs, provider, repository },
      { readPdf: async () => new Uint8Array(), target: 'remote-gpu' },
    );

    expect(extractor.calls).toEqual([{ pdfPath: '/tmp/big.pdf', target: 'remote-gpu' }]);
  });
});
