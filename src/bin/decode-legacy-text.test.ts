import { describe, expect, it } from 'vitest';

import { decodeLegacyText } from './decode-legacy-text';

describe('decodeLegacyText', () => {
  it('round-trips clean UTF-8 unchanged', () => {
    const html = '<html><body><p>We — they’ve gone.</p></body></html>';
    expect(decodeLegacyText(Buffer.from(html, 'utf8'))).toBe(html);
  });

  it('decodes Windows-1252 curly ellipsis (0x85) to U+2026', () => {
    // 0x85 is the smoking-gun byte from issue #20: it sits in valid scripture
    // chapters, breaks strict UTF-8 decode, and used to flag the whole file
    // as "binary".
    const buf = Buffer.from([
      0x77, 0x61, 0x69, 0x74, 0x85, // "wait…"
    ]);
    expect(decodeLegacyText(buf)).toBe('wait…');
  });

  it('decodes Windows-1252 curly apostrophe (0x92) to U+2019', () => {
    // "they’ve" in Windows-1252
    const buf = Buffer.from([0x74, 0x68, 0x65, 0x79, 0x92, 0x76, 0x65]);
    expect(decodeLegacyText(buf)).toBe('they’ve');
  });

  it('decodes Windows-1252 nbsp (0xA0) to U+00A0', () => {
    const buf = Buffer.from([0x61, 0xa0, 0x62]); // "a b"
    expect(decodeLegacyText(buf)).toBe('a b');
  });

  it('strips residual NUL bytes from any decoded path', () => {
    // A NUL deep in the file slips past the binary guard (which only samples
    // the first 8 KiB). The text-column insert would crash on it; the
    // decoder strips it defensively so the ingest path can never fail there.
    const buf = Buffer.from([0x61, 0x00, 0x62]);
    expect(decodeLegacyText(buf)).toBe('ab');
  });

  it('returns empty string for empty input', () => {
    expect(decodeLegacyText(Buffer.from([]))).toBe('');
  });

  it('handles a full legacy HTML chapter byte-for-byte without dropping text', () => {
    // Recreate the kind of body the old guard dropped: legacy markup whose
    // first high byte (0x85) sits well inside the 8 KiB sample window.
    const html = Buffer.concat([
      Buffer.from('<html><body><p>Genesis 1: In the beginning'),
      Buffer.from([0x85]), // curly ellipsis in Windows-1252
      Buffer.from(' and so on.</p></body></html>'),
    ]);
    const text = decodeLegacyText(html);
    expect(text).toContain('Genesis 1: In the beginning');
    expect(text).toContain('…');
    expect(text).toContain('and so on.');
    expect(text.includes('\0')).toBe(false);
  });
});
