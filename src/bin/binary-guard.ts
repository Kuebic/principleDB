// Binary-content guard for the directory walker (issue #18 + issue #20, PRD #11).
//
// The tparents.org corpus mirror dual-saves figures under both an image
// extension and a `.html` duplicate (`Image404.gif` next to `Image404.html`
// holding the same JPEG bytes). Reading those bytes as `text` would crash the
// Postgres `source.text` insert on a NUL byte, so the walker must detect them
// BEFORE handing them to `ingestText`.
//
// History — issue #18 (now removed): an earlier version of this guard rejected
// any file whose first 8 KiB failed a strict UTF-8 decode. That was correct for
// images but wrong for the 1990s/2000s Windows-1252 / Latin-1 corpus text — a
// single `0x85` (curly ellipsis) inside the 8 KiB sample would flag a complete
// scripture chapter as `binary` and silently drop it. The fate of a file then
// depended on *where* its first high byte fell relative to the sample window
// (see issue #20 evidence: Genesis-01/05/10/11 dropped; Genesis-08 slipped
// through then mojibaked).
//
// Current contract: detect *real* binary by magic bytes, not by encoding. The
// four image/PDF signatures cover every false drop the previous heuristic
// caused; the NUL backstop catches stragglers (other binary types, partial
// downloads). Decoding then happens in `decode-legacy-text.ts` — strict UTF-8
// first, Windows-1252 fallback — so legacy chapters transcode to clean UTF-8
// and ingest instead of being dropped.

const SAMPLE_BYTES = 8192;

// Leading bytes of formats that turn up in the corpus mirror with a `.html`
// extension. The walker is HTML-only, so any file starting with one of these
// is misnamed binary content (not text we should transcode).
const MAGIC_SIGNATURES: ReadonlyArray<Buffer> = [
  Buffer.from([0xff, 0xd8, 0xff]), // JPEG / JFIF
  Buffer.from([0x47, 0x49, 0x46, 0x38]), // GIF87a / GIF89a
  Buffer.from([0x89, 0x50, 0x4e, 0x47]), // PNG
  Buffer.from([0x25, 0x50, 0x44, 0x46]), // %PDF
];

export function isLikelyBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  for (const sig of MAGIC_SIGNATURES) {
    if (startsWith(buffer, sig)) return true;
  }
  // NUL backstop: catches binaries we don't have a magic for (other image
  // formats, partial downloads). The decoder strips residual NULs from
  // legitimate text downstream, so a NUL early in the file is a strong
  // binary signal — no legacy-text false positive risk here.
  const sample = buffer.subarray(0, SAMPLE_BYTES);
  return sample.indexOf(0) !== -1;
}

function startsWith(buffer: Buffer, prefix: Buffer): boolean {
  if (buffer.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (buffer[i] !== prefix[i]) return false;
  }
  return true;
}
