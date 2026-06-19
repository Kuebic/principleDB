# 7. Quotes are relocated Source spans; locatability is the confidence signal

Date: 2026-06-19

## Status

Accepted. Refines ADR-0003 (the confidence signal it called "load-bearing but abstract" now
has a concrete mechanism, and the LLM *self-assessment* in its decision is superseded).

## Context

ADR-0003 made ingest automated and Review risk-triaged, resting on a "calibrated
confidence/risk signal" it left abstract — and framed as each candidate carrying a
*self-assessment* (the model grading its own confidence). A book-ingest spike (2026-06-17,
`prototype/INGEST-NOTES.md`) measured what actually comes back from distillation across three
branches (born-digital PDF, controlled OCR, a genuinely scanned book) and surfaced the
load-bearing fact:

**An LLM does not return byte-exact quotes — and that is not a defect.** "Verbatim quote"
survival was only **6–15% as an exact byte match**, even on clean born-digital text, but
**85–96% once normalized** (fold curly quotes/dashes/ligatures, collapse whitespace,
de-hyphenate line wraps). The model silently straightens `" "` → `"` and rewraps whitespace.
The byte differences are typographic noise from extraction/OCR; the *words* survive. What we
care about is "are these the words that were taught?", not "which punctuation glyphs were
used?".

This kills two naive designs at once: storing the AI's quote string as the evidence (breaks
"jump to Source" ~85% of the time, and makes "verbatim" a lie), and trusting an LLM
self-confidence score (subjective and uncalibrated, when an objective check is available).

## Decision

**Quotes are stored as relocated Source spans, not the AI's reproduction.** After distillation,
each returned quote is a *search query*: fuzzy-match it back into the Source (normalized,
whitespace/newline-insensitive, spanning line breaks), snap to the real Source span, and store
the **char-offset span (→ page)**. The displayed quote is always read off the Source at those
offsets — so it carries the Source's own words *and* a precise jump-to-spot. The AI's string is
discarded once it has served as the query. Normalization is used only to *locate*, never to
store.

**Locatability is the confidence signal** (replacing ADR-0003's self-assessment). The match
tier — exact / normalized / alnum / no-match — is objective and is the triage input: a quote
that snaps cleanly is high-confidence (flows through, sampled); a quote that won't locate is
exactly the Drift candidate Review must surface. The gate matters *more* on the OCR branch,
where the unlocatable rate is higher.

**Admission rule (the gate).** Every Principle arrives *with* a quote (the distiller emits
`{claim, quote}` as a pair). The gate keys on whether that quote **relocates**, not on its
presence. A Principle whose only quote is no-match is **held in Review** — not silently
admitted (it could be invention), not auto-dropped (it could be rescuable OCR garble or a
non-contiguous pull-quote). A human confirms the words are genuinely in the Source, or rejects
it. **Invariant: a Principle cannot be persisted to the Canon with zero relocating Quotes.**
The Review queue is the staging area for everything below that bar.

A failed relocation has three causes, and only one is a faithfulness problem — which is *why*
it needs a human, since they look identical mechanically: (1) OCR garble (words right, scan
mangled — rescuable); (2) non-contiguous fragment (pull-quote/multi-column — real words,
reading-order artifact); (3) genuine rewording/invention — actual Drift.

## Considered Options

- **Store the AI's returned quote string as the evidence** — simplest, but the stored
  "verbatim" diverges from the Source ~85% of the time and "jump to Source" lands nowhere.
  Rejected: it makes the evidence layer untrustworthy.
- **Trust an LLM confidence self-assessment** (ADR-0003 as written) — no extra pipeline step,
  but subjective and uncalibrated, and discards the objective signal sitting right there.
  Rejected in favour of mechanical locatability.
- **Relocate to a Source span, locatability as the signal** (chosen) — one extra pipeline
  stage (normalize + relocate + verify), but yields trustworthy evidence, a free jump-to-spot,
  and an objective triage signal.

## Consequences

- Two new required pipeline stages between distill and store: a **normalization pass**
  (de-hyphenate, fold curly quotes/dashes/ligatures, collapse whitespace) and a **relocation +
  verification** stage that snaps each quote to a Source span, stores the char-offset span, and
  emits `located: bool` + match-tier.
- The schema's Quote is a `(sourceId, char-offset span)` pointer, not a stored string; the
  page (or page **range**) is *derived* from the matched offset, not a primary key. The CONTEXT
  glossary entry for **Quote** is updated to match.
- **Relocation matches against the Source's continuous text, not an isolated page.** A Quote
  whose span crosses a page break (…bottom of p42 / top of p43…) therefore still locates, and
  its page locator comes out as a range — "spans a break" stops being a special case. (This is
  why extraction supplies neighbouring-page context for *comprehension* while still extracting
  and stamping per focal page — see ADR-0009.)
- ADR-0003's Review triage gets a concrete input (locatability) and its self-assessment
  mechanism is retired. Page locators and OCR quality drop off the risk list (locators were
  100% by stamping the page structurally; poor OCR simply produces more no-match → more Review,
  self-adapting).
- Layout-aware extraction (pull-quotes, multi-column) — **resolved by ADR-0010**: the production
  extractor (Marker) corrects reading order, so these no longer rely on Review to catch.
