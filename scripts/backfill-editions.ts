// One-time backfill (issue #60, PRD #58, ADR-0018): assign every existing
// Source in the live Canon to its Edition. Idempotent — safe to re-run.
//
// This is a shell over `backfillEditions` (src/canon/backfill-editions.ts) —
// the logic + idempotence properties are tested in-memory; this script only
// wires the Postgres repository and reports.
//
// Run:
//   npm run backfill:editions -- --dry-run    # report the mapping, no writes
//   npm run backfill:editions                 # perform the backfill

import { backfillEditions } from '../src/canon/backfill-editions';
import { BACKFILL_EDITIONS, sourceToEdition } from '../src/canon/source-to-edition';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const { buildPrincipleDbDepsFromEnv } = await import('../src/bin/build-deps');
  const { deps, close } = buildPrincipleDbDepsFromEnv();

  try {
    if (dryRun) {
      // Report what WOULD happen — read refs, compute assignments, print
      // per-Edition counts. No writes to Editions/Source.
      const refs = await deps.repository.listSourceRefsForBackfill();
      const counts = new Map<string, number>();
      let alreadyAssigned = 0;
      for (const ref of refs) {
        const eid = sourceToEdition(ref);
        counts.set(eid, (counts.get(eid) ?? 0) + 1);
        if (ref.editionId === eid) alreadyAssigned++;
      }
      console.log(`${refs.length} Sources scanned. Edition mapping breakdown:`);
      for (const e of BACKFILL_EDITIONS) {
        const line = `  ${(counts.get(e.id) ?? 0).toString().padStart(4)}  ${e.id.padEnd(22)}  ${e.label} (${e.recension})`;
        console.log(line);
      }
      console.log(`\n  ${alreadyAssigned.toString().padStart(4)}  already assigned`);
      console.log('\n(--dry-run: no Editions upserted, no Source rows updated.)');
      return;
    }

    const result = await backfillEditions(deps.repository);
    console.log('Editions backfill complete.');
    console.log(`  Editions upserted:  ${result.editionsUpserted}`);
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
