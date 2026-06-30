// Encoding-aware text decoder for the corpus walker (issue #20, PRD #11).
//
// The 1990s/2000s tparents.org corpus is Windows-1252 / Latin-1, not UTF-8.
// A naive `buffer.toString('utf8')` silently swaps in the U+FFFD replacement
// for every legacy byte (0x85 = curly ellipsis, 0x92 = curly apostrophe, 0xA0
// = nbsp, etc.), corrupting chapters the moment they reach the text pipeline.
// Stricter UTF-8 decode throws, which is what the old "fails-UTF-8 ⇒ binary"
// rule keyed off — silently dropping real scripture (Genesis-01/05/10/11; see
// issue #20). This decoder is the targeted replacement:
//
//   1. Try strict UTF-8. Real UTF-8 documents (modern mirror entries, our
//      synthesized test inputs) round-trip with no work.
//   2. On strict-UTF-8 failure, decode as Windows-1252 by hand. We can't rely
//      on `new TextDecoder('windows-1252')`: on some Node/ICU builds that
//      label degrades to Latin-1 for the C1 range (0x85 -> U+0085 control char
//      instead of U+2026 ellipsis), which is exactly where the curly
//      punctuation we need to rescue lives. Instead decode as Latin-1 (exact
//      byte -> U+00XX) and remap only the 0x80-0x9F slots via the WHATWG
//      index-windows-1252 table. 0x00-0x7F and 0xA0-0xFF already match between
//      Latin-1 and Windows-1252, so no other byte needs touching.
//   3. Strip any residual NUL. The binary guard already rejects files with
//      NUL in the first 8 KiB, so this is a defensive backstop for NULs that
//      happen deeper in the file: a Postgres `text` column rejects them and
//      the post-decode strip ensures the insert can never fail on that.

const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });

// WHATWG index-windows-1252, bytes 0x80-0x9F -> Unicode code points. The five
// "undefined" slots (0x81, 0x8D, 0x8F, 0x90, 0x9D) map to their own C1 code
// points. https://encoding.spec.whatwg.org/index-windows-1252.txt
// prettier-ignore
const WIN1252_C1 = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, // 80-87
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f, // 88-8F
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, // 90-97
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178, // 98-9F
];

function decodeWindows1252(buffer: Buffer): string {
  // Latin-1 gives an exact byte -> U+00XX mapping; remap only the C1 range.
  let out = '';
  for (const byte of buffer) {
    out +=
      byte >= 0x80 && byte <= 0x9f
        ? String.fromCharCode(WIN1252_C1[byte - 0x80] ?? byte)
        : String.fromCharCode(byte);
  }
  return out;
}

export function decodeLegacyText(buffer: Buffer): string {
  let decoded: string;
  try {
    decoded = UTF8_FATAL.decode(buffer);
  } catch {
    decoded = decodeWindows1252(buffer);
  }
  return decoded.includes('\0') ? decoded.replace(/\0/g, '') : decoded;
}
