// One-time backfill (issue #54, ADR-0017): stamps every existing Source
// with its Work — no re-ingest, no re-distillation. A thin, idempotent shell
// over the pure `sourceToWork` mapping.
//
// Idempotence properties this function guarantees:
//   - Figures + Works are `upsertFigure` / `upsertWork` — same primary key
//     replaces, so a second run doesn't multiply the row set.
//   - Every Source is (re-)assigned to the Work `sourceToWork` computes;
//     already-correct assignments are counted `sourcesUnchanged` and skip
//     the UPDATE round-trip so a second run is nearly free and a mistaken
//     assignment from a prior partial run is corrected on the next pass.
//
// Called from `scripts/backfill-works.ts` under `npm run backfill:works`;
// exposed as a function so the in-memory tests exercise the same code path
// the production script does.

import type { CanonRepository } from './ports';
import {
  BACKFILL_FIGURES,
  BACKFILL_WORKS,
  sourceToWork,
} from './source-to-work';

export interface BackfillResult {
  figuresUpserted: number;
  worksUpserted: number;
  sourcesAssigned: number;
  sourcesUnchanged: number;
}

export async function backfillWorks(repo: CanonRepository): Promise<BackfillResult> {
  for (const figure of BACKFILL_FIGURES) {
    await repo.upsertFigure(figure);
  }
  for (const work of BACKFILL_WORKS) {
    await repo.upsertWork(work);
  }

  const refs = await repo.listSourceRefsForBackfill();
  let sourcesAssigned = 0;
  let sourcesUnchanged = 0;
  for (const ref of refs) {
    const workId = sourceToWork(ref);
    if (ref.workId === workId) {
      sourcesUnchanged++;
      continue;
    }
    await repo.assignSourceToWork(ref.id, workId);
    sourcesAssigned++;
  }

  return {
    figuresUpserted: BACKFILL_FIGURES.length,
    worksUpserted: BACKFILL_WORKS.length,
    sourcesAssigned,
    sourcesUnchanged,
  };
}
