// Pure metadata deriver for HTML Sources (Phase 0 / Slice 2, issue #13).
//
// Takes the file's repo-relative path plus the raw HTML, returns
// `{ title, author, kind, date? }` following the corpus conventions:
//   - author = the immediate parent directory name (e.g. `.../Ahn/Ahn-060721.html` → `Ahn`)
//   - date   = trailing `-YYMMDD` (6-digit) or `-YYYYMMDD` (8-digit) filename
//              token, with century pivot 00–30 → 20xx, 31–99 → 19xx. Omitted
//              entirely (never fabricated) when no token or not a valid date.
//   - title  = HTML <title> → first <h1> → humanized filename with the date
//              token stripped, in that order.
//   - kind   = `defaultKind` (per-phase homogeneous), defaulting to `'book'`.
//
// The HTML title extraction is its own internal helper; the deriver assembles
// the final fallback (date-stripped, humanized) before consulting the markup,
// so the function stays pure and dependency-free aside from `node-html-parser`.

import { HTMLElement, parse } from 'node-html-parser';

import type { SourceKind } from '../canon/types';

export interface DerivedHtmlMetadata {
  title: string;
  author: string;
  kind: SourceKind;
  date?: string;
}

export interface DeriveHtmlMetadataInput {
  // Repo-relative or absolute path; only the parent directory name and the
  // file basename are read.
  path: string;
  html: string;
  // Per-phase homogeneous default (e.g. `--kind book` for the doctrinal tier).
  defaultKind?: SourceKind;
}

export function deriveHtmlSourceMetadata(input: DeriveHtmlMetadataInput): DerivedHtmlMetadata {
  const { path, html, defaultKind } = input;
  const filename = basename(path);
  const stem = stripExtension(filename);

  const date = parseDateFromStem(stem);
  const titleFallback = humanizeStem(stripDateToken(stem));
  const title = pickTitleFromHtml(html) ?? titleFallback;

  const meta: DerivedHtmlMetadata = {
    title,
    author: parentDir(path),
    kind: defaultKind ?? 'book',
  };
  if (date !== undefined) meta.date = date;
  return meta;
}

// --- path helpers ---------------------------------------------------------

function basename(path: string): string {
  const norm = path.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  return i < 0 ? norm : norm.slice(i + 1);
}

// The directory immediately above the file. Returns '' when the file is at the
// top level (no parent dir in the path).
function parentDir(path: string): string {
  const norm = path.replace(/\\/g, '/');
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

// --- date parsing ---------------------------------------------------------

// Trailing date token: 6 or 8 digits at the end of the stem, preceded by a
// hyphen. Anchored with `(?:^|-)` so a 6/8-digit run that *isn't* a date
// token (e.g. `Sermon123456Notes`) doesn't accidentally match.
const DATE_TOKEN_RE = /(?:^|-)(\d{8}|\d{6})$/;

function parseDateFromStem(stem: string): string | undefined {
  const m = DATE_TOKEN_RE.exec(stem);
  if (!m) return undefined;
  const digits = m[1]!;
  let yyyy: number;
  let mm: number;
  let dd: number;
  if (digits.length === 8) {
    yyyy = Number(digits.slice(0, 4));
    mm = Number(digits.slice(4, 6));
    dd = Number(digits.slice(6, 8));
  } else {
    const yy = Number(digits.slice(0, 2));
    yyyy = yy <= 30 ? 2000 + yy : 1900 + yy;
    mm = Number(digits.slice(2, 4));
    dd = Number(digits.slice(4, 6));
  }
  if (!isValidYmd(yyyy, mm, dd)) return undefined;
  return `${pad4(yyyy)}-${pad2(mm)}-${pad2(dd)}`;
}

function stripDateToken(stem: string): string {
  return stem.replace(DATE_TOKEN_RE, '');
}

function isValidYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  // Day-of-month sanity using JS Date construction. The reconstructed date
  // must match the input components — otherwise JS rolled e.g. Feb 30 → Mar 2.
  const t = new Date(Date.UTC(y, m - 1, d));
  return (
    t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
  );
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function pad4(n: number): string {
  return n.toString().padStart(4, '0');
}

// --- title resolution -----------------------------------------------------

function pickTitleFromHtml(html: string): string | null {
  if (html.length === 0) return null;
  const root = parse(html);
  return pickTextFrom(root.querySelector('title')) ?? pickTextFrom(root.querySelector('h1'));
}

function pickTextFrom(el: HTMLElement | null): string | null {
  if (!el) return null;
  const text = el.text.trim();
  return text.length > 0 ? text : null;
}

// Filename → display title: underscores/dots/hyphens to spaces, runs collapsed.
function humanizeStem(stem: string): string {
  return stem.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
}
