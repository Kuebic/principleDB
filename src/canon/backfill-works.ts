// One-time setup (issue #54, ADR-0017): upserts the founding Figures + Works.
// The Source-to-Work assignment step this backfill originally ran was retired
// in issue #61 when `Source.workId` was dropped in favour of Source → Edition →
// Work; the Editions backfill (`backfillEditions`) now owns per-Source
// assignment. This function stays as the Figure+Work seed — the Editions
// backfill FK-depends on it, so operators still run `npm run backfill:works`
// before `npm run backfill:editions` on a fresh DB.
//
// Idempotence: Figures + Works are `upsertFigure` / `upsertWork` — same
// primary key replaces, so a second run doesn't multiply the row set.

import type { CanonRepository } from './ports';
import { BACKFILL_FIGURES, BACKFILL_WORKS } from './source-to-work';

export interface BackfillResult {
  figuresUpserted: number;
  worksUpserted: number;
}

export async function backfillWorks(repo: CanonRepository): Promise<BackfillResult> {
  for (const figure of BACKFILL_FIGURES) {
    await repo.upsertFigure(figure);
  }
  for (const work of BACKFILL_WORKS) {
    await repo.upsertWork(work);
  }
  return {
    figuresUpserted: BACKFILL_FIGURES.length,
    worksUpserted: BACKFILL_WORKS.length,
  };
}
