// THROWAWAY PROTOTYPE — book-ingest spike.  Run: npm run ingest   (re-runs are cached & free)
//
// QUESTION it answers (the last unknown before slicing): can a REAL book go through the two
// book ingest branches in CONTEXT.md — born-digital PDF (extract→distil) and scanned image
// (OCR→distil) — and still feed the proven distiller faithfully? Specifically:
//   1. Does extraction give clean, reading-order, page-located text from a real book?
//   2. OCR fidelity — how close is tesseract to the born-digital ground truth on the SAME page?
//   3. THE load-bearing check: do the distilled Quotes still match the Source VERBATIM
//      (the evidence guarantee in ADR-0003), and does that survive OCR noise after a sane
//      normalization pass (de-hyphenate, fold curly quotes/dashes/ligatures)?
//   4. Does every Principle carry a page locator (CONTEXT: "the locator is the page")?
//
// Reuses the validated bits from spike 1: DISTILL_SYSTEM + distillUser (pipeline.ts), chatJSON
// (llm.ts). The NEW surface is extract.ts. Retrieval parity was already settled in spike 1, so
// this run deliberately skips embeddings and stays on extraction + fidelity.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DISTILL_SYSTEM, distillUser } from './pipeline';
import { chatJSON } from './llm';
import {
  extractDigital, extractOcr, quoteSurvives, similarity, type Page, type QuoteMatch,
} from './extract';

const DL = '/home/kenmen/Downloads';
const CACHE = new URL('./.cache-ingest.json', import.meta.url);

const B = '\x1b[1m', D = '\x1b[2m', R = '\x1b[0m', G = '\x1b[32m', Y = '\x1b[33m', RED = '\x1b[31m';

type Branch = 'digital' | 'ocr';
type Job = { label: string; title: string; pdf: string; branch: Branch; from: number; to: number; note: string };

// Same page window for the born-digital + controlled-OCR runs → measurable OCR error rate.
const PDL_FROM = 38, PDL_TO = 43;
const JOBS: Job[] = [
  {
    label: 'PDL-digital', title: 'The Purpose-Driven Life', branch: 'digital',
    pdf: `${DL}/[Rick_Warren]_The_Purpose-Driven_Life_What_on_Earth_Am_I_Here_For.pdf`,
    from: PDL_FROM, to: PDL_TO, note: 'born-digital book → pdftotext',
  },
  {
    label: 'PDL-ocr', title: 'The Purpose-Driven Life', branch: 'ocr',
    pdf: `${DL}/[Rick_Warren]_The_Purpose-Driven_Life_What_on_Earth_Am_I_Here_For.pdf`,
    from: PDL_FROM, to: PDL_TO, note: 'SAME pages rasterized → tesseract (fidelity vs ground truth)',
  },
  {
    label: 'Tao-scan', title: '365 Tao: Daily Meditations', branch: 'ocr',
    pdf: `${DL}/365-tao-daily-meditations.pdf`,
    from: 60, to: 65, note: 'genuinely scanned book (no text layer) → tesseract, end-to-end',
  },
];

type Atom = { claim: string; quote: string; page: number };
type Result = { pages: Page[]; atoms: Atom[] };
type Cache = Record<string, Result>;

async function loadCache(): Promise<Cache> {
  if (!existsSync(CACHE)) return {};
  try { return JSON.parse(await readFile(CACHE, 'utf8')); } catch { return {}; }
}

async function distilPage(title: string, p: Page): Promise<Atom[]> {
  if (p.text.trim().length < 40) return [];
  const out = await chatJSON(DISTILL_SYSTEM, distillUser(title, p.text));
  const items = Array.isArray(out?.principles) ? out.principles : [];
  return items
    .filter((x: any) => x?.claim && x?.quote)
    .map((x: any) => ({ claim: String(x.claim), quote: String(x.quote), page: p.page }));
}

async function runJob(job: Job, cache: Cache): Promise<Result> {
  if (cache[job.label]) return cache[job.label];
  process.stdout.write(`${D}  extracting ${job.label} (${job.note})…${R}\n`);
  const pages = job.branch === 'digital'
    ? await extractDigital(job.pdf, job.from, job.to)
    : await extractOcr(job.pdf, job.from, job.to);
  const atoms: Atom[] = [];
  for (const p of pages) {
    process.stdout.write(`${D}  distilling ${job.label} p${p.page}…${R}\n`);
    atoms.push(...(await distilPage(job.title, p)));
  }
  const result = { pages, atoms };
  cache[job.label] = result;
  await writeFile(CACHE, JSON.stringify(cache), 'utf8');
  return result;
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}%` : '—');
function tierColor(m: QuoteMatch): string {
  if (m.exact) return G;
  if (m.normalized || m.alnum) return Y;
  return RED;
}

function report(job: Job, res: Result) {
  const pageText = new Map(res.pages.map((p) => [p.page, p.text]));
  const matches = res.atoms.map((a) => ({ a, m: quoteSurvives(a.quote, pageText.get(a.page) ?? '') }));
  const ex = matches.filter((x) => x.m.exact).length;
  const nm = matches.filter((x) => x.m.normalized).length;
  const al = matches.filter((x) => x.m.alnum).length;
  const withPage = res.atoms.filter((a) => Number.isFinite(a.page)).length;
  const nPages = res.pages.filter((p) => p.text.trim().length > 40).length;

  console.log(`\n${B}── ${job.label}${R}  ${D}${job.note}${R}`);
  console.log(`   pages w/ text: ${nPages}/${res.pages.length}   Principles: ${B}${res.atoms.length}${R} (${(res.atoms.length / Math.max(1, nPages)).toFixed(1)}/page)   page-locator: ${withPage === res.atoms.length ? G : RED}${pct(withPage, res.atoms.length)}${R}`);
  console.log(`   verbatim quote survival →  exact ${G}${pct(ex, res.atoms.length)}${R}   +normalized ${Y}${pct(nm, res.atoms.length)}${R}   +alnum ${pct(al, res.atoms.length)}${R}`);
  // up to 4 examples, prioritising any that fail exact so we can see the failure mode
  const shown = [...matches].sort((a, b) => Number(a.m.exact) - Number(b.m.exact)).slice(0, 4);
  for (const { a, m } of shown) {
    const tag = m.exact ? `${G}exact${R}` : m.normalized ? `${Y}norm${R}` : m.alnum ? `${Y}alnum${R}` : `${RED}NO-MATCH${R}`;
    console.log(`     ${tierColor(m)}•${R} p${a.page} ${B}${a.claim}${R}  [${tag}]`);
    console.log(`        ${D}“${a.quote.slice(0, 110).replace(/\s+/g, ' ')}${a.quote.length > 110 ? '…' : ''}”${R}`);
  }
}

function ocrFidelity(digital: Result, ocr: Result) {
  const dMap = new Map(digital.pages.map((p) => [p.page, p.text]));
  console.log(`\n${B}── OCR fidelity${R}  ${D}tesseract vs pdftotext on the SAME pages (normalized char similarity)${R}`);
  const sims: number[] = [];
  for (const p of ocr.pages) {
    const d = dMap.get(p.page);
    if (!d) continue;
    const s = similarity(d, p.text);
    sims.push(s);
    const c = s > 0.97 ? G : s > 0.9 ? Y : RED;
    console.log(`   p${p.page}: ${c}${(100 * s).toFixed(1)}%${R}`);
  }
  if (sims.length) console.log(`   ${B}mean ${(100 * sims.reduce((a, b) => a + b, 0) / sims.length).toFixed(1)}%${R}`);
}

async function main() {
  console.log(`${B}=== principleDB book-ingest spike ===${R}`);
  console.log(`${D}born-digital + OCR branches → proven distiller → verbatim-quote survival + page locators${R}`);
  const cache = await loadCache();
  const results: Record<string, Result> = {};
  for (const job of JOBS) results[job.label] = await runJob(job, cache);

  for (const job of JOBS) report(job, results[job.label]);
  if (results['PDL-digital'] && results['PDL-ocr']) ocrFidelity(results['PDL-digital'], results['PDL-ocr']);

  console.log(`\n${D}(cached → re-runs free; delete prototype/.cache-ingest.json to re-extract)${R}`);
  console.log(`${D}Capture the verdict → prototype/INGEST-NOTES.md${R}`);
}

main().catch((e) => { console.error(`${RED}FATAL${R}: ${e.message}`); process.exit(1); });
