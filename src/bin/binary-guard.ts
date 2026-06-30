// Cheap binary-content guard for the directory walker (issue #18, PRD #11).
//
// The tparents.org corpus mirror contains files with a `.html` extension that
// are actually binary (scanned page images saved with the wrong suffix). Reading
// those bytes as utf-8 preserves NUL bytes (0x00 is valid UTF-8 but Postgres
// rejects it in a TEXT column), so handing them to `ingestText` crashes the
// `source` insert and fails the run. This guard runs BEFORE decoding so such
// files are skipped cleanly with reason `binary` alongside the other planner
// skip reasons.
//
// Conservative on purpose: NUL byte anywhere in the head OR a strict UTF-8
// decode failure on the head means binary. The check samples the first 8 KiB
// so cost is O(1) per file regardless of size — any binary worth catching has
// a non-text marker well inside that window, and well-formed prose is valid
// UTF-8 right from the start.

const SAMPLE_BYTES = 8192;

export function isLikelyBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  const sampleEnd = Math.min(buffer.length, SAMPLE_BYTES);
  for (let i = 0; i < sampleEnd; i++) {
    if (buffer[i] === 0) return true;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, sampleEnd));
    return false;
  } catch {
    return true;
  }
}
