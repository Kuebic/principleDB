// Marker output parsing + the PdfExtractor port (ADR-0010).
//
// Marker (Surya OCR + ML layout) extracts both native and scanned PDFs in one
// engine. With `--paginate_output` it emits page separators of the form
// `{N}---...---` (N 0-indexed) on their own line. parseMarkerOutput strips
// those separators and emits a Source-shaped pair: the continuous clean text
// (the relocation substrate of ADR-0007) plus a pdf-pages structureMap
// (offset → 1-indexed page label, ADR-0009).
//
// The PdfExtractor port wraps Marker so the orchestrator stays agnostic of
// where it runs — CPU for small Sources, the remote A4500 (LAN Proxmox box)
// for hard/large books, per ADR-0010. A FakePdfExtractor keeps integration
// tests deterministic and offline.

import type { StructureMap } from './types';

export interface MarkerArtifact {
  markdown: string;
}

export type ExtractionTarget = 'cpu' | 'remote-gpu';

export interface ExtractOptions {
  target: ExtractionTarget;
}

export interface PdfExtractor {
  extract(pdfPath: string, opts: ExtractOptions): Promise<MarkerArtifact>;
}

export interface ParsedMarkerOutput {
  text: string;
  structureMap: Extract<StructureMap, { kind: 'pdf-pages' }>;
}

// Marker's per-page anchor line: `{N}---` (or longer dash run) on its own line, with
// N 0-indexed. Exported so boundary-normalize.ts recognizes anchors the same way the
// parser does — one definition, two consumers.
export const PAGE_ANCHOR_RE = /^\{(\d+)\}-+$/;

export function parseMarkerOutput(annotated: string): ParsedMarkerOutput {
  interface Section {
    page: number | null;
    lines: string[];
  }
  const sections: Section[] = [{ page: null, lines: [] }];

  for (const line of annotated.split('\n')) {
    const m = PAGE_ANCHOR_RE.exec(line);
    if (m) {
      sections.push({ page: Number(m[1]) + 1, lines: [] });
    } else {
      sections[sections.length - 1]!.lines.push(line);
    }
  }

  if (sections[0]!.page === null && sections[0]!.lines.every((l) => l.trim() === '')) {
    sections.shift();
  }

  const pages: { offset: number; page: number }[] = [];
  const parts: string[] = [];
  let offset = 0;
  for (const section of sections) {
    if (section.page !== null) pages.push({ offset, page: section.page });
    const chunk = section.lines.join('\n');
    parts.push(chunk);
    offset += chunk.length + 1; // +1 for the joining '\n' between sections
  }
  return { text: parts.join('\n'), structureMap: { kind: 'pdf-pages', pages } };
}

// Deterministic extractor for tests: returns a scripted markdown and records
// each call so a test can assert the target was forwarded correctly.
export class FakePdfExtractor implements PdfExtractor {
  readonly calls: Array<{ pdfPath: string; target: ExtractionTarget }> = [];

  constructor(private readonly markdown: string) {}

  async extract(pdfPath: string, opts: ExtractOptions): Promise<MarkerArtifact> {
    this.calls.push({ pdfPath, target: opts.target });
    return { markdown: this.markdown };
  }
}
