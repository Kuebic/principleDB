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
//   2. On strict-UTF-8 failure, decode as Windows-1252. Node's TextDecoder
//      ships with `windows-1252` built in — no dependency — and it's a
//      superset of Latin-1 covering the 0x80–0x9F range that Latin-1 leaves
//      undefined (which is exactly where the curly punctuation lives).
//   3. Strip any residual NUL. The binary guard already rejects files with
//      NUL in the first 8 KiB, so this is a defensive backstop for NULs that
//      happen deeper in the file: a Postgres `text` column rejects them and
//      the post-decode strip ensures the insert can never fail on that.

const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });
const WIN1252 = new TextDecoder('windows-1252');

export function decodeLegacyText(buffer: Buffer): string {
  let decoded: string;
  try {
    decoded = UTF8_FATAL.decode(buffer);
  } catch {
    decoded = WIN1252.decode(buffer);
  }
  return decoded.includes('\0') ? decoded.replace(/\0/g, '') : decoded;
}
