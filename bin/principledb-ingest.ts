#!/usr/bin/env node
// `npm run ingest:text -- <file.txt> [--title T] [--author A] [--kind K] [--date D]`
// Seed the Canon from a plain text file: distil → relocate → embed → dedup →
// persist, the same pipeline the MCP server and bulk import use. This is the
// fastest way to put real Principles in a fresh Canon so search/relatedness
// have something to return.
//
// All design surface lives in `src/bin/ingest-text.ts` (parse + build Source +
// summary) and `src/bin/build-deps.ts` (env → real Postgres + Anthropic deps);
// this file is just the impure shell that reads the file and prints the result.

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

import { buildPrincipleDbDepsFromEnv } from '../src/bin/build-deps';
import {
  formatIngestSummary,
  ingestText,
  parseIngestArgs,
} from '../src/bin/ingest-text';

async function main(): Promise<void> {
  const args = parseIngestArgs(process.argv.slice(2));

  const text = readFileSync(args.file, 'utf8');
  if (text.trim().length === 0) {
    throw new Error(`${args.file} is empty — nothing to ingest.`);
  }

  // Default the title to the filename (sans extension) when not given.
  const title = args.title ?? basename(args.file, extname(args.file));

  const { deps, close } = buildPrincipleDbDepsFromEnv();
  try {
    const { source, result } = await ingestText(
      {
        title,
        text,
        ...(args.author !== undefined ? { author: args.author } : {}),
        ...(args.kind !== undefined ? { kind: args.kind } : {}),
        ...(args.date !== undefined ? { date: args.date } : {}),
      },
      deps,
    );
    console.log(formatIngestSummary(source, result));
  } finally {
    await close().catch(() => {});
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
