import { describe, expect, it } from 'vitest';

import { isLikelyBinary } from './binary-guard';

describe('isLikelyBinary — magic-byte detection (issue #20)', () => {
  it('flags JPEG/JFIF by leading 0xFF 0xD8 0xFF magic', () => {
    const jfif = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
    ]);
    expect(isLikelyBinary(jfif)).toBe(true);
  });

  it('flags GIF by leading "GIF8" magic', () => {
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x01, 0x00])]);
    expect(isLikelyBinary(gif)).toBe(true);
  });

  it('flags PNG by leading 0x89 0x50 0x4E 0x47 magic', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(isLikelyBinary(png)).toBe(true);
  });

  it('flags PDF by leading "%PDF" magic', () => {
    const pdf = Buffer.from('%PDF-1.4\n');
    expect(isLikelyBinary(pdf)).toBe(true);
  });

  it('flags content with NUL bytes (binary backstop for unknown formats)', () => {
    const buf = Buffer.alloc(2000, 0x20);
    buf[1500] = 0x00;
    expect(isLikelyBinary(buf)).toBe(true);
  });

  it('does NOT flag Windows-1252 text containing 0x85 / 0x92 / 0xA0', () => {
    // Real corpus pattern: legacy chapter with curly ellipsis (0x85), curly
    // apostrophe (0x92), and nbsp (0xA0). Previously dropped as "binary"
    // because strict UTF-8 decode failed; new contract keeps it for transcode.
    const html = Buffer.from(
      '<html><body><p>And God said the prophets vision came.</p></body></html>',
      'binary',
    );
    expect(isLikelyBinary(html)).toBe(false);
  });

  it('does NOT flag a file with a high byte past the 8 KiB window', () => {
    // The old guard's verdict depended on WHERE the first high byte fell
    // (Genesis-08 slipped through, Genesis-01 was dropped). New rule is
    // window-independent: no magic, no NUL → not binary.
    const buf = Buffer.alloc(10_000, 0x20);
    buf[9000] = 0x85;
    expect(isLikelyBinary(buf)).toBe(false);
  });

  it('does NOT flag content with invalid-UTF-8 byte sequences but no magic/NUL', () => {
    // 0xC3 0xFF is invalid UTF-8 but valid Windows-1252 (Ã ÿ). The old guard
    // rejected this as binary; the new guard delegates to the transcoder.
    expect(isLikelyBinary(Buffer.from([0xc3, 0xff, 0xc3, 0xff]))).toBe(false);
  });

  it('accepts valid HTML markup', () => {
    const html = '<html><body><p>hello world</p></body></html>';
    expect(isLikelyBinary(Buffer.from(html, 'utf8'))).toBe(false);
  });

  it('accepts multi-byte UTF-8 prose (em-dash, curly apostrophe)', () => {
    expect(isLikelyBinary(Buffer.from('We — they’ve gone.', 'utf8'))).toBe(false);
  });

  it("accepts empty content — emptiness is the near-empty guard's concern", () => {
    expect(isLikelyBinary(Buffer.from([]))).toBe(false);
  });
});
