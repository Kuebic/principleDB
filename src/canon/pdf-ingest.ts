// ingestPdfSource — the PDF branch of the ingest pipeline (issue #3, ADR-0010).
//
// Marker (Surya OCR + ML layout) handles BOTH native and scanned PDFs in one
// engine, on CPU for small Sources or on the remote A4500 for hard/large books
// (the target is selectable via opts.target). The original PDF is uploaded to
// R2 (blob lake); the query store keeps only a pointer (`Source.r2Key`). The
// extracted markdown becomes the Source's continuous text (the relocation
// substrate of ADR-0007); its `{N}-` page separators populate the pdf-pages
// structureMap (ADR-0009) so deriveLabel emits "page N" or, when a Quote span
// crosses a break, "pages N–M".
//
// This slice covers PDFs Marker can extract as a single chunk — large-book
// splitting (`--split-level`), TOC-bookmark addition for bookmark-less books,
// and boundary normalization are issue #9.

import { readFile } from 'node:fs/promises';
import { ingestDistilledItems, ingestSource, type IngestResult } from './ingest';
import { parseMarkerOutput, type ExtractionTarget, type PdfExtractor } from './marker';
import type { BlobStore } from './blob-store';
import type { CanonRepository, IngestProvider } from './ports';
import type { DistilledItem, Source, SourceKind } from './types';

export interface PdfSourceMeta {
  id: string;
  title: string;
  author: string;
  date: string;
  kind?: SourceKind;
}

export interface IngestPdfDeps {
  extractor: PdfExtractor;
  blobs: BlobStore;
  provider: IngestProvider;
  repository: CanonRepository;
}

export interface IngestPdfOptions {
  target?: ExtractionTarget;
  // Reading the PDF off disk is injected so tests can avoid touching the
  // filesystem; production wires it to fs/promises.readFile.
  readPdf?: (path: string) => Promise<Uint8Array>;
  // When set, distil the extracted text in windows of at most this many chars,
  // split on PDF page boundaries, instead of one call over the whole Source.
  // A single big chapter (~73k input tokens) plus distil's max_tokens exceeds
  // the provider's per-request burst reservation (input + max_tokens) and 429s
  // no matter how many retries; small windows keep each request well under it.
  // Quote relocation is unaffected — admission relocates every quote against the
  // unified Source.text, not the window it was distilled from.
  maxDistilChars?: number;
}

export function r2KeyForPdfSource(id: string): string {
  return `sources/${id}.pdf`;
}

export async function ingestPdfSource(
  pdfPath: string,
  meta: PdfSourceMeta,
  deps: IngestPdfDeps,
  options: IngestPdfOptions = {},
): Promise<IngestResult> {
  const { extractor, blobs, provider, repository } = deps;
  const target = options.target ?? 'cpu';
  const read = options.readPdf ?? ((p) => readFile(p).then((buf) => new Uint8Array(buf)));

  const pdfBytes = await read(pdfPath);
  const r2Key = r2KeyForPdfSource(meta.id);
  await blobs.put(r2Key, pdfBytes);

  const artifact = await extractor.extract(pdfPath, { target });
  const { text, structureMap } = parseMarkerOutput(artifact.markdown);

  const source: Source = {
    id: meta.id,
    title: meta.title,
    author: meta.author,
    kind: meta.kind ?? 'book',
    date: meta.date,
    text,
    r2Key,
    structureMap,
  };

  if (options.maxDistilChars !== undefined && text.length > options.maxDistilChars) {
    const items: DistilledItem[] = [];
    for (const w of planDistilWindows(source, options.maxDistilChars)) {
      const windowItems = await provider.distil({
        title: `${source.title}${w.titleSuffix}`,
        text: text.slice(w.start, w.end),
      });
      items.push(...windowItems);
    }
    return ingestDistilledItems(source, items, { provider, repository });
  }

  return ingestSource(source, { provider, repository });
}

export interface DistilWindow {
  start: number;
  end: number;
  // Appended to the Source title for the window's distil call so the model has
  // locus (e.g. " (pages 25–43)"); empty when there is no page structure.
  titleSuffix: string;
}

// Split a Source's text into distil windows of at most maxChars, breaking on
// PDF page boundaries when the structureMap carries them (so each window is a
// whole run of pages) and falling back to a hard char split otherwise. Windows
// tile [0, text.length) with no gaps or overlaps. An individual page larger
// than maxChars becomes its own over-size window rather than being cut mid-page.
export function planDistilWindows(source: Source, maxChars: number): DistilWindow[] {
  const total = source.text.length;
  if (total <= maxChars) return [{ start: 0, end: total, titleSuffix: '' }];

  const sm = source.structureMap;
  const pageStarts =
    sm.kind === 'pdf-pages' ? sm.pages.map((p) => ({ offset: p.offset, page: p.page })) : [];

  if (pageStarts.length === 0) {
    const out: DistilWindow[] = [];
    for (let s = 0; s < total; s += maxChars) {
      out.push({ start: s, end: Math.min(s + maxChars, total), titleSuffix: '' });
    }
    return out;
  }

  // Greedily pack whole pages into each window. A window closes at the last page
  // start that keeps it within maxChars; if even the first page overflows, the
  // window still holds that one page (closes at the next page start / end).
  const out: DistilWindow[] = [];
  let winStart = 0;
  let firstPage = pageStarts[0]!.page;
  for (let i = 1; i <= pageStarts.length; i++) {
    const nextStart = i < pageStarts.length ? pageStarts[i]!.offset : total;
    if (nextStart - winStart > maxChars) {
      const prevOffset = pageStarts[i - 1]!.offset;
      const closeAt = prevOffset > winStart ? prevOffset : nextStart;
      const lastPage = prevOffset > winStart ? pageStarts[i - 1]!.page - 1 : pageStarts[i - 1]!.page;
      out.push({
        start: winStart,
        end: closeAt,
        titleSuffix: pageRangeSuffix(firstPage, lastPage),
      });
      winStart = closeAt;
      firstPage = closeAt === prevOffset ? pageStarts[i - 1]!.page : pageStarts[i - 1]!.page + 1;
    }
  }
  // Guard against a zero-length trailing window when the last page was force-
  // closed exactly at `total` (an over-size final page).
  if (winStart < total) {
    out.push({
      start: winStart,
      end: total,
      titleSuffix: pageRangeSuffix(firstPage, pageStarts[pageStarts.length - 1]!.page),
    });
  }
  return out;
}

function pageRangeSuffix(first: number, last: number): string {
  return last > first ? ` (pages ${first}–${last})` : ` (page ${first})`;
}
