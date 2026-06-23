import { describe, expect, it } from 'vitest';
import { FakePdfExtractor, parseMarkerOutput } from './marker';

describe('parseMarkerOutput', () => {
  it('strips Marker page separators and emits a pdf-pages structureMap', () => {
    const annotated = [
      '{0}------------------------------------------------',
      'Grace precedes obedience. We are loved first.',
      '{1}------------------------------------------------',
      'Service follows from love.',
    ].join('\n');
    const { text, structureMap } = parseMarkerOutput(annotated);
    expect(text).toBe(
      'Grace precedes obedience. We are loved first.\nService follows from love.',
    );
    expect(structureMap).toEqual({
      kind: 'pdf-pages',
      pages: [
        { offset: 0, page: 1 },
        { offset: 'Grace precedes obedience. We are loved first.\n'.length, page: 2 },
      ],
    });
  });

  it('converts Marker 0-indexed page numbers to 1-indexed labels', () => {
    const annotated = '{0}---\nA\n{1}---\nB\n{2}---\nC';
    const { structureMap } = parseMarkerOutput(annotated);
    if (structureMap.kind !== 'pdf-pages') throw new Error('expected pdf-pages');
    expect(structureMap.pages.map((p) => p.page)).toEqual([1, 2, 3]);
  });

  it('tolerates leading whitespace before the first separator', () => {
    const { text, structureMap } = parseMarkerOutput('\n\n{0}---\nHello');
    expect(text).toBe('Hello');
    if (structureMap.kind !== 'pdf-pages') throw new Error('expected pdf-pages');
    expect(structureMap.pages).toEqual([{ offset: 0, page: 1 }]);
  });

  it('preserves multi-line page content verbatim within a page', () => {
    const annotated = '{0}---\nLine one of page 1.\nLine two of page 1.\n{1}---\nPage 2.';
    const { text, structureMap } = parseMarkerOutput(annotated);
    expect(text).toBe('Line one of page 1.\nLine two of page 1.\nPage 2.');
    if (structureMap.kind !== 'pdf-pages') throw new Error('expected pdf-pages');
    expect(structureMap.pages).toEqual([
      { offset: 0, page: 1 },
      { offset: 'Line one of page 1.\nLine two of page 1.\n'.length, page: 2 },
    ]);
  });

  it('the structureMap offsets point at the first character of each page in the clean text', () => {
    const annotated = '{0}---\nFirst.\n{1}---\nSecond.\n{2}---\nThird.';
    const { text, structureMap } = parseMarkerOutput(annotated);
    if (structureMap.kind !== 'pdf-pages') throw new Error('expected pdf-pages');
    for (const { offset, page } of structureMap.pages) {
      const expectedFirstChar = page === 1 ? 'F' : page === 2 ? 'S' : 'T';
      expect(text[offset]).toBe(expectedFirstChar);
    }
  });

  it('returns kind: pdf-pages with empty pages when no separators are present', () => {
    const { text, structureMap } = parseMarkerOutput('Some raw text\nwith no anchors');
    expect(text).toBe('Some raw text\nwith no anchors');
    expect(structureMap).toEqual({ kind: 'pdf-pages', pages: [] });
  });
});

describe('FakePdfExtractor', () => {
  it('returns the scripted markdown regardless of the target', async () => {
    const extractor = new FakePdfExtractor('{0}---\nHello');
    const cpu = await extractor.extract('/x.pdf', { target: 'cpu' });
    const gpu = await extractor.extract('/x.pdf', { target: 'remote-gpu' });
    expect(cpu.markdown).toBe('{0}---\nHello');
    expect(gpu.markdown).toBe('{0}---\nHello');
  });

  it('records the target each call was made with', async () => {
    const extractor = new FakePdfExtractor('{0}---\nx');
    await extractor.extract('/a.pdf', { target: 'cpu' });
    await extractor.extract('/b.pdf', { target: 'remote-gpu' });
    expect(extractor.calls).toEqual([
      { pdfPath: '/a.pdf', target: 'cpu' },
      { pdfPath: '/b.pdf', target: 'remote-gpu' },
    ]);
  });
});
