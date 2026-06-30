// `SeenTextStore` contract test driven against `InMemorySeenTextStore`.
// The Postgres impl runs the same contract through its own integration test
// (gated on `DATABASE_URL`), so both implementations satisfy one definition
// of "what `seen`/`record` mean".

import { describe } from 'vitest';
import { InMemorySeenTextStore } from './seen-text-store';
import { runSeenTextStoreContract } from './seen-text-store.contract';

describe('InMemorySeenTextStore (contract)', () => {
  runSeenTextStoreContract({
    create: () => new InMemorySeenTextStore(),
  });
});
