// `ingest:pdf` core — the PDF branch of the seed pipeline (ADR-0010, issue #3/#9).
//
// Ingest a book that exists only as PDF — either a single `.pdf` file or a
// directory of per-chapter PDFs. The tparents mirror splits the canonical
// scriptures this way (`ChambumoGyeong-00.pdf … -14.pdf`, `PHG14-01.pdf …`),
// and because each chapter is a small, native-text PDF it extracts as a single
// Marker chunk — so this path uses the single-file `ingestPdfSource`
// orchestrator, not the OOM-avoiding sectioned large-book path (that stays
// reserved for the multi-hundred-page single-file books, issue #9).
//
// Each PDF becomes its own Source: Marker → page-anchored markdown, the
// original PDF → R2, then the shared distil→admit→embed→dedup→persist tail.
// Resumability + per-Source error capture come from `bulkIngest` (the same
// durable-progress machinery the HTML walker uses), so a crash mid-book
// re-extracts only the chapters that had not completed.
//
// Provenance: unlike the HTML dir walker — which can derive `author` from a
// path like `.../Ahn/Ahn-060721.html` — the mirror's PDF books sit under
// book-code dirs (`ChambumoGyeong/`, `PHG14/`) that name the work, not the
// author. So the CLI takes an explicit `--author` (and optional `--title`,
// stamped as a per-chapter prefix), keeping the canonical scripture set clean;
// absent the flag it falls back to the parent-dir name like the HTML path.
//
// Design surface (parse / plan / dry-run / orchestrate) is pure and testable;
// the Marker CLI wiring, R2 client, and Postgres progress store are injected by
// the `bin/principledb-ingest-pdf.ts` shell via `build-pdf-deps.ts`.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { BlobStore } from '../canon/blob-store';
import {
  bulkIngest,
  InMemoryBulkProgressStore,
  type BulkIngestJob,
  type BulkIngestResult,
  type BulkProgressStore,
} from '../canon/bulk-ingest';
import type { ExtractionTarget, PdfExtractor } from '../canon/marker';
import { ingestPdfSource, type PdfSourceMeta } from '../canon/pdf-ingest';
import type { CanonRepository, IngestProvider } from '../canon/ports';
import type { SourceKind } from '../canon/types';
import { deriveHtmlSourcePathId } from './derive-path-source-id';

const SOURCE_KINDS: readonly SourceKind[] = ['sermon', 'book', 'article', 'transcript'];
const TARGETS: readonly ExtractionTarget[] = ['cpu', 'remote-gpu'];

export type DistilModelChoice = 'haiku' | 'opus';
const DISTIL_MODELS: readonly DistilModelChoice[] = ['haiku', 'opus'];

// Distil a big chapter in windows of at most this many chars (split on page
// boundaries). Sized so each window's principle output fits under distil's
// max_tokens (16000): distil uses a tool call whose JSON silently truncates to
// zero items if the output overflows, so a window must be small enough to emit
// all its principles. ~40k chars (~75 principles, ~6k output tokens) leaves
// comfortable headroom; a 50k window already yields ~94. Override with
// --max-distil-chars. (This also keeps each request well under the provider's
// input+max_tokens burst reservation.)
export const DEFAULT_MAX_DISTIL_CHARS = 40000;

export const INGEST_PDF_USAGE =
  'usage: principledb-ingest-pdf <file.pdf|dir> [--author A] [--title T] ' +
  '[--kind sermon|book|article|transcript] [--date YYYY-MM-DD] ' +
  '[--target cpu|remote-gpu] [--model haiku|opus] [--limit N] [--max-distil-chars N] [--dry-run] [--no-archive]';

export interface IngestPdfArgs {
  path: string;
  author?: string;
  title?: string;
  kind?: SourceKind;
  date?: string;
  target: ExtractionTarget;
  // Distil model. Defaults to Haiku in the bin — the Claude Code OAuth token is
  // Haiku-entitled; Opus is gated and returns 429. `opus` only works with an
  // API key that has the entitlement.
  model?: DistilModelChoice;
  limit?: number;
  maxDistilChars?: number;
  dryRun?: boolean;
  // Archive originals to R2 (default). `--no-archive` swaps in an ephemeral
  // in-memory blob store — principles still land in the Canon, but the
  // jump-to-original PDF is not persisted. Useful before R2 is verified.
  archive: boolean;
}

export function parseIngestPdfArgs(argv: string[]): IngestPdfArgs {
  const flags: Record<string, string> = {};
  const booleans = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--dry-run' || arg === '--no-archive') {
      booleans.add(arg.slice(2));
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
  if (!path) throw new Error(INGEST_PDF_USAGE);

  const kind = flags.kind;
  if (kind !== undefined && !SOURCE_KINDS.includes(kind as SourceKind)) {
    throw new Error(`--kind must be one of ${SOURCE_KINDS.join(', ')} (got "${kind}")`);
  }

  const target = flags.target ?? 'cpu';
  if (!TARGETS.includes(target as ExtractionTarget)) {
    throw new Error(`--target must be one of ${TARGETS.join(', ')} (got "${target}")`);
  }

  const model = flags.model;
  if (model !== undefined && !DISTIL_MODELS.includes(model as DistilModelChoice)) {
    throw new Error(`--model must be one of ${DISTIL_MODELS.join(', ')} (got "${model}")`);
  }

  const limit = parsePositiveInt(flags.limit, '--limit');
  const maxDistilChars = parsePositiveInt(flags['max-distil-chars'], '--max-distil-chars');

  return {
    path,
    target: target as ExtractionTarget,
    archive: !booleans.has('no-archive'),
    ...(flags.author !== undefined ? { author: flags.author } : {}),
    ...(flags.title !== undefined ? { title: flags.title } : {}),
    ...(kind !== undefined ? { kind: kind as SourceKind } : {}),
    ...(flags.date !== undefined ? { date: flags.date } : {}),
    ...(model !== undefined ? { model: model as DistilModelChoice } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(maxDistilChars !== undefined ? { maxDistilChars } : {}),
    ...(booleans.has('dry-run') ? { dryRun: true } : {}),
  };
}

export interface PlannedPdf {
  path: string;
  sourceId: string;
  meta: PdfSourceMeta;
}

export interface PdfPlan {
  jobs: PlannedPdf[];
}

// Walk the target into an ordered PDF list, then stamp each with a
// deterministic path-based Source id and derived metadata. A directory is
// gathered recursively (case-insensitive `.pdf`) and sorted by path, so
// zero-padded chapter files (`-00`, `-01`, …) land in reading order.
export function planPdfSources(args: IngestPdfArgs): PdfPlan {
  const files = collectPdfPaths(args.path);
  const limited = args.limit !== undefined ? files.slice(0, args.limit) : files;
  const jobs = limited.map((p) => {
    const sourceId = deriveHtmlSourcePathId(normalizePath(p));
    return { path: p, sourceId, meta: derivePdfMeta(p, args, sourceId) };
  });
  return { jobs };
}

export interface IngestPdfDeps {
  extractor: PdfExtractor;
  blobs: BlobStore;
  provider: IngestProvider;
  repository: CanonRepository;
}

export interface IngestPdfRunOptions {
  progress?: BulkProgressStore;
  signal?: AbortSignal;
  // Injected PDF reader for tests, forwarded to `ingestPdfSource`.
  readPdf?: (path: string) => Promise<Uint8Array>;
}

export interface IngestPdfRunResult {
  plan: PdfPlan;
  bulk: BulkIngestResult;
}

export async function ingestPdfSources(
  args: IngestPdfArgs,
  deps: IngestPdfDeps,
  options: IngestPdfRunOptions = {},
): Promise<IngestPdfRunResult> {
  const plan = planPdfSources(args);
  const progress = options.progress ?? new InMemoryBulkProgressStore();

  const jobs: BulkIngestJob[] = plan.jobs.map((j) => ({
    sourceId: j.sourceId,
    ingest: () =>
      ingestPdfSource(j.path, j.meta, deps, {
        target: args.target,
        maxDistilChars: args.maxDistilChars ?? DEFAULT_MAX_DISTIL_CHARS,
        ...(options.readPdf ? { readPdf: options.readPdf } : {}),
      }),
  }));

  const bulk = await bulkIngest(
    jobs,
    progress,
    options.signal ? { signal: options.signal } : {},
  );
  return { plan, bulk };
}

export function formatPdfDryRunSummary(plan: PdfPlan): string {
  const sample = plan.jobs
    .slice(0, 8)
    .map((j) => `    ${basename(j.path)}  ->  author="${j.meta.author}"  title="${j.meta.title}"`);
  const lines = [`would ingest: ${plan.jobs.length} PDF source(s)`];
  if (sample.length > 0) {
    lines.push('sample:');
    lines.push(...sample);
  }
  return lines.join('\n');
}

// --- metadata + path helpers ---------------------------------------------

function derivePdfMeta(pdfPath: string, args: IngestPdfArgs, id: string): PdfSourceMeta {
  const stem = stripExtension(basename(pdfPath));
  const title =
    args.title !== undefined ? `${args.title} — ${stem}` : humanizeStem(stem);
  return {
    id,
    title,
    author: args.author ?? parentDir(pdfPath),
    // PdfSourceMeta.date is required; use the flag, or '' rather than
    // fabricating a date the filename does not carry (mirrors the HTML
    // deriver, which omits date when no token is present).
    date: args.date ?? '',
    kind: args.kind ?? 'book',
  };
}

// Gather `.pdf` files from a file or directory target. Throws when the target
// is neither a PDF nor a directory, so a typo'd path fails loudly.
function collectPdfPaths(target: string): string[] {
  const st = statSync(target);
  if (st.isDirectory()) {
    const out: string[] = [];
    walkPdfs(target, out);
    return out.sort();
  }
  if (isPdf(target)) return [target];
  throw new Error(`${target} is not a .pdf file or a directory`);
}

function walkPdfs(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkPdfs(full, out);
    else if (entry.isFile() && isPdf(entry.name)) out.push(full);
  }
}

function isPdf(name: string): boolean {
  return name.toLowerCase().endsWith('.pdf');
}

function parsePositiveInt(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer (got "${raw}")`);
  }
  return n;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function basename(path: string): string {
  const norm = normalizePath(path);
  const i = norm.lastIndexOf('/');
  return i < 0 ? norm : norm.slice(i + 1);
}

function parentDir(path: string): string {
  const norm = normalizePath(path);
  const lastSlash = norm.lastIndexOf('/');
  if (lastSlash <= 0) return '';
  const dir = norm.slice(0, lastSlash);
  const prevSlash = dir.lastIndexOf('/');
  return prevSlash < 0 ? dir : dir.slice(prevSlash + 1);
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function humanizeStem(stem: string): string {
  return stem.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
}
