// Path-based Source id for the directory walker (Phase 0 / Slice 4, issue #15).
//
// The single-file text/HTML path derives a Source id from `(title, text)` —
// great for byte-identical re-ingest idempotency. The walker needs something
// different: a Source id we can compute from a path **without reading or
// extracting the file**, so a durable progress store can answer "already done?"
// by id alone over a 100k+ file corpus. Reading would re-touch every file on
// every resume, which is precisely what we're trying to avoid.
//
// The function is pure: same repo-relative path -> same id, different path ->
// different id. The walker is responsible for passing a normalized,
// repo-relative path (forward slashes, no leading `./`) so two equivalent
// invocations agree.

import { fnv1a32 } from '../canon/hash';

const PATH_ID_PREFIX = 'src-path-';

// Hash the path twice with distinct salts so the two 32-bit halves do not
// share a hash state — gives ~64 bits of effective entropy, comfortable for
// 100k+ file corpora where a plain 32-bit hash would expect a couple of
// collisions (birthday paradox over `2^32`).
export function deriveHtmlSourcePathId(repoRelativePath: string): string {
  const a = fnv1a32(`p:${repoRelativePath}`).toString(16).padStart(8, '0');
  const b = fnv1a32(`q:${repoRelativePath}`).toString(16).padStart(8, '0');
  return `${PATH_ID_PREFIX}${a}${b}`;
}
