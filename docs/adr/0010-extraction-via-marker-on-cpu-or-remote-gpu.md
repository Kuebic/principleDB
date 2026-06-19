# 10. PDF/scanned extraction via Marker, on CPU or a remote GPU (reused from the zettle vault)

Date: 2026-06-19

## Status

Accepted. Supersedes the spike's `pdftotext`/`tesseract` extraction assumption; refines ADR-0009
(the extraction *unit*) and resolves the layout-aware-extraction follow-up deferred in ADR-0007
and ADR-0009.

## Context

The book-ingest spike used `pdftotext` (born-digital) and `pdftoppm @300dpi → tesseract`
(scanned) as a **minimal fidelity check** — enough to prove quotes survive and locators hold,
not a production extractor. The real target corpus is harder: footnote-dense theological books
with multi-column layout, pull-quotes, and scanned archives — e.g. **Cheon Seong Gyeong (CSG)**,
**World Scripture**, **Unification Thought (~640 pages)**, and the scanned **365-Tao**. The
spike already saw the failure mode tesseract/`pdftotext` can't fix: a pull-quote that `pdftotext`
interleaved out of reading order (the "Death is not your termination…" case).

The owner has **already built and battle-tested a production extraction pipeline** for exactly
this corpus, in the zettle vault (its ADR-0019). Reusing it is far cheaper and lower-risk than
re-deriving one here.

That pipeline:
- **Engine: [Marker](https://github.com/datalab-to/marker)** (Surya OCR + ML layout) — strong on
  book prose, footnotes, blockquotes; handles **both** native and scanned PDFs in one engine.
  Docling was tried and rejected (flattens em-dashes/smart quotes, promotes pull-quotes to
  spurious headings, duplicates sentences at column/page boundaries); kept only as a fast-preview
  alternate. Hosted OCR APIs rejected (paid; data leaves the box).
- **Execution: CPU or a remote GPU.** Marker's Surya encoder OOMs small cards; runs on CPU
  (~42 min/63pg) or on a **remote 20 GB NVIDIA GPU (the A4500), a LAN Proxmox box**, via
  `ingest_remote.sh` (rsync the PDF + script over, run under CUDA — the `uv run --no-sources`
  trick swaps the ROCm wheels for CUDA — rsync `extracted/` back).
- **Two-stage**: stage 1 mechanical (PDF → cleaned markdown, bookmark-split), stage 2 semantic
  (AI cleanup). This maps directly onto principleDB's **extract → distil** split.

## Decision

**Adopt the zettle Marker pipeline as principleDB's extraction stage**, reusing `ingest_pdf.py` +
`ingest_remote.sh` rather than re-implementing.

- **Engine = Marker** (Surya OCR + ML layout), one engine for native and scanned Sources. tesseract
  is retired from the design (it remains only the spike's historical fidelity check).
- **Execution = CPU for small/text Sources; the remote A4500 for hard/large books.** The A4500 is
  therefore a v1 operational dependency for the hard corpus (the box must be reachable to ingest
  those books); text and small PDFs stay CPU-only.
- **Marker's cleaned markdown is the relocation substrate** — it *is* the "Source's continuous
  text" of ADR-0007. Quotes relocate against it; `located`/`matchTier` are computed against it.
  Marker's `#page-N` anchors populate the **structureMap** (offset → page) of ADR-0009. The
  **original PDF goes to R2** (blob lake) as ground truth and the jump-to-original target.
- **Extraction unit = the Marker bookmark-section chunk** (a coherent section/chapter), distilled
  as a unit. This **supersedes ADR-0009's page-at-a-time + neighbour-page-context mechanism**: a
  Marker section *is* the comprehension context, so cross-page severing (ADR-0009 mode 1) is
  resolved structurally. ADR-0009's locator model stands unchanged — identity is the offset span,
  the page label is *derived* from Marker's anchors (a page range when a span crosses a break,
  ADR-0007).
- **Layout-aware extraction is resolved** (Marker handles pull-quotes / multi-column / reading
  order), closing the open follow-up in ADR-0007 and ADR-0009.
- **Large-book machinery is reused as a follow-up slice**: bookmark-driven splitting
  (`--split-level`), TOC-bookmark addition for bookmark-less books (UT can't extract as one file —
  OOMs even the 20 GB card), the cross-file section-boundary normalizer, and front/back-matter
  routing. All exist in the zettle pipeline.

## Considered Options

- **Keep the spike's `pdftotext`/`tesseract` path** — no GPU, simplest, but degrades on exactly the
  footnote-heavy/multi-column/scanned books that are the target corpus (CSG, World Scripture, UT,
  Tao). Rejected for production extraction.
- **Docling (IBM)** — CPU-friendly and fast on GPU, but flattens typography, invents headings, and
  duplicates at boundaries (zettle's head-to-head). Rejected; retained as a fast-preview alternate.
- **Hosted OCR API (Mistral OCR, LlamaParse)** — highest quality, but paid and the corpus leaves the
  owner's hardware. Rejected per the self-host/local constraint.
- **Relocate against raw `pdftotext` output instead of Marker's markdown** — worse substrate: raw
  extraction has the broken reading order Marker fixes, so quotes from pull-quotes/columns wouldn't
  locate. Rejected.

## Consequences

- The extraction stage is a **reused, proven pipeline**, not new code — but it adds runtime
  dependencies: Marker (PyTorch + Surya, ~5 GB) and, for big books, the remote A4500 box (SSH,
  CUDA 12.x, `uv`). Small/text Sources avoid all of this (CPU).
- **"Verbatim from the Source" = verbatim from Marker's extracted text.** The raw PDF in R2 is the
  ultimate ground truth and the jump-to-original-page target.
- The distillation unit is the Marker section chunk; ADR-0009's page-at-a-time mechanism is
  superseded, its locator model preserved.
- **Slices reworked:** the digital-PDF and scanned-OCR slices **merge** into one Marker extraction
  slice; a **follow-up slice** carries splitting / TOC-bookmark addition / boundary normalization
  for large books.
- The A4500 becomes load-bearing for the hard corpus — a deliberate, recorded operational
  dependency, isolated to the books that need it.
