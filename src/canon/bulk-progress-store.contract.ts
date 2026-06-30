// Shared contract test for the `BulkProgressStore` port. Every implementation
// (in-memory, Postgres, anything we add later) drives this same suite so they
// agree on `has`/`mark` semantics — the resumability guarantee `bulkIngest`
// leans on (ADR-0008 idempotency makes re-runs safe even when a mark is lost,
// but a store that silently lost marks would still waste tokens on re-distil).
//
// The pattern matches `marker.contract.test.ts` / similar shared suites: the
// caller passes a factory that returns a fresh store plus an optional teardown,
// the suite is run inside the caller's `describe()`.

import { expect, it } from 'vitest';
import type { BulkProgressStore } from './bulk-ingest';

export interface BulkProgressStoreFactory {
  create: () => Promise<BulkProgressStore> | BulkProgressStore;
  // Optional reset between tests — Postgres impl truncates between tests so
  // assertions can use stable IDs without leaking state across the suite.
  reset?: () => Promise<void>;
}

export function runBulkProgressStoreContract(factory: BulkProgressStoreFactory): void {
  it('returns false for a Source that was never marked', async () => {
    await factory.reset?.();
    const store = await factory.create();
    expect(await store.has('never-seen')).toBe(false);
  });

  it('returns true after marking a Source as done', async () => {
    await factory.reset?.();
    const store = await factory.create();
    await store.mark('s1');
    expect(await store.has('s1')).toBe(true);
  });

  it('marking is independent across Source ids', async () => {
    await factory.reset?.();
    const store = await factory.create();
    await store.mark('s1');
    await store.mark('s3');
    expect(await store.has('s1')).toBe(true);
    expect(await store.has('s2')).toBe(false);
    expect(await store.has('s3')).toBe(true);
  });

  it('marking the same Source id twice is a no-op', async () => {
    // Re-marking happens on resume when a previous run completed an ingest but
    // crashed before recording it durably. The store must accept the duplicate
    // without erroring — otherwise `bulkIngest` would surface a spurious error.
    await factory.reset?.();
    const store = await factory.create();
    await store.mark('s1');
    await store.mark('s1');
    expect(await store.has('s1')).toBe(true);
  });
}
