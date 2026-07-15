// One-time backfill (issue #54, ADR-0017): assign every existing Source in
// the live Canon to its Work + Figure. Idempotent — safe to re-run.
//
// This is a shell over `backfillWorks` (src/canon/backfill-works.ts) — the
// logic + idempotence properties are tested in-memory; this script only
// wires the Postgres repository and reports.
//
// Run:
//   npm run backfill:works -- --dry-run    # report the mapping, no writes
//   npm run backfill:works                 # perform the backfill

import { backfillWorks } from '../src/canon/backfill-works';
import { sourceToWork, BACKFILL_WORKS } from '../src/canon/source-to-work';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const { buildPrincipleDbDepsFromEnv } = await import('../src/bin/build-deps');
  const { deps, close } = buildPrincipleDbDepsFromEnv();

  try {
    if (dryRun) {
      // Report what WOULD happen — read refs, compute assignments, print
      // per-Work counts. No writes to Figures/Works/Source.
      const refs = await deps.repository.listSourceRefsForBackfill();
      const counts = new Map<string, number>();
      for (const ref of refs) {
        const wid = sourceToWork(ref);
        counts.set(wid, (counts.get(wid) ?? 0) + 1);
      }
      console.log(`${refs.length} Sources scanned. Mapping breakdown:`);
      for (const w of BACKFILL_WORKS) {
        console.log(`  ${(counts.get(w.id) ?? 0).toString().padStart(4)}  ${w.id.padEnd(10)}  ${w.title}`);
      }
      console.log('\n(--dry-run: no Figures/Works upserted, no Source rows updated.)');
      return;
    }

    const result = await backfillWorks(deps.repository);
    console.log('Backfill complete.');
    console.log(`  Figures upserted:   ${result.figuresUpserted}`);
    console.log(`  Works   upserted:   ${result.worksUpserted}`);
    console.log(`  Sources assigned:   ${result.sourcesAssigned}`);
    console.log(`  Sources unchanged:  ${result.sourcesUnchanged}`);
  } finally {
    await close().catch(() => {});
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
