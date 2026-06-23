// MarkerChunk + SectionedPdfExtractor — the multi-chunk extraction port (issue #9, ADR-0010).
//
// Big books (UT, CSG, World Scripture) can't be extracted as a single Marker file: the Surya
// encoder OOMs even the 20 GB A4500. The zettle vault's pipeline splits the PDF by bookmark
// depth (`--split-level N`), runs Marker per section, and re-emits each section's markdown
// with its original-PDF `{N}---` page anchors preserved. A SectionedPdfExtractor wraps that
// behaviour behind a port so principleDB stays agnostic of where the split-and-extract runs.
//
// FakeSectionedPdfExtractor is the deterministic in-process double the orchestrator tests
// use to assert chunk handling end-to-end without invoking Marker or the A4500.

import type { ExtractOptions, ExtractionTarget } from './marker';

export interface MarkerChunk {
  // 0-based ordinal in the PDF's reading order. Stable across re-extracts so the
  // boundary normalizer and the front/back router can reason about adjacency.
  index: number;
  // Human-readable section title — drawn from the bookmark (or the TOC-derived
  // bookmark plan, for books that lacked them). The orchestrator stamps it into
  // the distil call's `title` so the model has section context.
  sectionLabel: string;
  // Depth of the bookmark that produced this chunk (1 = top-level). The splitter
  // is configured per-book via `--split-level`; downstream code uses depth as a
  // tie-breaker when label-based routing is ambiguous.
  bookmarkDepth: number;
  // 1-indexed first page of the section in the original PDF — useful for ordinal
  // routing (front-matter is typically the early pages) and for diagnostics.
  startPage: number;
  // Marker's cleaned markdown for THIS chunk, with `{N}---` separators that
  // reference original-PDF page numbers (not chunk-local). Concatenating
  // chunks and passing the whole through `parseMarkerOutput` yields a unified
  // Source text whose structureMap still indexes the original pages.
  markdown: string;
}

export interface SectionedPdfExtractor {
  extract(pdfPath: string, opts: ExtractOptions): Promise<MarkerChunk[]>;
}

export class FakeSectionedPdfExtractor implements SectionedPdfExtractor {
  readonly calls: Array<{ pdfPath: string; target: ExtractionTarget }> = [];

  constructor(private readonly chunks: MarkerChunk[]) {}

  async extract(pdfPath: string, opts: ExtractOptions): Promise<MarkerChunk[]> {
    this.calls.push({ pdfPath, target: opts.target });
    return this.chunks.map((c) => ({ ...c }));
  }
}
