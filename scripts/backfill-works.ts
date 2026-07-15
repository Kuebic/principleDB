// Founding Figures + Works seed (issue #54 origins, retained after #61).
// Idempotent — safe to re-run.
//
// This is a shell over `backfillWorks` (src/canon/backfill-works.ts). Source
// assignment moved to `backfill:editions` when `Source.workId` was dropped
// (#61); this script now just seeds the Figure + Work rows the Editions
// backfill FK-depends on.
//
// Run:
//   npm run backfill:works -- --dry-run    # report what would be seeded
//   npm run backfill:works                 # perform the upsert

import { backfillWorks } from '../src/canon/backfill-works';
import { BACKFILL_FIGURES, BACKFILL_WORKS } from '../src/canon/source-to-work';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const { buildPrincipleDbDepsFromEnv } = await import('../src/bin/build-deps');
  const { deps, close } = buildPrincipleDbDepsFromEnv();

  try {
    if (dryRun) {
      console.log(`Would upsert ${BACKFILL_FIGURES.length} Figures and ${BACKFILL_WORKS.length} Works:`);
      for (const w of BACKFILL_WORKS) {
        console.log(`  ${w.id.padEnd(10)}  ${w.title}`);
      }
      console.log('\n(--dry-run: no Figures/Works upserted.)');
      return;
    }

    const result = await backfillWorks(deps.repository);
    console.log('Founding Figures/Works seed complete.');
    console.log(`  Figures upserted:   ${result.figuresUpserted}`);
    console.log(`  Works   upserted:   ${result.worksUpserted}`);
  } finally {
    await close().catch(() => {});
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
