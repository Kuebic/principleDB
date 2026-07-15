// One-off recovery (incident 2026-07-15): apply the Editions schema migration
// UP TO AND INCLUDING 0008 only, so the W60 backfill can run before 0009's
// `edition_id SET NOT NULL`.
//
// Why this exists: drizzle's node-postgres migrator runs *all* pending
// migrations inside a single transaction (see
// node_modules/drizzle-orm/pg-core/dialect.cjs `migrate`). With both 0008 and
// 0009 pending, 0009's `ALTER COLUMN edition_id SET NOT NULL` fails (no Source
// has an edition_id yet) and the whole transaction — including 0008 — rolls
// back. So `npm run db:migrate` can never make progress: the DB is stuck at
// 0007 and every Source/Edition read 500s in production.
//
// Correct order is 0008 -> backfill -> 0009. This script does the 0008 half
// using drizzle's own migration bookkeeping (records 0008 in
// `drizzle.__drizzle_migrations`), so afterwards:
//
//   1. tsx scripts/recover-editions-migration.ts   # applies through 0008
//   2. npm run backfill:editions -- --dry-run       # sanity-check the mapping
//   3. npm run backfill:editions                    # populate source.edition_id
//   4. npm run db:migrate                           # 0009 now the only pending; SET NOT NULL passes, drops work_id
//
// Idempotent: re-running is a no-op once 0008 is recorded. Safe to delete once
// the migration is fixed everywhere.

import fs from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import pg from 'pg';

// Apply everything through this tag (inclusive); stop before the next one.
const STOP_AFTER_TAG = '0008_skinny_doctor_spectrum';
const MIGRATIONS_FOLDER = 'drizzle';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. See docs/SELF_HOSTING.md.');
    process.exit(1);
  }

  // Read the journal to find the cutoff `when` for STOP_AFTER_TAG. We filter by
  // folderMillis (which is journal `when`) because readMigrationFiles() drops
  // the tag from its output.
  const journal = JSON.parse(
    fs.readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`).toString(),
  ) as { entries: Array<{ tag: string; when: number }> };
  const stopEntry = journal.entries.find((e) => e.tag === STOP_AFTER_TAG);
  if (!stopEntry) {
    console.error(`Cutoff tag ${STOP_AFTER_TAG} not found in _journal.json.`);
    process.exit(1);
  }
  const cutoff = stopEntry.when;

  const all = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
  const throughCutoff = all.filter((m) => m.folderMillis <= cutoff);
  const skipped = all.length - throughCutoff.length;
  console.log(
    `Applying migrations with when <= ${cutoff} (${STOP_AFTER_TAG}): ` +
      `${throughCutoff.length} in scope, ${skipped} held back (0009+).`,
  );

  const pool = new pg.Pool({ connectionString: url });
  try {
    const db = drizzle(pool);
    // `dialect.migrate` is drizzle-internal (not on the public db type) — it's
    // exactly what the node-postgres `migrate()` wrapper calls, but here we
    // hand it a filtered migration list. It skips any migration already
    // recorded in __drizzle_migrations, so this only runs what's pending within
    // the cutoff — including nothing, on a re-run.
    const internal = db as unknown as {
      dialect: {
        migrate: (
          migrations: typeof throughCutoff,
          session: unknown,
          config: { migrationsFolder: string },
        ) => Promise<void>;
      };
      session: unknown;
    };
    await internal.dialect.migrate(throughCutoff, internal.session, {
      migrationsFolder: MIGRATIONS_FOLDER,
    });
    console.log('Applied through 0008. Now run: npm run backfill:editions, then npm run db:migrate.');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
