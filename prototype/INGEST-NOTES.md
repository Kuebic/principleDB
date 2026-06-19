# Book-ingest spike verdict

**Question:** Can a REAL book go through CONTEXT.md's two book ingest branches — born-digital
PDF (extract→distil) and scanned image (OCR→distil) — and still feed the proven distiller
faithfully? This was the last unknown before slicing; spike 1 only ran on clean markdown.

Run: 2026-06-17. tesseract 5.5 + poppler. gpt-4o distil (same `DISTILL_SYSTEM` as spike 1).
- **Born-digital book** — *The Purpose-Driven Life* (Rick Warren), pp 38–43, `pdftotext`.
- **Controlled OCR** — the SAME PDL pages rasterized @300dpi → tesseract (measures fidelity).
- **Genuinely scanned book** — *365 Tao: Daily Meditations* (Internet Archive image scan, no
  text layer), pp 60–65 → tesseract, end-to-end.

## Findings

| branch | Principles | page-locator | exact | +normalized | +alnum |
|---|---|---|---|---|---|
| PDL born-digital | 74 (12.3/pg) | **100%** | 12% | 85% | 89% |
| PDL same-pages OCR | 75 (12.5/pg) | **100%** | 15% | 72% | 76% |
| Tao scanned book | 53 (8.8/pg) | **100%** | 6% | 91% | 96% |

- **Page locators — SOLVED. 100% everywhere.** Distilling page-by-page and stamping the page
  number structurally (not asking the LLM to guess it) carries a locator to every Principle.
  CONTEXT's "the locator is the page" just works. No slice risk here.
- **OCR fidelity — HIGH. 97.7% mean** char-similarity (tesseract vs born-digital ground truth
  on the same 6 pages). The genuine Tao scan OCR'd even cleaner (96% word-level quote survival).
  CONTEXT's scanned branch is viable. Quality is **book-dependent** (font, scan, page size):
  PDL's small Mac-typeset pages OCR'd worse (76%) than the Internet-Archive Tao scan (96%).
- **THE load-bearing finding — an LLM does not return byte-exact quotes, and that is fine IF
  you relocate.** "Verbatim quote" survival is only **6–15% as an exact byte match** even on
  born-digital text — but **85–96% once normalized** (fold curly quotes/dashes/ligatures,
  collapse whitespace, de-hyphenate). The model silently straightens `“ ”` → `"` and rewraps
  whitespace. **Conclusion: never store the LLM's quote string as the evidence.** The pipeline
  must *re-locate* each returned quote against the Source and **snap to the real source span**
  (store char offsets), then treat any quote it *can't* locate as a low-confidence/Drift item.
- **The residual non-matches decompose into two causes — and neither kills the thesis:**
  1. **Reading-order (extraction), not drift.** PDL's `Death is not your termination, but your
     transition into eternity.` failed even `alnum` because it's a decorative **pull-quote** the
     body text wraps around — `pdftotext` (even `-layout`) interleaves the two text streams, so
     the sentence isn't contiguous on the page. Captions/pull-quotes/multi-column = a known edge.
  2. **OCR noise.** Same-page survival drops 89%→76% (digital→OCR): line-wrap hyphenation,
     ligatures, marginal scan speckles (`\ When old`, `b Trail`). Normalization recovers most.
- **This is GOOD news for ADR-0003.** The "calibrated confidence/risk signal" that ADR calls
  load-bearing has an obvious concrete implementation: **quote-locatability.** A quote that snaps
  cleanly = high-confidence, flows through sampled. A quote that won't locate (pull-quote
  fragment, OCR garble, real rewording) = exactly the Drift candidate Review should surface. The
  gate matters *more* on the OCR branch, where the unlocatable rate is higher.
- **Over-extraction surfaced.** Book prose yields ~12 Principles/page vs ~2.3/page for sermons —
  the distiller is finer-grained on dense text. Merge (spike 1's open question) will carry more
  load on books; or cap granularity. Feeds slice 4.

## Feeds the slices

- **Extraction slice:** page-at-a-time extraction, page = locator (proven). Use `pdftotext`
  for born-digital, `pdftoppm @300dpi → tesseract --psm 1` for scanned. Add a normalization
  pass: de-hyphenate line wraps, fold curly quotes/dashes/ligatures, collapse whitespace.
- **NEW required slice — quote relocation + verification.** After distil, fuzzy-locate each
  quote in the Source (normalized, whitespace/newline-insensitive, spanning line breaks), store
  the snapped char-offset span as the evidence, and emit a `located: bool` + match-tier signal.
  This is the confidence signal ADR-0003 needs — not a nice-to-have.
- **Review slice:** unlocatable quotes are the triage queue. Pull-quote/caption fragments and
  OCR garble will be the bulk of low-confidence items; budget for them.
- **Open:** layout-aware extraction for pull-quotes/columns (lower priority — caught by Review).
  Confirm merge/granularity behaviour on book-density input before locking slice 4's threshold.

## Verdict

- [x] **Both book branches hold. Real books ingest faithfully with 100% page locators and high
  OCR fidelity. Proceed to slice — carrying the NEW quote-relocation/verification step (the
  ADR-0003 confidence signal) and the normalization pass into the extraction + review slices.**
- [ ] Open follow-up (optional): layout-aware extraction; merge behaviour on book-density text.
