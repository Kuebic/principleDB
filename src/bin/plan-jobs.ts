// Pure job planner for the directory-walker ingest path (Phase 0 / Slice 3,
// issue #14, PRD #11).
//
// Given a list of `{ path, cleanedText }` candidates (one per HTML file the
// walker has read + run through `htmlToText`), apply the three corpus-aware
// filters and emit a deterministic, resumable plan:
//
//   1. Extension allowlist — keep only `.html` / `.htm`.
//   2. Filename denylist (case-insensitive on the basename) — drop nav chrome:
//      `*toc*`, `*index*`, `*back*`, `*button*`, `0-Toc.html`, `Default.html`,
//      `favicon*`, `Lib-*.html`, `Tp-*.html`.
//   3. Near-empty guard — drop files whose cleaned text is < 200 chars (nav
//      pages that slip the filename filter).
//
// Output is sorted lexically by path so re-runs ingest in the same order — the
// resumable-progress story (slice 4 / issue #15) relies on `bulkIngest`
// receiving jobs in a stable sequence.
//
// Kept off the filesystem on purpose: the walker shell does the IO, the
// planner does the policy. Tests pass synthetic items to pin the filter rules
// without a tmpdir.

export interface PlanInput {
  // Path to the candidate file (repo-relative or absolute — only the
  // basename and extension matter for filtering).
  path: string;
  // The plain-text extraction from `htmlToText` for this file. Used by the
  // near-empty guard, and re-emitted on `PlannedJob` so the dry-run summary
  // can report a cheap "estimated input chars" figure without re-reading
  // every file. The bulk-ingest path re-reads the raw HTML — the metadata
  // deriver needs `<title>` / `<h1>` and the extractor needs to re-emit
  // headings — so `cleanedText` is not consumed downstream of planning.
  cleanedText: string;
}

export interface PlannedJob {
  path: string;
  cleanedText: string;
}

// `normalized-duplicate` (issue #16) and `binary` (issue #18) are set by the
// walker before/after `planJobs`, not by `planJobs` itself — the pure planner
// only knows about path-/content-policy filters. They're listed here so the
// `SkipReason` union stays the single source of truth for "all reasons a file
// can be dropped" that the dry-run summary iterates over.
export type SkipReason =
  | 'extension'
  | 'denylist'
  | 'near-empty'
  | 'normalized-duplicate'
  | 'binary';

export interface SkippedFile {
  path: string;
  reason: SkipReason;
}

export interface JobPlan {
  jobs: PlannedJob[];
  skipped: SkippedFile[];
}

// Files shorter than this (after HTML → text extraction) are assumed to be nav
// chrome that slipped the filename filter — not worth a distil call.
export const NEAR_EMPTY_MIN_CHARS = 200;

const ALLOWED_EXTENSIONS = new Set(['.html', '.htm']);

// Per the PRD: case-insensitive substring matches keep the rule list short.
// Glob patterns (`Lib-*.html`, `Tp-*.html`) are translated to anchored regexes
// rather than substring matches so we don't accidentally swallow files like
// `Notable-foo.html` containing the letters `lib` somewhere in their name.
const DENY_SUBSTRINGS = ['toc', 'index', 'back', 'button', 'favicon'];
const DENY_REGEXES: RegExp[] = [
  /^0-toc\.html$/i,
  /^default\.html$/i,
  /^lib-.*\.html?$/i,
  /^tp-.*\.html?$/i,
];

export function planJobs(inputs: ReadonlyArray<PlanInput>): JobPlan {
  const jobs: PlannedJob[] = [];
  const skipped: SkippedFile[] = [];

  for (const input of inputs) {
    const reason = classify(input);
    if (reason === null) {
      jobs.push({ path: input.path, cleanedText: input.cleanedText });
    } else {
      skipped.push({ path: input.path, reason });
    }
  }

  jobs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { jobs, skipped };
}

// Returns the first skip reason that applies, in priority order, or null if
// the file passes every filter. Path-based filters run before content checks so
// a denylisted-but-empty file is reported as `denylist`, not `near-empty`.
function classify(input: PlanInput): SkipReason | null {
  const name = basename(input.path);
  const ext = extension(name);
  if (!ALLOWED_EXTENSIONS.has(ext.toLowerCase())) return 'extension';
  if (isDenylisted(name)) return 'denylist';
  if (input.cleanedText.length < NEAR_EMPTY_MIN_CHARS) return 'near-empty';
  return null;
}

function basename(path: string): string {
  const norm = path.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  return i < 0 ? norm : norm.slice(i + 1);
}

function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot);
}

function isDenylisted(name: string): boolean {
  const lower = name.toLowerCase();
  for (const sub of DENY_SUBSTRINGS) {
    if (lower.includes(sub)) return true;
  }
  for (const re of DENY_REGEXES) {
    if (re.test(name)) return true;
  }
  return false;
}
