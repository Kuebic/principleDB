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
import { ingestSource, type IngestResult } from './ingest';
import { parseMarkerOutput, type ExtractionTarget, type PdfExtractor } from './marker';
import type { BlobStore } from './blob-store';
import type { CanonRepository, IngestProvider } from './ports';
import type { Source, SourceKind } from './types';

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

  return ingestSource(source, { provider, repository });
}
