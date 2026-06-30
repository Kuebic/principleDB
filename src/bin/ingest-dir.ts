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
// Resumable durable progress (slice 4 / issue #15): the walker takes an
// optional `BulkProgressStore` so the bin wires the durable Postgres impl when
// `DATABASE_URL` is present; tests and dry-runs default to
// `InMemoryBulkProgressStore`. The progress key is a path-based deterministic
// Source id (`deriveHtmlSourcePathId`) computed from each file's repo-relative
// path, so resume can skip completed Sources by id **without** re-reading
// every HTML file from disk — essential over 100k+ files.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import {
  bulkIngest,
  InMemoryBulkProgressStore,
  type BulkProgressStore,
  type BulkIngestResult,
} from '../canon/bulk-ingest';
import type { CanonRepository, IngestProvider } from '../canon/ports';
import {
  InMemorySeenTextStore,
  normalizedTextHash,
  type SeenTextStore,
} from '../canon/seen-text-store';
import type { SourceKind } from '../canon/types';
import { isLikelyBinary } from './binary-guard';
import { deriveHtmlSourcePathId } from './derive-path-source-id';
import { htmlToText } from './html-to-text';
import { ingestHtml } from './ingest-html';
import {
  planJobs,
  type JobPlan,
  type PlannedJob,
  type PlanInput,
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
  // Durable bulk-progress store. The bin wires `PostgresBulkProgressStore`
  // when `DATABASE_URL` is present; tests inject the in-memory impl.
  // Omitted ⇒ a fresh `InMemoryBulkProgressStore` is used for this run.
  progress?: BulkProgressStore;
  // Normalized-text near-dupe cache (issue #16). The bin wires
  // `PostgresSeenTextStore`; tests pass an in-memory store (or omit it to
  // get a fresh in-memory one per call). Consulted BEFORE distil so
  // whitespace-variant captures of the same document skip the distil call;
  // recorded AFTER ingest succeeds so a crash mid-distil never leaves an
  // orphan hash that would later silently skip the file without ingesting.
  seenText?: SeenTextStore;
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
  const progress = options.progress ?? new InMemoryBulkProgressStore();
  const seenText = options.seenText ?? new InMemorySeenTextStore();
  const isDryRun = options.dryRun === true;

  // Walk paths and consult the progress store BEFORE reading any HTML —
  // already-completed Sources never reach `readFileSync`. This is the cheap-
  // resume guarantee (issue #15): a 100k-file corpus on resume should walk
  // the tree (stat-only) and skip the rest, not re-read every doc.
  //
  // Dry-runs intentionally ignore progress so the plan reflects what a fresh
  // run would do — the dry-run is the pre-flight, not the live tally.
  const planInputs: PlanInput[] = [];
  const binarySkips: SkippedFile[] = [];
  const alreadyDone: string[] = [];
  for (const path of walkFiles(rootPath)) {
    if (!isLikelyHtml(path)) {
      // Non-HTML carries empty cleanedText so `planJobs` reports it as an
      // `extension` skip — same reason it would have given before. No read.
      planInputs.push({ path, cleanedText: '' });
      continue;
    }

    if (!isDryRun) {
      const relPath = repoRelativePath(rootPath, path);
      const sourceId = deriveHtmlSourcePathId(relPath);
      if (await progress.has(sourceId)) {
        alreadyDone.push(sourceId);
        continue;
      }
    }

    // Read as raw bytes so the binary guard (issue #18) can refuse JPEG /
    // scanned-image content saved with a `.html` suffix BEFORE decode. NUL
    // bytes survive utf-8 conversion and would later crash the Source insert.
    const buffer = readFileSync(path);
    if (isLikelyBinary(buffer)) {
      binarySkips.push({ path, reason: 'binary' });
      continue;
    }
    const { text } = htmlToText(buffer.toString('utf8'));
    planInputs.push({ path, cleanedText: text });
  }
  const initialPlan = planJobs(planInputs);

  // Normalized-text near-dupe pre-pass (issue #16). Run AFTER `planJobs` so
  // we never spend a hash on files that path-/content-policy filters would
  // have dropped anyway. Apply both an intra-batch Set (catches duplicate
  // pairs within this single run, before any record() lands in the store)
  // and the persistent SeenTextStore (catches resume / cross-run dupes).
  const intraBatchSeen = new Set<string>();
  const hashByPath = new Map<string, string>();
  const keptJobs: PlannedJob[] = [];
  const duplicateSkips: SkippedFile[] = [];
  for (const job of initialPlan.jobs) {
    const hash = normalizedTextHash(job.cleanedText);
    if (intraBatchSeen.has(hash) || (await seenText.seen(hash))) {
      duplicateSkips.push({ path: job.path, reason: 'normalized-duplicate' });
      continue;
    }
    intraBatchSeen.add(hash);
    hashByPath.set(job.path, hash);
    keptJobs.push(job);
  }
  const plan: JobPlan = {
    jobs: keptJobs,
    skipped: [...initialPlan.skipped, ...binarySkips, ...duplicateSkips],
  };

  if (isDryRun) {
    return { dryRun: true, plan, bulk: null };
  }

  const limited =
    options.limit !== undefined && options.limit < plan.jobs.length
      ? plan.jobs.slice(0, options.limit)
      : plan.jobs;

  // Index the kept jobs' hashes by sourceId so the post-bulk record loop
  // can look up each completed Source's hash in a single step.
  const hashBySourceId = new Map<string, string>();
  const plannedJobs = limited.map((job) => {
    const relPath = repoRelativePath(rootPath, job.path);
    const sourceId = deriveHtmlSourcePathId(relPath);
    const hash = hashByPath.get(job.path);
    if (hash !== undefined) hashBySourceId.set(sourceId, hash);
    return {
      sourceId,
      ingest: async () => {
        // Re-read the HTML for the surviving job: planning kept
        // `cleanedText` for the near-empty guard, but `ingestHtml` wants the
        // raw markup so the metadata deriver can read `<title>` / `<h1>`
        // and the extractor can re-compute headings. Re-reading is cheap
        // relative to a distil call and keeps the planner contract small.
        const html = readFileSync(job.path, 'utf8');
        const { result } = await ingestHtml(
          {
            html,
            path: job.path,
            id: sourceId,
            ...(options.kind !== undefined ? { kind: options.kind } : {}),
          },
          deps,
        );
        return result;
      },
    };
  });

  // Already-done Sources are folded into `bulk.skipped` directly. Routing
  // them through `bulkIngest` would force a second `progress.has()` round-
  // trip per Source — on a 100k-file resume that's ~99k redundant queries.
  const bulk = await bulkIngest(plannedJobs, progress);

  // Record hashes for successfully ingested Sources AFTER `bulkIngest`
  // returns. Doing it post-success means a crash mid-distil never leaves a
  // recorded hash for a Source that never reached the Canon, which would
  // later make the walker silently skip its re-ingest. A crash between
  // mark-done and hash-record is harmless: on resume the file is path-id-
  // skipped without reading; a different path with the same text just
  // re-pays a single distil call.
  for (const success of bulk.completed) {
    const hash = hashBySourceId.get(success.sourceId);
    if (hash !== undefined) await seenText.record(hash);
  }

  return {
    dryRun: false,
    plan,
    bulk: { ...bulk, skipped: [...alreadyDone, ...bulk.skipped] },
  };
}

// Normalize an absolute walked path to a stable, OS-independent
// repo-relative id input: forward slashes, no leading `./`. The walker
// receives `rootPath` from the CLI (absolute or relative); the derived id
// must NOT change when the same corpus is walked from a different cwd, so
// the relative path is the right anchor.
function repoRelativePath(rootPath: string, fullPath: string): string {
  const rel = relative(rootPath, fullPath);
  return sep === '/' ? rel : rel.split(sep).join('/');
}

// Recursive walk, yielding every file so `planJobs` can still report PDFs /
// images / CSS in the skipped-by-reason summary the dry-run prints. The walker
// reads + extracts text only for HTML files that aren't already recorded as
// done (issue #15); everything else stays a path-only entry.
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
