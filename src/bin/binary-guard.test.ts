import { describe, expect, it } from 'vitest';

import { isLikelyBinary } from './binary-guard';

describe('isLikelyBinary', () => {
  it('rejects content with NUL bytes (a JPEG/PNG saved with a .html suffix)', () => {
    // JFIF magic — first 11 bytes of a JPEG. The 0x00 byte at index 4 alone
    // is enough to fail any TEXT-column insert in Postgres.
    const jfif = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
    ]);
    expect(isLikelyBinary(jfif)).toBe(true);
  });

  it('rejects content with invalid UTF-8 sequences', () => {
    // 0xC3 is a UTF-8 2-byte lead; 0xFF is never a valid continuation byte.
    // No NUL bytes here — the only signal is the broken decode.
    expect(isLikelyBinary(Buffer.from([0xc3, 0xff, 0xc3, 0xff]))).toBe(true);
  });

  it('accepts valid HTML markup', () => {
    const html = '<html><body><p>hello world</p></body></html>';
    expect(isLikelyBinary(Buffer.from(html, 'utf8'))).toBe(false);
  });

  it('accepts multi-byte UTF-8 prose (em-dash, curly apostrophe)', () => {
    // Real corpus text routinely contains these; they must not look "binary".
    expect(isLikelyBinary(Buffer.from('We — they’ve gone.', 'utf8'))).toBe(false);
  });

  it('accepts empty content — emptiness is the near-empty guard\'s concern, not this one\'s', () => {
    expect(isLikelyBinary(Buffer.from([]))).toBe(false);
  });

  it('catches a NUL byte buried later in the head sample (not just at offset 0)', () => {
    const buf = Buffer.alloc(2000, 0x20);
    buf[1500] = 0x00;
    expect(isLikelyBinary(buf)).toBe(true);
  });
});
