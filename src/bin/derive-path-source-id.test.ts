import { describe, expect, it } from 'vitest';

import { deriveHtmlSourcePathId } from './derive-path-source-id';

describe('deriveHtmlSourcePathId', () => {
  it('returns the same id for the same path (deterministic)', () => {
    const a = deriveHtmlSourcePathId('corpus/Moon-Books/Ahn/Ahn-060721.html');
    const b = deriveHtmlSourcePathId('corpus/Moon-Books/Ahn/Ahn-060721.html');
    expect(a).toBe(b);
  });

  it('returns a stable `src-path-<hex16>` shape', () => {
    expect(deriveHtmlSourcePathId('corpus/Moon-Books/Ahn/Ahn-060721.html')).toMatch(
      /^src-path-[0-9a-f]{16}$/,
    );
  });

  it('returns different ids for different paths', () => {
    const a = deriveHtmlSourcePathId('corpus/Moon-Books/Ahn/Ahn-060721.html');
    const b = deriveHtmlSourcePathId('corpus/Moon-Books/Ahn/Ahn-070101.html');
    expect(a).not.toBe(b);
  });

  it('treats sibling files in different directories as different Sources', () => {
    const a = deriveHtmlSourcePathId('corpus/Tier-A/Author/Doc-200101.html');
    const b = deriveHtmlSourcePathId('corpus/Tier-B/Author/Doc-200101.html');
    expect(a).not.toBe(b);
  });

  it('does not collide across a shifted directory/file boundary', () => {
    // "ab/c" must not hash the same as "a/bc" — the slash is content, not a
    // structural separator the hash can ignore.
    expect(deriveHtmlSourcePathId('ab/c.html')).not.toBe(deriveHtmlSourcePathId('a/bc.html'));
  });
});
