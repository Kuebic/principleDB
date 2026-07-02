// Drives the shared `StagingStore` contract against `InMemoryStagingStore`.
// The Postgres impl runs the same suite from `postgres-staging-store.test.ts`
// so the two agree on stage/read/list/delete semantics.

import { describe } from 'vitest';
import { runStagingStoreContract } from './staging-store.contract';
import { InMemoryStagingStore } from './staging-store';

describe('InMemoryStagingStore', () => {
  describe('contract', () => {
    runStagingStoreContract({
      create: () => new InMemoryStagingStore(),
    });
  });
});
