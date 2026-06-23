#!/usr/bin/env node
// `npm run doctor` — self-host preflight. Reads the env, optionally connects
// to Postgres, and prints a green/red checklist. Exits 1 on any failing
// check so a CI step can gate on it.

import pg from 'pg';
import {
  formatReport,
  runDoctor,
  REQUIRED_TABLES,
  type DbProbeError,
  type DbProbeResult,
} from '../src/bin/doctor';

async function probe(databaseUrl: string): Promise<DbProbeResult | DbProbeError> {
  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  try {
    const ext = await client.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname = 'vector'`,
    );
    const tablesRes = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = ANY($1::text[])`,
      [REQUIRED_TABLES],
    );
    return {
      hasPgVector: ext.rows.length > 0,
      tables: tablesRes.rows.map((r) => r.table_name),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    await client.end().catch(() => {});
  }
}

async function main(): Promise<void> {
  const report = await runDoctor(process.env, probe);
  process.stdout.write(formatReport(report) + '\n');
  if (!report.ok) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
