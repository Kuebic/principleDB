// Normalized-text near-dupe guard (Phase 0 / Slice 5, issue #16, PRD #11).
//
// `SeenTextStore` is a tiny port — `seen(hash)` / `record(hash)` — checked by
// the directory walker BEFORE distil so whitespace-variant mirror captures
// (e.g. `BIF` and `bif` differing only in case) skip distil instead of paying
// for it. The hash is computed by reusing `normalize()` so visible text is
// canonicalized (whitespace runs collapsed, curly quotes flattened, ligatures
// expanded) before SHA-256 — so two captures of the same document with
// different markup chrome still collapse to the same hash.
//
// Kept off the existing `BulkProgressStore` port on purpose: the three dedup
// layers of PRD #11 stay distinct.
//   - ADR-0008 `(sourceId, provenance)` slot   — byte-identical re-ingest
//     idempotency (untouched).
//   - this normalized-hash pre-pass            — whitespace-variant cost
//     optimization (NEW).
//   - ADR-0012 `dedup.ts`                       — semantic principle overlap
//     at admission.
// The hash is a cache to skip a redundant LLM call, not a correctness layer:
// missing the optimization is harmless (the file ingests, idempotency + dedup
// take over). The walker therefore records the hash AFTER ingest succeeds, so
// a crash mid-distil leaves no orphan record that would later silently skip
// the same file without ever ingesting it.
//
// `record()` is treated as idempotent — re-recording a hash on resume is a
// no-op rather than an error.

import { createHash } from 'node:crypto';
import { normalize } from './normalize';

export interface SeenTextStore {
  seen(hash: string): Promise<boolean>;
  record(hash: string): Promise<void>;
}

export class InMemorySeenTextStore implements SeenTextStore {
  private readonly hashes = new Set<string>();

  async seen(hash: string): Promise<boolean> {
    return this.hashes.has(hash);
  }

  async record(hash: string): Promise<void> {
    this.hashes.add(hash);
  }

  size(): number {
    return this.hashes.size;
  }
}

// Compute the dedup hash for a piece of extracted text. Runs the existing
// `normalize()` over the input first so two whitespace-variant captures of the
// same document collapse to the same hash. SHA-256 (hex) is comfortable for a
// 100k+ file corpus where a 32-bit hash would collide by the birthday paradox.
export function normalizedTextHash(text: string): string {
  const { text: normalized } = normalize(text);
  return createHash('sha256').update(normalized).digest('hex');
}
