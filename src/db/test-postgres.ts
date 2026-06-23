// Per-test-run schema isolation for the Postgres integration tests.
//
// Tests run against a real Postgres + pgvector (the dev DATABASE_URL or a
// disposable instance) by creating a uniquely-named schema, applying the
// drizzle-generated migration into it, and pointing a connection pool at it
// via `search_path`. Tearing down drops the schema CASCADE — the rest of the
// database is untouched.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const MIGRATION_PATH = join(process.cwd(), 'drizzle', '0000_sweet_master_mold.sql');

export function isolatedSchemaName(): string {
  return `test_canon_${randomBytes(6).toString('hex')}`;
}

function rewriteMigrationForSchema(sql: string, schema: string): string {
  // CREATE EXTENSION is per-database, not per-schema. Assume the extension is
  // already installed in the target database (it is in the dev Supabase
  // instance) and drop the statement from the per-schema migration.
  return sql
    .replace(/CREATE EXTENSION[^;]+;/g, '')
    .replace(/CREATE TABLE "(\w+)"/g, `CREATE TABLE "${schema}"."$1"`)
    .replace(/REFERENCES "public"\."([^"]+)"/g, `REFERENCES "${schema}"."$1"`)
    .replace(/ALTER TABLE "(\w+)"/g, `ALTER TABLE "${schema}"."$1"`);
}

export async function createIsolatedSchema(
  connectionString: string,
  schema: string,
): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    const migration = rewriteMigrationForSchema(
      readFileSync(MIGRATION_PATH, 'utf8'),
      schema,
    );
    for (const stmt of migration.split('--> statement-breakpoint')) {
      const s = stmt.trim();
      if (s) await client.query(s);
    }
  } finally {
    await client.end();
  }
}

export async function dropIsolatedSchema(
  connectionString: string,
  schema: string,
): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await client.end();
  }
}

export function poolForSchema(connectionString: string, schema: string): pg.Pool {
  // `extensions` is on the search_path because Supabase installs pgvector
  // there (not in `public`), and the `::vector` cast used by searchByEmbedding
  // needs to resolve the type without schema-qualifying every call site.
  return new pg.Pool({
    connectionString,
    options: `-c search_path=${schema},public,extensions`,
  });
}
