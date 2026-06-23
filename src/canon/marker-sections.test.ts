import { describe, expect, it } from 'vitest';
import { FakeSectionedPdfExtractor, type MarkerChunk } from './marker-sections';

const chunks: MarkerChunk[] = [
  {
    index: 0,
    sectionLabel: 'Preface',
    bookmarkDepth: 1,
    startPage: 1,
    markdown: '{0}---\nA preface line.',
  },
  {
    index: 1,
    sectionLabel: 'Chapter 1',
    bookmarkDepth: 1,
    startPage: 3,
    markdown: '{2}---\nChapter 1 body.',
  },
];

describe('FakeSectionedPdfExtractor', () => {
  it('returns the scripted chunks regardless of target', async () => {
    const extractor = new FakeSectionedPdfExtractor(chunks);
    const cpu = await extractor.extract('/x.pdf', { target: 'cpu' });
    const gpu = await extractor.extract('/x.pdf', { target: 'remote-gpu' });
    expect(cpu).toEqual(chunks);
    expect(gpu).toEqual(chunks);
  });

  it('records the target each call was made with so tests can assert routing', async () => {
    const extractor = new FakeSectionedPdfExtractor(chunks);
    await extractor.extract('/a.pdf', { target: 'cpu' });
    await extractor.extract('/b.pdf', { target: 'remote-gpu' });
    expect(extractor.calls).toEqual([
      { pdfPath: '/a.pdf', target: 'cpu' },
      { pdfPath: '/b.pdf', target: 'remote-gpu' },
    ]);
  });
});
