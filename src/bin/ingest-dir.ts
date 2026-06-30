// Directory walker / `ingest:dir` core (Phase 0 / Slice 3, issue #14, PRD #11).
//
// Walks a subtree, applies the corpus-aware `planJobs` filter (extension
// allowlist + filename denylist + near-empty guard), and runs the surviving
// HTML files through the existing single-file `ingestHtml` path via
// `bulkIngest` — so resumability, per-Source error capture, and idempotent
// `(sourceId, provenance)` slotting all come for free.
//
// Designed as a thin shell over pure pieces: argv parsing
// (`parseIngestDirArgs`), the plan (`planJobs` in `./plan-jobs`), and the
// dry-run renderer (`formatDryRunSummary`) are testable on their own; the
// impure surface here is the filesystem walk + the bulk run. The bin file
// `bin/principledb-ingest-dir.ts` is the four-line entrypoint that wires
// `buildPrincipleDbDepsFromEnv`.
//
// Distil model defaults to **Haiku** (`PRINCIPLEDB_DISTIL_MODEL` / `--model`
// override, flag wins) because the long tail of the corpus is cheap doctrine
// chrome where Opus's quality premium is not worth the rate-limit cost; Opus
// stays the default for the single-file paths used on the ~3k high-value
// canon (per PRD #11).
//
// Resumable durable progress (slice 4 / issue #15) lands in a later commit —
// for now the walker uses `InMemoryBulkProgressStore`, which still gives the
// per-batch idempotency we need for the slice's acceptance criteria.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  bulkIngest,
  InMemoryBulkProgressStore,
  type BulkIngestResult,
} from '../canon/bulk-ingest';
import type { CanonRepository, IngestProvider } from '../canon/ports';
import type { SourceKind } from '../canon/types';
import { htmlToText } from './html-to-text';
import { ingestHtml } from './ingest-html';
import {
  planJobs,
  type JobPlan,
  type SkippedFile,
} from './plan-jobs';

export type DistilModelChoice = 'haiku' | 'opus';

export interface IngestDirArgs {
  path: string;
  kind?: SourceKind;
  limit?: number;
  dryRun?: boolean;
  model?: DistilModelChoice;
}

const SOURCE_KINDS: readonly SourceKind[] = ['sermon', 'book', 'article', 'transcript'];
const DISTIL_MODELS: readonly DistilModelChoice[] = ['haiku', 'opus'];

const INGEST_DIR_USAGE =
  'usage: principledb-ingest-dir <path> [--kind K] [--limit N] [--dry-run] [--model haiku|opus]';

// Same flag style as the single-file CLI parsers (issue #12/#13): `--flag
// value`, `--dry-run` is a bare boolean toggle. Throws a readable Error on a
// missing path or an invalid choice; the bin file maps that to a stderr
// message + exit 1.
export function parseIngestDirArgs(argv: string[]): IngestDirArgs {
  const flags: Record<string, string> = {};
  const booleans = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--dry-run') {
      booleans.add('dry-run');
      continue;
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[++i];
      if (value === undefined) throw new Error(`flag --${key} needs a value`);
      flags[key] = value;
    } else {
      positional.push(arg);
    }
  }

  const path = positional[0];
  if (!path) throw new Error(INGEST_DIR_USAGE);

  const kind = flags.kind;
  if (kind !== undefined && !SOURCE_KINDS.includes(kind as SourceKind)) {
    throw new Error(`--kind must be one of ${SOURCE_KINDS.join(', ')} (got "${kind}")`);
  }

  const model = flags.model;
  if (model !== undefined && !DISTIL_MODELS.includes(model as DistilModelChoice)) {
    throw new Error(`--model must be one of ${DISTIL_MODELS.join(', ')} (got "${model}")`);
  }

  let limit: number | undefined;
  if (flags.limit !== undefined) {
    const n = Number(flags.limit);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`--limit must be a positive integer (got "${flags.limit}")`);
    }
    limit = n;
  }

  return {
    path,
    ...(kind !== undefined ? { kind: kind as SourceKind } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(booleans.has('dry-run') ? { dryRun: true } : {}),
    ...(model !== undefined ? { model: model as DistilModelChoice } : {}),
  };
}

export interface IngestDirectoryOptions {
  dryRun?: boolean;
  limit?: number;
  kind?: SourceKind;
}

export interface IngestDirectoryResult {
  dryRun: boolean;
  plan: JobPlan;
  // `null` in dry-run mode (no jobs were actually attempted).
  bulk: BulkIngestResult | null;
}

export async function ingestDirectory(
  rootPath: string,
  deps: { provider: IngestProvider; repository: CanonRepository },
  options: IngestDirectoryOptions = {},
): Promise<IngestDirectoryResult> {
  const candidates = readHtmlCandidates(rootPath);
  const plan = planJobs(candidates);

  if (options.dryRun) {
    return { dryRun: true, plan, bulk: null };
  }

  const limited =
    options.limit !== undefined && options.limit < plan.jobs.length
      ? plan.jobs.slice(0, options.limit)
      : plan.jobs;

  const jobs = limited.map((job) => {
    // Re-read the HTML for the surviving job: planning kept `cleanedText` for
    // the near-empty guard, but `ingestHtml` wants the raw markup so the
    // metadata deriver can read `<title>` / `<h1>` and the extractor can
    // re-compute headings. Re-reading is cheap relative to a distil call and
    // keeps the planner contract small.
    return {
      // The bulk progress store is keyed by Source id — using the path as a
      // stable per-batch id matches what the durable store will use in slice
      // 4 (issue #15) and keeps the in-memory store sensible for re-runs of
      // the same batch.
      sourceId: job.path,
      ingest: async () => {
        const html = readFileSync(job.path, 'utf8');
        const { result } = await ingestHtml(
          {
            html,
            path: job.path,
            ...(options.kind !== undefined ? { kind: options.kind } : {}),
          },
          deps,
        );
        return result;
      },
    };
  });

  const bulk = await bulkIngest(jobs, new InMemoryBulkProgressStore());
  return { dryRun: false, plan, bulk };
}

// Recursive walk, yielding every file so `planJobs` can report PDFs / images /
// CSS in the skipped-by-reason summary the dry-run prints. Only files whose
// extension matches are actually read + extracted; everything else carries an
// empty `cleanedText` and is dropped by `planJobs`'s extension filter (which
// runs before the near-empty check, so the reason reported is `extension`).
function readHtmlCandidates(root: string): Array<{ path: string; cleanedText: string }> {
  const candidates: Array<{ path: string; cleanedText: string }> = [];
  for (const path of walkFiles(root)) {
    if (isLikelyHtml(path)) {
      const html = readFileSync(path, 'utf8');
      const { text } = htmlToText(html);
      candidates.push({ path, cleanedText: text });
    } else {
      candidates.push({ path, cleanedText: '' });
    }
  }
  return candidates;
}

function* walkFiles(root: string): Generator<string> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = readdirSync(dir, { withFileTypes: true });
    // Reverse-sort so popping the stack visits names in lexical order. The
    // final job list is re-sorted by `planJobs`, but a deterministic walk
    // makes the dry-run sample reproducible across runs.
    entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        yield full;
      } else {
        // Symlink / other — stat to find out what's on the other side.
        try {
          const st = statSync(full);
          if (st.isDirectory()) stack.push(full);
          else if (st.isFile()) yield full;
        } catch {
          // Broken symlink — skip silently.
        }
      }
    }
  }
}

function isLikelyHtml(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = path.slice(dot).toLowerCase();
  return ext === '.html' || ext === '.htm';
}

export function formatDryRunSummary(plan: JobPlan): string {
  const counts = countSkipReasons(plan.skipped);
  const reasonLines = Object.entries(counts).map(([reason, n]) => `    ${reason}: ${n}`);
  const sample = plan.jobs.slice(0, 5).map((j) => `    ${j.path}`);
  const totalChars = plan.jobs.reduce((n, j) => n + j.cleanedText.length, 0);

  const lines = [
    `would ingest: ${plan.jobs.length}`,
    `skipped: ${plan.skipped.length}`,
    ...reasonLines,
  ];
  if (sample.length > 0) {
    lines.push('sample:');
    lines.push(...sample);
  }
  lines.push(`estimated input chars: ${totalChars}`);
  return lines.join('\n');
}

function countSkipReasons(skipped: ReadonlyArray<SkippedFile>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of skipped) counts[s.reason] = (counts[s.reason] ?? 0) + 1;
  return counts;
}
