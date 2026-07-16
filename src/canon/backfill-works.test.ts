// Founding Figures + Works seed (issue #54 origins; retained post-#61 after
// per-Source assignment moved to `backfillEditions`). Covers idempotence: a
// re-run doesn't multiply Figures/Works, and the seeded shape stays intact.

import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from './in-memory-repository';
import { backfillWorks } from './backfill-works';
import { BACKFILL_FIGURES, BACKFILL_WORKS } from './source-to-work';

describe('backfillWorks', () => {
  it('upserts the founding 4 Figures and 10 Works', async () => {
    const repo = new InMemoryRepository();
    const result = await backfillWorks(repo);

    expect(result.figuresUpserted).toBe(BACKFILL_FIGURES.length);
    expect(result.worksUpserted).toBe(BACKFILL_WORKS.length);

    const listings = await repo.listWorks();
    expect(listings).toHaveLength(BACKFILL_WORKS.length);
    for (const w of BACKFILL_WORKS) {
      const l = listings.find((x) => x.work.id === w.id)!;
      expect(l.work.title).toBe(w.title);
      expect(l.work.tier).toBe(w.tier);
      expect(BACKFILL_FIGURES.some((f) => f.id === l.figure.id)).toBe(true);
    }
  });

  it('is idempotent — a second run produces no duplicate Figures/Works', async () => {
    const repo = new InMemoryRepository();
    await backfillWorks(repo);
    const before = (await repo.listWorks()).length;
    await backfillWorks(repo);
    const after = (await repo.listWorks()).length;
    expect(after).toBe(before);
  });
});
