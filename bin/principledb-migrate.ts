#!/usr/bin/env node
// `npm run db:migrate` — applies every pending Drizzle migration in
// `drizzle/` against DATABASE_URL. Re-running is safe: drizzle's migrator
// records applied migrations in `__drizzle_migrations` and skips them.
//
// First run only: pgvector must already be installed on the target database.
// Supabase: Database → Extensions → enable `vector`. Self-hosted Postgres:
// `CREATE EXTENSION vector;` (requires superuser). The migrator runs
// `CREATE EXTENSION IF NOT EXISTS vector` as its first statement, but on
// managed Postgres without superuser the IF NOT EXISTS is a no-op when the
// extension is already enabled out-of-band.

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. See docs/SELF_HOSTING.md.');
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: url });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: 'drizzle' });
    console.log('migrations applied.');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
