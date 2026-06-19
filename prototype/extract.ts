// THROWAWAY PROTOTYPE — ingest spike. Extraction front-end for the BOOK branches.
//
// The first spike proved the distiller on clean markdown. This one feeds it text pulled
// from a REAL book two ways — born-digital (pdftotext) and scanned→OCR (pdftoppm+tesseract)
// — to de-risk CONTEXT.md's two book ingest branches before slicing.
//
// Pure shell wrappers (execFile, no shell → bracketed/space filenames are safe) + the
// normalization that decides whether a distilled Quote still matches its Source verbatim.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);

export type Page = { page: number; text: string };

// ── Born-digital branch: pdftotext, one page at a time so the locator is the page ────────
export async function extractDigital(pdf: string, from: number, to: number): Promise<Page[]> {
  const pages: Page[] = [];
  for (let p = from; p <= to; p++) {
    const { stdout } = await run('pdftotext', ['-f', String(p), '-l', String(p), pdf, '-']);
    pages.push({ page: p, text: stdout });
  }
  return pages;
}

// ── Scanned branch: rasterize each page → tesseract OCR. dpi 300 is the usual sweet spot ─
export async function extractOcr(pdf: string, from: number, to: number, dpi = 300): Promise<Page[]> {
  const dir = await mkdtemp(join(tmpdir(), 'pdb-ocr-'));
  try {
    const pages: Page[] = [];
    for (let p = from; p <= to; p++) {
      const prefix = join(dir, `pg${p}`);
      await run('pdftoppm', ['-png', '-r', String(dpi), '-f', String(p), '-l', String(p), pdf, prefix]);
      const png = (await readdir(dir)).find((f) => f.startsWith(`pg${p}`) && f.endsWith('.png'));
      if (!png) { pages.push({ page: p, text: '' }); continue; }
      const { stdout } = await run('tesseract', [join(dir, png), 'stdout', '--psm', '1']);
      pages.push({ page: p, text: stdout });
    }
    return pages;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── Normalization: the line that separates "OCR is unusable" from "needs a cleanup pass" ─
// A Quote is evidence only if it can be found back in the Source. Cosmetic noise — curly
// quotes from the typesetter, soft hyphens from line wrapping, OCR ligatures — must not be
// mistaken for Drift. Three tiers let us see WHERE a quote fails to match.

// straight everything, de-hyphenate wrapped words, collapse whitespace, fold ligatures
export function normalize(s: string): string {
  return s
    .replace(/(\w)[-­]\s*\n\s*(\w)/g, '$1$2')      // join hyphen-split line wraps
    .replace(/[‘’ʼ′]/g, "'")          // curly / modifier apostrophes
    .replace(/[“”″]/g, '"')                // curly quotes
    .replace(/[–—―]/g, '-')                // en / em / horizontal dash
    .replace(/…/g, '...')                            // ellipsis
    .replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')    // fi / fl ligatures
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// last-resort tier: keep only letters/digits/space, so ONLY a real word difference can fail
export function alnum(s: string): string {
  return normalize(s).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export type QuoteMatch = { exact: boolean; normalized: boolean; alnum: boolean };
export function quoteSurvives(quote: string, source: string): QuoteMatch {
  return {
    exact: source.includes(quote),
    normalized: normalize(source).includes(normalize(quote)),
    alnum: alnum(source).includes(alnum(quote)),
  };
}

// ── Levenshtein similarity — OCR fidelity vs born-digital ground truth on the SAME page ──
export function similarity(a: string, b: string): number {
  a = normalize(a); b = normalize(b);
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}
