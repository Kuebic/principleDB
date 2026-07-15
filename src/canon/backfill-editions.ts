// One-time backfill (issue #60, PRD #58, ADR-0018): stamps every existing
// Source with its Edition — no re-ingest, no re-distillation. A thin,
// idempotent shell over the pure `sourceToEdition` mapping, mirroring the
// ADR-0017 works backfill (src/canon/backfill-works.ts).
//
// Idempotence properties this function guarantees:
//   - Editions are `upsertEdition` — same primary key replaces, so a second
//     run doesn't multiply rows.
//   - Every Source is (re-)assigned to the Edition `sourceToEdition` computes;
//     already-correct assignments are counted `sourcesUnchanged` and skip the
//     UPDATE round-trip, so a re-run is nearly free and a mistaken assignment
//     from a prior partial run is corrected on the next pass.
//
// Called from `scripts/backfill-editions.ts` under `npm run backfill:editions`;
// exposed as a function so the in-memory tests exercise the same code path
// the production script does.

import type { CanonRepository } from './ports';
import { BACKFILL_EDITIONS, sourceToEdition } from './source-to-edition';

export interface BackfillEditionsResult {
  editionsUpserted: number;
  sourcesAssigned: number;
  sourcesUnchanged: number;
}

export async function backfillEditions(repo: CanonRepository): Promise<BackfillEditionsResult> {
  for (const edition of BACKFILL_EDITIONS) {
    await repo.upsertEdition(edition);
  }

  const refs = await repo.listSourceRefsForBackfill();
  let sourcesAssigned = 0;
  let sourcesUnchanged = 0;
  for (const ref of refs) {
    const editionId = sourceToEdition(ref);
    if (ref.editionId === editionId) {
      sourcesUnchanged++;
      continue;
    }
    await repo.assignSourceToEdition(ref.id, editionId);
    sourcesAssigned++;
  }

  return {
    editionsUpserted: BACKFILL_EDITIONS.length,
    sourcesAssigned,
    sourcesUnchanged,
  };
}
