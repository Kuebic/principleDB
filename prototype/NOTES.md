# Prototype verdict

**Question:** Does atomic-Principle distillation + sharp embeddings beat blob-RAG on real
teachings, and what merge threshold / evolution-detection actually works?

Run: 5 zettlemd sermons → **28 atomic Principles** (gpt-4o distill, text-embedding-3-small),
in-memory brute-force cosine. 2026-06-17.

## Findings

- **Retrieval vs Open Brain — THESIS HOLDS.** `grace and obedience` (Open Brain: *"No
  thoughts found"*) → principleDB returns *"Grace is not a divine eraser but support for
  future actions"* + quote. `what is sin` 0.556, `every member is a minister` 0.811,
  `how does repentance work` 0.655 — all rank the right Principle on top. Atomic beats blob.
- **Distillation quality — good.** Principles are atomic, faithful, single-claim, each with
  a verbatim quote + source + section locator. The `DISTILL_SYSTEM` prompt is close to right.
- **Merge — vector-on-claim has POOR RECALL (12 sermons, 81 atoms).** Sweep: 2 merges @0.72,
  1 @0.76, 0 @≥0.80. The 2 that fired were genuinely correct (same idea across sermons), so
  *precision* is fine. But many true restatements (outreach cluster: "every member is a
  minister" ≈ "the empty seat is the assignment" ≈ "cross the room") never clear 0.72 because
  the canonical claims are worded too differently for cosine. Raising threshold → ~no merges;
  lowering → risks false merges. **Conclusion: a single vector threshold is the wrong
  mechanism.** Two viable fixes — (a) vector prefilter @ low threshold + an LLM "same claim?"
  confirm to recover recall; or (b) merge only near-duplicates and let the connection engine
  RELATE the rest live at query time (don't over-collapse — preserves each framing's nuance).
- **Evolution detection — works.** devotion→grace → `tempers` (not `contradicts`), with a
  correct one-line rationale. The hard case the whole evolution model needs is reliable here.

## Bugs / tuning surfaced (feed into slices)

- Slice 3 (distill prompt): one `locator_hint` came back as literal `SOURCE TITLE` — the
  model grabbed the input label. Fix: don't label the title that way / constrain locator_hint
  to a section heading.
- Slice 4 (merge): threshold needs empirical tuning on overlapping sources; consider an
  LLM "same claim?" confirm above the vector prefilter.
- Embedding model: scores modest (0.4–0.8); ranking is correct, but test embedding
  claim+quote together, or a stronger embed model, before locking the choice.

## Verdict

- [x] **Thesis holds — atomic distillation + embeddings beats blob-RAG. Proceed to publish
  build issues, carrying the three tuning notes above into slices 3/4 and the embedding choice.**
- [ ] Open follow-up (optional): a cross-source merge test before finalizing slice 4's threshold.
