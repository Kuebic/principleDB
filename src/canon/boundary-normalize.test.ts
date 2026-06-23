import { describe, expect, it } from 'vitest';
import { normalizeSectionBoundaries } from './boundary-normalize';
import type { MarkerChunk } from './marker-sections';

// Helper to keep the fixtures terse: same boilerplate fields, varied markdown.
function chunk(index: number, markdown: string, label = `Section ${index}`): MarkerChunk {
  return { index, sectionLabel: label, bookmarkDepth: 1, startPage: index * 10 + 1, markdown };
}

describe('normalizeSectionBoundaries', () => {
  it('strips a trailing paragraph from chunk N when it reappears at the head of chunk N+1', () => {
    const before = [
      chunk(0, '{0}---\nFirst paragraph of A.\n\nA paragraph that bleeds across the chunk boundary.'),
      chunk(1, '{2}---\nA paragraph that bleeds across the chunk boundary.\n\nSecond chunk proper content.'),
    ];
    const { chunks, actions } = normalizeSectionBoundaries(before);
    // The leaked paragraph is stripped from the *next* chunk so the section's
    // own first paragraph is what survives unchanged — the prior chunk is the
    // authoritative location for its own tail.
    expect(chunks[1]!.markdown).toContain('Second chunk proper content.');
    expect(chunks[1]!.markdown).not.toContain('A paragraph that bleeds across the chunk boundary.');
    expect(chunks[0]!.markdown).toContain('A paragraph that bleeds across the chunk boundary.');
    expect(actions).toEqual([
      {
        betweenChunks: [0, 1],
        droppedParagraph: 'A paragraph that bleeds across the chunk boundary.',
        fromChunk: 'next',
      },
    ]);
  });

  it('matches paragraphs after typographic noise (curly quotes, whitespace, hyphen-wrap)', () => {
    const before = [
      // Trailing paragraph in chunk 0 has curly quotes + a hyphen-wrapped word
      // that the chunk-1 reprise renders straight. They should still match.
      chunk(0, 'Body of chunk zero.\n\nHe said, “obey now” — even when prom-\nising.'),
      chunk(1, 'He said, "obey now" - even when promising.\n\nNew material in chunk one.'),
    ];
    const { chunks, actions } = normalizeSectionBoundaries(before);
    expect(chunks[1]!.markdown.startsWith('New material in chunk one.')).toBe(true);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.betweenChunks).toEqual([0, 1]);
  });

  it('is idempotent — re-running produces no further actions and identical chunks', () => {
    const before = [
      chunk(0, 'First.\n\nLeaked tail.'),
      chunk(1, 'Leaked tail.\n\nFresh body.'),
      chunk(2, 'Fresh body.\n\nThird chunk content.'),
    ];
    const first = normalizeSectionBoundaries(before);
    const second = normalizeSectionBoundaries(first.chunks);
    expect(second.actions).toEqual([]);
    expect(second.chunks.map((c) => c.markdown)).toEqual(first.chunks.map((c) => c.markdown));
  });

  it('drops multiple leaked paragraphs at the head of the next chunk', () => {
    const before = [
      chunk(0, 'Intro.\n\nLeak one.\n\nLeak two.'),
      chunk(1, 'Leak one.\n\nLeak two.\n\nReal chapter two start.'),
    ];
    const { chunks, actions } = normalizeSectionBoundaries(before);
    expect(chunks[1]!.markdown.startsWith('Real chapter two start.')).toBe(true);
    expect(actions.map((a) => a.droppedParagraph)).toEqual(['Leak one.', 'Leak two.']);
  });

  it('leaves chunks alone when there is no overlap', () => {
    const before = [chunk(0, 'A1.\n\nA2.'), chunk(1, 'B1.\n\nB2.')];
    const { chunks, actions } = normalizeSectionBoundaries(before);
    expect(actions).toEqual([]);
    expect(chunks.map((c) => c.markdown)).toEqual(before.map((c) => c.markdown));
  });

  it('does not strip the Marker page anchor that begins a chunk', () => {
    // The page anchor is its own line and is not a content paragraph — it must
    // survive even if a later check would consider it as the "first paragraph".
    const before = [chunk(0, 'Body of A.\n\nTail paragraph.'), chunk(1, '{5}---\nTail paragraph.\n\nReal start of B.')];
    const { chunks } = normalizeSectionBoundaries(before);
    expect(chunks[1]!.markdown).toContain('{5}---');
    expect(chunks[1]!.markdown).toContain('Real start of B.');
    expect(chunks[1]!.markdown).not.toContain('Tail paragraph.');
  });
});
