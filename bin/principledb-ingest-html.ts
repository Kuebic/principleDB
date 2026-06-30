#!/usr/bin/env node
// `npm run ingest:html -- <file.html> [--title T] [--author A] [--kind K] [--date D]`
// Seed the Canon from a single HTML file: strip chrome → extract clean body
// text → derive a Source title → run the existing distil/admit/embed/dedup/
// persist pipeline. The first end-to-end path for HTML; bulk-walk + richer
// path/markup metadata are later slices (#13–#17 under PRD #11).
//
// All design surface lives in `src/bin/ingest-html.ts` (parse + extract +
// build Source) and `src/bin/build-deps.ts` (env → real Postgres + Anthropic
// deps); this file is just the impure shell that reads the file and prints
// the result.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { buildPrincipleDbDepsFromEnv } from '../src/bin/build-deps';
import { formatIngestSummary } from '../src/bin/ingest-text';
import { ingestHtml, parseIngestHtmlArgs } from '../src/bin/ingest-html';

async function main(): Promise<void> {
  const args = parseIngestHtmlArgs(process.argv.slice(2));

  const html = readFileSync(args.file, 'utf8');
  if (html.trim().length === 0) {
    throw new Error(`${args.file} is empty — nothing to ingest.`);
  }

  const { deps, close } = buildPrincipleDbDepsFromEnv();
  try {
    const { source, result } = await ingestHtml(
      {
        html,
        filename: basename(args.file),
        ...(args.title !== undefined ? { title: args.title } : {}),
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
