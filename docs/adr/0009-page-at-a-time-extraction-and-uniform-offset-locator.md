# 9. Page-at-a-time extraction with neighbour context; a uniform offset-span locator with a derived label

Date: 2026-06-19

## Status

Accepted. Builds on ADR-0007 (the char-offset span is already the Quote's identity; this
generalises it across Source types and settles the chunk-boundary edges). **Refined by ADR-0010:**
the extraction *unit* becomes the Marker bookmark-section chunk (not a raw page), which makes the
neighbour-page-context mechanism below moot — the section *is* the comprehension context. The
locator model here (offset-span identity + derived label) stands unchanged.

## Context

The book-ingest spike (`prototype/INGEST-NOTES.md`) distilled **a page at a time** and stamped
the page number structurally, yielding 100% page locators. Two edges were left open:

1. **Chunk boundaries.** Distilling each page in isolation can sever a teaching claim whose
   context spans pp 42→43 (the model sees only half), and a verbatim Quote whose span crosses
   the page break has no single page to stamp.
2. **Locator across Source types.** "Locator = the page" is obvious for PDFs, but a sermon
   transcript has no pages. The prototype modelled this with a polymorphic
   `Locator = { raw?, heading?, page? }` ([pipeline.ts](../../prototype/pipeline.ts)) — three
   optional fields every consumer must branch on, and the spike already mis-set it (a
   `locator_hint` came back as the literal Source title).

Neither blocks slicing, but both are cheap to settle now and avoid a brittle locator shape
leaking into the schema.

## Decision

**Extraction stays page-at-a-time, with neighbouring-page context for comprehension only.**
Each page is distilled and stamped as its own unit (preserving the spike's 100%-locator
result). The adjacent pages are supplied to the distiller as **read-only context so it
understands claims developed across a boundary**, but it extracts and quotes **only from the
focal page**. Output stays one-page-per-claim, one stamp — no cross-page dedup blow-up, no
ambiguous stamp.

**The locator has a uniform identity and a derived, per-type display label.**

- **Identity (uniform across all Source types):** the char-offset span into the Source's
  *continuous* text — the same key ADR-0007 already stores. PDFs, transcripts, and scanned
  books are all just text with offsets.
- **Display label (derived, varies by type):** computed from a per-Source **structure map**
  built at ingest — digital/scanned PDF → **page**; transcript with timecodes → **timestamp**;
  text with headings → **section heading**; unstructured text → a position fraction ("~40% in")
  or nothing. The label is presentation, not identity.

The Source-type ingest branch (text / digital PDF / scanned) therefore only decides **how the
offset→label map is built** — it does not create different locator *shapes*. The polymorphic
`Locator` is dropped.

Because relocation runs against the **continuous** Source text (ADR-0007), a Quote span that
crosses a page break still locates, and its label simply comes out as a **page range** — "spans
a break" is no longer a special case.

## Considered Options

- **Pure page-at-a-time, no neighbour context** — simplest, but accepts severed cross-page
  claims as silent misses (only some caught in Review). Rejected as needlessly lossy when
  neighbour-context is nearly free.
- **Sliding multi-page windows** — the model sees across breaks, but the same claim recurs in
  overlapping windows → dedup load explodes and the page-stamp goes ambiguous. Rejected: pays
  for comprehension by reopening what the spike solved.
- **Semantic chunking (by section/idea, not page)** — best at not severing ideas, but discards
  the clean structural "offset → page" guarantee and the 100%-locator result. Rejected.
- **Type-specific locator identities** (e.g. a sermon Principle keyed by heading) — rejected:
  headings are neither unique nor stable; offsets are, and a uniform identity keeps a single
  jump-to-spot mechanism.

## Consequences

- The distiller is fed a focal page plus its neighbours, with an instruction to extract and
  quote only from the focal page. A small prompt/pipeline detail in the extraction slice — not a
  new stage.
- The schema has **one** locator: a `(sourceId, char-offset span)` pointer (per ADR-0007). The
  human-readable label is computed on read from the Source's structure map; no optional
  `heading`/`page`/`raw` fields.
- Each Source carries a structure map (offset → page / heading / timestamp) produced at ingest,
  by branch: PDF extraction already knows page spans; transcript ingest captures timecodes;
  text ingest captures the heading outline.
- Layout-aware extraction (pull-quotes, multi-column) is **resolved by ADR-0010** (Marker), not an
  open follow-up.
