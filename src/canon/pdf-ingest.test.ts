import { describe, expect, it } from 'vitest';
import { InMemoryBlobStore } from './blob-store';
import { deriveLabel } from './derive-label';
import { FakeIngestProvider } from './fake-provider';
import { InMemoryRepository } from './in-memory-repository';
import {
  FakePdfExtractor,
  type ExtractionTarget,
  type PdfExtractor,
} from './marker';
import { ingestPdfSource, planDistilWindows, r2KeyForPdfSource } from './pdf-ingest';
import type { Source, StructureMap } from './types';

// Annotated fixture mimicking Marker's `--paginate_output` markdown. Page 1
// ends mid-sentence so a quote that bridges the page break exercises both the
// cross-break relocation and the page-range label derivation.
const fixture = [
  '{0}------------------------------------------------',
  'Grace precedes obedience. We are loved first, and our obedience flows from being loved.',
  'This concludes the first part. ',
  '{1}------------------------------------------------',
  'But the second part begins now.',
  'Service follows from love, never the reverse.',
].join('\n');

describe('ingestPdfSource (integration: Marker output → Canon)', () => {
  it('stores the PDF in R2 and produces page-located Principles from Marker markdown', async () => {
    const repository = new InMemoryRepository();
    const blobs = new InMemoryBlobStore();
    const extractor = new FakePdfExtractor(fixture);
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
      { claim: 'Service follows from love.', quote: 'Service follows from love' },
    ]);
    const fakePdfBytes = new TextEncoder().encode('%PDF-1.4 fake bytes');

    const result = await ingestPdfSource(
      '/tmp/sample.pdf',
      { id: 'src1', title: 'Sample', author: 'Pastor X', date: '2026-06-19' },
      { extractor, blobs, provider, repository },
      { readPdf: async () => fakePdfBytes },
    );

    // R2 storage: the original PDF goes to the blob lake under a deterministic key.
    expect(blobs.has(r2KeyForPdfSource('src1'))).toBe(true);
    const stored = await blobs.get(r2KeyForPdfSource('src1'));
    expect(stored).not.toBeNull();
    expect(stored!.byteLength).toBe(fakePdfBytes.byteLength);

    // Query store keeps only a pointer; not the PDF.
    const source = await repository.getSource('src1');
    expect(source).not.toBeNull();
    expect(source!.r2Key).toBe(r2KeyForPdfSource('src1'));
    expect(source!.kind).toBe('book');

    // Marker's markdown IS the Source's continuous text — separators stripped.
    expect(source!.text).toContain('Grace precedes obedience');
    expect(source!.text).toContain('Service follows from love');
    expect(source!.text).not.toContain('{0}');
    expect(source!.text).not.toContain('{1}');

    // structureMap is pdf-pages, with one entry per Marker page anchor (1-indexed).
    expect(source!.structureMap.kind).toBe('pdf-pages');
    if (source!.structureMap.kind !== 'pdf-pages') throw new Error();
    expect(source!.structureMap.pages.map((p) => p.page)).toEqual([1, 2]);

    // Both principles are admitted; page labels resolve from the structureMap.
    expect(result.admitted).toBe(2);
    const hits = await repository.searchByEmbedding(new Array(128).fill(0), 10);
    const byClaim = new Map(hits.map((h) => [h.principle.claim, h.principle]));

    const grace = byClaim.get('Grace precedes obedience.')!;
    const graceLabel = deriveLabel(source!.structureMap, grace.quotes[0]!.span, source!.text.length);
    expect(graceLabel).toBe('page 1');

    const service = byClaim.get('Service follows from love.')!;
    const serviceLabel = deriveLabel(
      source!.structureMap,
      service.quotes[0]!.span,
      source!.text.length,
    );
    expect(serviceLabel).toBe('page 2');
  });

  it('cross-break case: a Quote whose span crosses a page break relocates and its label is a page range', async () => {
    const repository = new InMemoryRepository();
    const blobs = new InMemoryBlobStore();
    const extractor = new FakePdfExtractor(fixture);
    const provider = new FakeIngestProvider(() => [
      {
        claim: 'The teaching continues across the page break.',
        // This span starts on page 1 and ends on page 2.
        quote: 'This concludes the first part. But the second part begins now.',
      },
    ]);

    await ingestPdfSource(
      '/tmp/sample.pdf',
      { id: 'src1', title: 'Sample', author: 'X', date: '2026-06-19' },
      { extractor, blobs, provider, repository },
      { readPdf: async () => new Uint8Array() },
    );

    const source = await repository.getSource('src1');
    expect(source).not.toBeNull();
    const hits = await repository.searchByEmbedding(new Array(128).fill(0), 10);
    expect(hits).toHaveLength(1);
    const quote = hits[0]!.principle.quotes[0]!;
    expect(quote.located).toBe(true);

    // The snapped span is in Source-text offsets and crosses the page boundary,
    // so deriveLabel falls out to a page range — exactly the ADR-0007 / ADR-0009 contract.
    const label = deriveLabel(source!.structureMap, quote.span, source!.text.length);
    expect(label).toBe('pages 1–2');
  });

  it('forwards the extraction target (cpu vs remote-gpu) to the extractor', async () => {
    const repository = new InMemoryRepository();
    const blobs = new InMemoryBlobStore();
    const calls: Array<{ pdfPath: string; target: ExtractionTarget }> = [];
    const extractor: PdfExtractor = {
      async extract(pdfPath, opts) {
        calls.push({ pdfPath, target: opts.target });
        return { markdown: '{0}---\nGrace precedes obedience.' };
      },
    };
    const provider = new FakeIngestProvider(() => []);

    await ingestPdfSource(
      '/tmp/a.pdf',
      { id: 'a', title: 'A', author: 'X', date: '2026-06-19' },
      { extractor, blobs, provider, repository },
      { readPdf: async () => new Uint8Array(), target: 'remote-gpu' },
    );
    await ingestPdfSource(
      '/tmp/b.pdf',
      { id: 'b', title: 'B', author: 'X', date: '2026-06-19' },
      { extractor, blobs, provider, repository },
      { readPdf: async () => new Uint8Array() },
    );

    expect(calls).toEqual([
      { pdfPath: '/tmp/a.pdf', target: 'remote-gpu' },
      { pdfPath: '/tmp/b.pdf', target: 'cpu' },
    ]);
  });
});

// Build a Source whose text is `pageChars` pages of filler, with a pdf-pages
// structureMap anchoring each page's start offset.
function pageSource(pageChars: number[]): Source {
  let text = '';
  const pages: Array<{ offset: number; page: number }> = [];
  pageChars.forEach((len, i) => {
    pages.push({ offset: text.length, page: i + 1 });
    text += 'x'.repeat(len);
  });
  const structureMap: StructureMap = { kind: 'pdf-pages', pages };
  return { id: 's', title: 'T', author: 'A', kind: 'book', date: '', text, r2Key: null, structureMap };
}

function tiles(windows: { start: number; end: number }[], total: number): boolean {
  if (windows[0]!.start !== 0 || windows[windows.length - 1]!.end !== total) return false;
  for (let i = 1; i < windows.length; i++) if (windows[i]!.start !== windows[i - 1]!.end) return false;
  return true;
}

describe('planDistilWindows', () => {
  it('returns one window when the text fits maxChars', () => {
    const src = pageSource([50, 50]);
    expect(planDistilWindows(src, 1000)).toEqual([{ start: 0, end: 100, titleSuffix: '' }]);
  });

  it('packs whole pages into windows under maxChars and labels page ranges', () => {
    const src = pageSource([50, 50, 50, 50]); // total 200
    const w = planDistilWindows(src, 120);
    expect(w).toHaveLength(2);
    expect(tiles(w, 200)).toBe(true);
    for (const win of w) expect(win.end - win.start).toBeLessThanOrEqual(120);
    expect(w[0]!.titleSuffix).toBe(' (pages 1–2)');
    expect(w[1]!.titleSuffix).toBe(' (pages 3–4)');
  });

  it('keeps an over-size single page as its own window (no zero-length tail)', () => {
    const src = pageSource([300]); // one page bigger than maxChars
    const w = planDistilWindows(src, 120);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ start: 0, end: 300 });
    expect(tiles(w, 300)).toBe(true);
  });

  it('falls back to a hard char split when there is no page structure', () => {
    const src: Source = {
      id: 's', title: 'T', author: 'A', kind: 'book', date: '',
      text: 'x'.repeat(250), r2Key: null, structureMap: { kind: 'none' },
    };
    const w = planDistilWindows(src, 100);
    expect(w.map((x) => [x.start, x.end])).toEqual([[0, 100], [100, 200], [200, 250]]);
    expect(tiles(w, 250)).toBe(true);
  });
});

describe('ingestPdfSource with maxDistilChars', () => {
  it('distils the text in multiple windows and still admits + locates principles', async () => {
    const repository = new InMemoryRepository();
    const blobs = new InMemoryBlobStore();
    // Two pages, each with its own locatable sentence.
    const md = [
      '{0}------------------------------------------------',
      'Grace precedes obedience in all things and forever.',
      '{1}------------------------------------------------',
      'Service follows from love and never the reverse at all.',
    ].join('\n');
    const extractor = new FakePdfExtractor(md);
    let distilCalls = 0;
    const provider = new FakeIngestProvider((input) => {
      distilCalls++;
      // Return a claim only for the sentence present in this window's text.
      const out: Array<{ claim: string; quote: string }> = [];
      if (input.text.includes('Grace precedes obedience'))
        out.push({ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience' });
      if (input.text.includes('Service follows from love'))
        out.push({ claim: 'Service follows from love.', quote: 'Service follows from love' });
      return out;
    });

    const result = await ingestPdfSource(
      '/tmp/big.pdf',
      { id: 'big', title: 'Big Book', author: 'X', date: '2026-06-19' },
      { extractor, blobs, provider, repository },
      { readPdf: async () => new Uint8Array(), maxDistilChars: 55 },
    );

    // The ~106-char text split into >1 window → more than one distil call.
    expect(distilCalls).toBeGreaterThan(1);
    // Both windows' principles land on the one unified Source.
    expect(result.admitted).toBe(2);
    const source = await repository.getSource('big');
    expect(source!.structureMap.kind).toBe('pdf-pages');
    const hits = await repository.searchByEmbedding(new Array(128).fill(0), 10);
    expect(hits.every((h) => h.principle.quotes[0]!.located)).toBe(true);
  });
});
