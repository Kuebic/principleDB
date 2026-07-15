// One-off ingest of Damien Dunkley's "Discourse on True Mother's Revelations"
// (10 parts) + "The Meaning of Special Grace" into the Canon.
//
// These are Vimeo video-transcript markdown files: YAML frontmatter, a
// `## Transcript` header, then `[MM:SS] text` lines. Per the grilling decision:
//   - author = "Damien Dunkley" (the flat model would mis-derive it as the
//     channel "Family Fed USA"); kind = transcript.
//   - Clean prose feeds distil (timecodes stripped from the body) so Quotes read
//     cleanly, while a `transcript-timecodes` structureMap (ADR-0009) preserves
//     jump-to-video labels.
//   - Source ids are PINNED (src-dunkley-<stem>) so a re-run REPLACES the slot
//     (ADR-0008) instead of orphaning it — the raw text CLI derives id from the
//     text, so any later cleaning change would otherwise create a duplicate.
//
// Figure/Work grouping is deferred to its own ADR; the shared title stem
// ("Discourse on True Mother's Revelations — Part NN") makes the later
// retro-group a mechanical group-by.
//
// Run:
//   npm run ingest:dunkley -- --dry-run     # preprocess + report, no DB/API
//   npm run ingest:dunkley                   # real ingest (needs env)

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { StructureMap } from '../src/canon/types';

const DIR =
  '/home/kenmen/code/src/github/kuebic/zettle/resources/Video/vimeo/Family Fed USA';

export interface ParsedTranscript {
  frontmatter: Record<string, string>;
  cleanText: string;
  codes: Array<{ offset: number; timecode: string }>;
}

// Strip the YAML frontmatter + `##` headers, drop the `[MM:SS]` tokens from the
// body, and record each segment's timecode against its offset in the CLEAN text.
export function parseTranscript(raw: string): ParsedTranscript {
  const frontmatter: Record<string, string> = {};
  let body = raw;
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    for (const line of fm[1]!.split('\n')) {
      const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
      if (m) frontmatter[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
    }
    body = raw.slice(fm[0].length);
  }

  const codes: Array<{ offset: number; timecode: string }> = [];
  let clean = '';
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)$/);
    if (clean.length > 0) clean += ' ';
    if (m) {
      codes.push({ offset: clean.length, timecode: m[1]! });
      clean += m[2]!;
    } else {
      clean += t;
    }
  }
  return { frontmatter, cleanText: clean.trim(), codes };
}

interface Job {
  file: string;
  id: string;
  title: string;
  date: string;
}

// Deterministic ordering: part number from the filename, special-grace last.
function planJobs(): Job[] {
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith('.md'))
    .sort();
  return files.map((file) => {
    const stem = file.replace(/\.md$/, '');
    const part = stem.match(/-(\d{2})-discourse/);
    const title = part
      ? `Discourse on True Mother's Revelations — Part ${part[1]}`
      : 'The Meaning of Special Grace';
    const date = stem.slice(0, 10); // leading YYYY-MM-DD
    return { file, id: `src-dunkley-${stem}`, title, date };
  });
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const jobs = planJobs();

  if (dryRun) {
    for (const job of jobs) {
      const parsed = parseTranscript(readFileSync(join(DIR, job.file), 'utf8'));
      const first = parsed.codes[0];
      console.log(
        [
          `• ${job.id}`,
          `    title : ${job.title}`,
          `    date  : ${job.date}   chars: ${parsed.cleanText.length}   timecodes: ${parsed.codes.length}`,
          `    first : [${first?.timecode ?? '—'}] @${first?.offset ?? '—'}`,
          `    head  : ${parsed.cleanText.slice(0, 140).replace(/\s+/g, ' ')}…`,
        ].join('\n'),
      );
    }
    console.log(`\n${jobs.length} sources planned. No DB/API touched (--dry-run).`);
    return;
  }

  // Real run — import deps lazily so --dry-run needs no env.
  const { buildPrincipleDbDepsFromEnv } = await import('../src/bin/build-deps');
  const { ingestText, formatIngestSummary } = await import('../src/bin/ingest-text');

  const { deps, close } = buildPrincipleDbDepsFromEnv();
  try {
    for (const job of jobs) {
      const parsed = parseTranscript(readFileSync(join(DIR, job.file), 'utf8'));
      const structureMap: StructureMap = { kind: 'transcript-timecodes', codes: parsed.codes };
      const { source, result } = await ingestText(
        {
          id: job.id,
          title: job.title,
          text: parsed.cleanText,
          author: 'Damien Dunkley',
          kind: 'transcript',
          date: job.date,
          structureMap,
        },
        deps,
      );
      console.log(formatIngestSummary(source, result));
    }
  } finally {
    await close().catch(() => {});
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
