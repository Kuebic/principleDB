// Shared contract test for the `SeenTextStore` port. Every implementation
// (in-memory, Postgres, anything we add later) drives this same suite so they
// agree on `seen`/`record` semantics — the cost-optimization guarantee the
// directory walker leans on.
//
// Mirrors `bulk-progress-store.contract.ts`: the caller passes a factory that
// returns a fresh store plus an optional teardown, the suite is run inside the
// caller's `describe()`.

import { expect, it } from 'vitest';
import type { SeenTextStore } from './seen-text-store';

export interface SeenTextStoreFactory {
  create: () => Promise<SeenTextStore> | SeenTextStore;
  // Optional reset between tests — Postgres impl truncates between tests so
  // assertions can use stable hashes without leaking state across the suite.
  reset?: () => Promise<void>;
}

export function runSeenTextStoreContract(factory: SeenTextStoreFactory): void {
  it('returns false for a hash that was never recorded', async () => {
    await factory.reset?.();
    const store = await factory.create();
    expect(await store.seen('hash-never-recorded')).toBe(false);
  });

  it('returns true after recording a hash', async () => {
    await factory.reset?.();
    const store = await factory.create();
    await store.record('hash-a');
    expect(await store.seen('hash-a')).toBe(true);
  });

  it('recording is independent across hashes', async () => {
    await factory.reset?.();
    const store = await factory.create();
    await store.record('hash-a');
    await store.record('hash-c');
    expect(await store.seen('hash-a')).toBe(true);
    expect(await store.seen('hash-b')).toBe(false);
    expect(await store.seen('hash-c')).toBe(true);
  });

  it('recording the same hash twice is a no-op', async () => {
    // Re-recording happens on resume / repeated whitespace-variants. The
    // store must accept the duplicate without erroring — otherwise the
    // walker would surface a spurious error on a perfectly normal re-run.
    await factory.reset?.();
    const store = await factory.create();
    await store.record('hash-a');
    await store.record('hash-a');
    expect(await store.seen('hash-a')).toBe(true);
  });
}
