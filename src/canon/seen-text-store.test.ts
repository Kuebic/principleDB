// Tests for the pure `normalizedTextHash` — the dedup-pre-pass hash that
// folds whitespace-variant captures onto a single key without folding away
// genuinely different content (partial-vs-full captures stay distinct, per
// PRD #11). Drives the central "what counts as a dupe?" definition without
// needing a store.

import { describe, expect, it } from 'vitest';

import { normalizedTextHash } from './seen-text-store';

describe('normalizedTextHash', () => {
  it('returns the same hash for byte-identical text', () => {
    const text = 'Hello world. This is a sentence.';
    expect(normalizedTextHash(text)).toBe(normalizedTextHash(text));
  });

  it('collapses whitespace variants onto the same hash', () => {
    const a = 'Hello world.\n\nThis is a sentence.';
    const b = 'Hello   world.   This   is a sentence.';
    const c = 'Hello\tworld.\nThis is a\nsentence.';
    const h = normalizedTextHash(a);
    expect(normalizedTextHash(b)).toBe(h);
    expect(normalizedTextHash(c)).toBe(h);
  });

  it('treats case-variant text as the same hash (normalize lowercases)', () => {
    expect(normalizedTextHash('Hello World')).toBe(normalizedTextHash('hello world'));
  });

  it('returns a different hash for genuinely different text (partial vs full)', () => {
    const full =
      'Hello world. This is the full document with many sentences continuing on.';
    const partial = 'Hello world. This is the full document.';
    expect(normalizedTextHash(full)).not.toBe(normalizedTextHash(partial));
  });

  it('returns a stable 64-char hex shape (SHA-256)', () => {
    expect(normalizedTextHash('anything at all')).toMatch(/^[0-9a-f]{64}$/);
  });
});
