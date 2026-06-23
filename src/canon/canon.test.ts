import { describe, expect, it } from 'vitest';
import { admit, provenanceTag } from './admission';
import { alnumize, normalize } from './normalize';
import { relocate } from './relocate';
import type { DistilProvenance, Source } from './types';

describe('normalize', () => {
  it('lowercases ASCII letters', () => {
    expect(normalize('Hello').text).toBe('hello');
  });

  it('folds curly double quotes to straight, origin spans the single curly char', () => {
    const n = normalize('“foo”');
    expect(n.text).toBe('"foo"');
    expect(n.originMap[0]).toEqual({ sourceStart: 0, sourceEnd: 1 });
    expect(n.originMap[4]).toEqual({ sourceStart: 4, sourceEnd: 5 });
  });

  it('expands the fi ligature, both output chars point at the single source char', () => {
    const n = normalize('ﬁrm');
    expect(n.text).toBe('firm');
    expect(n.originMap[0]).toEqual({ sourceStart: 0, sourceEnd: 1 });
    expect(n.originMap[1]).toEqual({ sourceStart: 0, sourceEnd: 1 });
    expect(n.originMap[2]).toEqual({ sourceStart: 1, sourceEnd: 2 });
    expect(n.originMap[3]).toEqual({ sourceStart: 2, sourceEnd: 3 });
  });

  it('joins hyphen-wrapped words across a newline', () => {
    expect(normalize('affir-\nmation').text).toBe('affirmation');
  });

  it('collapses whitespace runs to a single space', () => {
    expect(normalize('hello   world').text).toBe('hello world');
  });

  it('leaves a bare hyphen between word chars on the same line alone', () => {
    expect(normalize('open-source').text).toBe('open-source');
  });
});

describe('alnumize', () => {
  it('strips bracketed editorial insertion', () => {
    const a = alnumize(normalize('love [our] neighbour'));
    expect(a.text).toBe('love our neighbour');
  });

  it('trims trailing non-alnum so the output ends on a letter or digit', () => {
    const a = alnumize(normalize('hello...'));
    expect(a.text).toBe('hello');
  });
});

describe('relocate', () => {
  it('returns exact tier on byte-exact match', () => {
    const source = 'Grace precedes obedience.';
    const r = relocate(source, 'Grace precedes obedience');
    expect(r.matchTier).toBe('exact');
    expect(r.span).toEqual({ start: 0, end: 24 });
    expect(source.slice(r.span!.start, r.span!.end)).toBe('Grace precedes obedience');
  });

  it("silently straightens curly quotes; span lands on the source's own curly text", () => {
    const source = 'He said “grace” plainly.';
    const r = relocate(source, '"grace"');
    expect(r.matchTier).toBe('normalized');
    expect(r.located).toBe(true);
    expect(source.slice(r.span!.start, r.span!.end)).toBe('“grace”');
  });

  it('locates a hyphen-wrapped word across a newline and carries the wrap inside the span', () => {
    const source = 'We need affir-\nmation here.';
    const r = relocate(source, 'affirmation');
    expect(r.matchTier).toBe('normalized');
    expect(source.slice(r.span!.start, r.span!.end)).toBe('affir-\nmation');
  });

  it('locates around a fi ligature and the span includes the ligature char', () => {
    // The 3-char 'ﬃ' ligature (U+FB03) isn't in our table; covering the simpler
    // 2-char 'ﬁ' (U+FB01) is enough to demonstrate the ligature path.
    const source = 'We aﬁrm this.';
    const r = relocate(source, 'afirm');
    expect(r.matchTier).toBe('normalized');
    expect(source.slice(r.span!.start, r.span!.end)).toBe('aﬁrm');
  });

  it('locates a quote whose span crosses a "page break" in continuous text (ADR-0009)', () => {
    const source = 'The first sentence ends here.\nThe second sentence begins on a new page.';
    const r = relocate(source, 'ends here. The second sentence');
    expect(r.located).toBe(true);
    expect(r.matchTier).toBe('normalized');
    expect(source.slice(r.span!.start, r.span!.end)).toBe('ends here.\nThe second sentence');
  });

  it('returns no-match for a pull-quote fragment that does not appear contiguously', () => {
    const source = 'Body text says one thing. More body text follows.';
    const r = relocate(source, 'Death is not your termination, but your transition into eternity.');
    expect(r.matchTier).toBe('no-match');
    expect(r.located).toBe(false);
    expect(r.span).toBeNull();
  });

  it('returns no-match for OCR garble that is genuinely not in the source', () => {
    // The spike saw scan speckles like `b Trail` — letters in a sequence that
    // never occurs in the underlying text.
    const r = relocate('When old age comes, embrace it.', 'b Trail xyzq');
    expect(r.matchTier).toBe('no-match');
  });

  it('returns no-match for Drift invention not present in the source', () => {
    const r = relocate('Grace precedes obedience.', 'Faith comes before grace.');
    expect(r.matchTier).toBe('no-match');
  });

  it('alnum tier recovers across a bracketed editorial insertion', () => {
    const source = 'love [our] neighbour';
    const r = relocate(source, 'love our neighbour');
    expect(r.matchTier).toBe('alnum');
    expect(source.slice(r.span!.start, r.span!.end)).toBe('love [our] neighbour');
  });

  it('prefers exact over normalized when both would match', () => {
    const source = 'Grace.\nGrace.';
    const r = relocate(source, 'Grace.');
    expect(r.matchTier).toBe('exact');
    expect(r.span).toEqual({ start: 0, end: 6 });
  });

  it('returns no-match for empty quote', () => {
    expect(relocate('hello', '').matchTier).toBe('no-match');
  });
});

const provenance: DistilProvenance = {
  distilModel: 'claude-opus-4-8',
  distilModelVersion: '2026-06-19',
  distilPromptVersion: 'v1',
};

const sermon: Source = {
  id: 's1',
  title: 'Grace and obedience',
  author: 'Pastor X',
  kind: 'sermon',
  date: '2026-05-15',
  text: 'Grace precedes obedience. We are loved before we obey.',
  r2Key: null,
  structureMap: { kind: 'none' },
};

describe('admit', () => {
  it('routes a located item to a Principle and stamps provenance on Principle and Quote', () => {
    const r = admit(sermon, [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }], provenance);
    expect(r.principles).toHaveLength(1);
    expect(r.reviewCandidates).toHaveLength(0);
    const p = r.principles[0]!;
    expect(p.distilModel).toBe('claude-opus-4-8');
    expect(p.distilModelVersion).toBe('2026-06-19');
    expect(p.distilPromptVersion).toBe('v1');
    const q = p.quotes[0]!;
    expect(q.located).toBe(true);
    expect(q.distilPromptVersion).toBe('v1');
    expect(sermon.text.slice(q.span.start, q.span.end)).toBe('Grace precedes obedience.');
  });

  it('routes an unlocatable item to ReviewCandidates and not the Canon', () => {
    const r = admit(sermon, [{ claim: 'Invented.', quote: 'Words not in the source.' }], provenance);
    expect(r.principles).toHaveLength(0);
    expect(r.reviewCandidates).toHaveLength(1);
    expect(r.reviewCandidates[0]!.matchTier).toBe('no-match');
  });

  it('splits a mixed batch deterministically; IDs come from (sourceId, provenance, index)', () => {
    const items = [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
      { claim: 'Invented.', quote: 'Faith comes from nowhere.' },
      { claim: 'Loved first.', quote: 'We are loved before we obey.' },
    ];
    const r = admit(sermon, items, provenance);
    const tag = provenanceTag(provenance);
    expect(r.principles.map((p) => p.id)).toEqual([`s1#${tag}#p0`, `s1#${tag}#p2`]);
    expect(r.reviewCandidates[0]!.id).toBe(`s1#${tag}#r1`);
  });

  it('different provenance yields different IDs so additivity does not collide on the PK', () => {
    const items = [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
    ];
    const provB: DistilProvenance = {
      distilModel: 'claude-sonnet-4-6',
      distilModelVersion: '2026-06-19',
      distilPromptVersion: 'v1',
    };
    const a = admit(sermon, items, provenance).principles[0]!;
    const b = admit(sermon, items, provB).principles[0]!;
    expect(a.id).not.toBe(b.id);
  });

  it('links each Principle to its own Quote by principleId', () => {
    const r = admit(sermon, [{ claim: 'Grace.', quote: 'Grace precedes obedience.' }], provenance);
    const p = r.principles[0]!;
    expect(p.quotes[0]!.principleId).toBe(p.id);
  });
});
