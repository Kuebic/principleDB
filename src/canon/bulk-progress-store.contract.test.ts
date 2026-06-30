// `BulkProgressStore` contract test driven against `InMemoryBulkProgressStore`.
// The Postgres impl runs the same contract through its own integration test
// (gated on `DATABASE_URL`), so both implementations satisfy one definition of
// "what `has`/`mark` mean".

import { describe } from 'vitest';
import { InMemoryBulkProgressStore } from './bulk-ingest';
import { runBulkProgressStoreContract } from './bulk-progress-store.contract';

describe('InMemoryBulkProgressStore (contract)', () => {
  runBulkProgressStoreContract({
    create: () => new InMemoryBulkProgressStore(),
  });
});
