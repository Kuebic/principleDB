// ingestLargeBookSource — the large-book branch of the ingest pipeline (issue #9).
//
// For books Marker can't extract as a single file — Unification Thought OOMs even the
// 20 GB A4500, others lack bookmarks — the zettle pipeline splits the PDF into per-
// section chunks (`--split-level N`), runs Marker per chunk, and emits each chunk's
// markdown with the original-PDF page anchors preserved. principleDB ingests that
// sectioned output through this orchestrator:
//
//   1. Read the PDF into R2 (the blob lake remains ground truth).
//   2. Extract → MarkerChunks via the SectionedPdfExtractor port.
//   3. Normalize section boundaries — strip leaked tails that reappear at the next
//      chunk's head so each paragraph lands in exactly one chunk's view of the world.
//   4. Route each chunk front/body/back so reading order is recoverable.
//   5. Concatenate cleaned chunks into ONE unified Source.text whose structureMap
//      still indexes original-PDF pages (the splitter never renumbers anchors).
//   6. Distil PER CHUNK — each call's title carries the section label so the model
//      has section context; chunk text is the unit (ADR-0010, not page-at-a-time).
//   7. Admit + embed + dedup + persist via the shared `ingestDistilledItems` tail,
//      which relocates every quote against the unified Source.text.
//
// TOC-bookmark addition for bookmark-less books happens upstream of this orchestrator
// (see `preparePdfBookmarks` in toc-bookmark-plan.ts) so the review checkpoint lives
// strictly before extraction.

import { readFile } from 'node:fs/promises';
import type { BlobStore } from './blob-store';
import { normalizeSectionBoundaries, type BoundaryAction } from './boundary-normalize';
import { routeSectionPositions, type SectionPosition } from './front-back-matter';
import { ingestDistilledItems, type IngestResult } from './ingest';
import { parseMarkerOutput, type ExtractionTarget } from './marker';
import type { SectionedPdfExtractor } from './marker-sections';
import { r2KeyForPdfSource } from './pdf-ingest';
import type { CanonRepository, IngestProvider } from './ports';
import type { DistilledItem, Source, SourceKind } from './types';

export interface LargeBookSourceMeta {
  id: string;
  title: string;
  author: string;
  date: string;
  kind?: SourceKind;
}

export interface IngestLargeBookDeps {
  sectionedExtractor: SectionedPdfExtractor;
  blobs: BlobStore;
  provider: IngestProvider;
  repository: CanonRepository;
}

export interface IngestLargeBookOptions {
  target?: ExtractionTarget;
  readPdf?: (path: string) => Promise<Uint8Array>;
}

export interface IngestedChunkInfo {
  index: number;
  sectionLabel: string;
  startPage: number;
  position: SectionPosition;
}

export interface IngestLargeBookResult extends IngestResult {
  chunks: IngestedChunkInfo[];
  boundaryActions: BoundaryAction[];
}

export async function ingestLargeBookSource(
  pdfPath: string,
  meta: LargeBookSourceMeta,
  deps: IngestLargeBookDeps,
  options: IngestLargeBookOptions = {},
): Promise<IngestLargeBookResult> {
  const { sectionedExtractor, blobs, provider, repository } = deps;
  const target = options.target ?? 'cpu';
  const read =
    options.readPdf ?? ((p: string) => readFile(p).then((buf) => new Uint8Array(buf)));

  const pdfBytes = await read(pdfPath);
  const r2Key = r2KeyForPdfSource(meta.id);
  await blobs.put(r2Key, pdfBytes);

  const rawChunks = await sectionedExtractor.extract(pdfPath, { target });
  const { chunks: cleanedChunks, actions: boundaryActions } =
    normalizeSectionBoundaries(rawChunks);
  const positioned = routeSectionPositions(cleanedChunks);

  // Join with '\n' — Marker's page anchors are line-anchored, so a single newline
  // between two chunks places the next anchor on its own line where
  // `parseMarkerOutput` will recognize it. parseMarkerOutput then collapses the
  // separators back out, leaving a unified Source text whose offsets the unified
  // structureMap indexes by original-PDF page number.
  const unifiedMarkdown = cleanedChunks.map((c) => c.markdown).join('\n');
  const { text, structureMap } = parseMarkerOutput(unifiedMarkdown);

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

  const items: DistilledItem[] = [];
  for (const chunk of positioned) {
    const chunkItems = await provider.distil({
      title: `${meta.title} — ${chunk.sectionLabel}`,
      text: chunk.markdown,
    });
    items.push(...chunkItems);
  }

  const tail = await ingestDistilledItems(source, items, { provider, repository });

  return {
    ...tail,
    chunks: positioned.map((c) => ({
      index: c.index,
      sectionLabel: c.sectionLabel,
      startPage: c.startPage,
      position: c.position,
    })),
    boundaryActions,
  };
}
