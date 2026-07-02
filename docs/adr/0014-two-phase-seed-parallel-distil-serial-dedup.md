# 14. Two-phase seed: parallel Canon-independent distil, serial Canon-dependent dedup

Date: 2026-07-01

## Status

Proposed. Refines ADR-0013 (dedup throughput) on the axis it left untouched:
distillation *seriality*. Preserves ADR-0008 (same provenance → same rows;
first-Source-wins), ADR-0012 (every merge LLM-confirmed), and ADR-0006 (no
rubber-stamp gate) unchanged — it changes *when* distil runs, not *what* is
distilled or *what* merges.

## Context

ADR-0013 removed the dedup *confirm* wall (parallel confirms + Haiku): the #25
validation spike measured **873 confirms/min with zero 429s at P=32**, versus
~5/min serial Opus. But ADR-0013 rested on a premise the same spike then
falsified — line 21: *"Distillation is cheap; dedup is the wall."*

At 690k scale that premise does not hold. `bulkIngest` runs Sources **serially**
(distil → admit → embed → dedup → persist, one Source at a time), and with
confirms now fast the dominant cost is the **serial per-doc distil LLM call**:
~13k docs × tens of seconds each ≈ **~9 days of wall-clock in distil alone**.
The confirm-only floor is ~2 days; the measured end-to-end @P=8 was ~14 days.
Distil is now the wall. ADR-0013 never attacked it because, when written, it
believed distil was free — so this is a lever 0013 *declined to consider*, not
one it rejected.

The Owner's design concern for this slice: *"If we're looking for dedups, but
we're ingesting multiple documents at once, how do we handle that?"* Naively
"ingesting multiple documents at once" would race the Canon — two docs deduped
concurrently could each miss the other's Principles, or merge in
completion-order rather than Source-order, destroying ADR-0008 reproducibility.
That race is real and must not be introduced.

The insight that dissolves the concern, verified against the code:

- `provider.distil({title, text})` reads **only the Source text**
  (`anthropic-provider.ts` `distil`). It never touches the Canon.
- `admit(source, items, provenance)` is a **pure function** — relocation +
  admission gate, no repository read (`admission.ts`).
- `provider.embed(claims)` reads **only the claims** (`anthropic-provider.ts`
  `embed`).
- **Only `dedup()`** queries the Canon
  (`findSimilarPrinciplesExcludingSource`, `dedup.ts`), and **only
  `replacePrinciplesForSource`** writes it (`ingest.ts`).

So the expensive, serial part (distil) is entirely Canon-**independent**, and the
order-sensitive part (dedup) is the only Canon-**dependent** part. They can be
split.

## Decision

Split the one-time seed into two phases at the Canon-independence seam — the
embed→dedup boundary inside `ingestDistilledItems` (`ingest.ts`).

**Phase A — parallel, Canon-independent (distil + admit + embed → stage).**

For every planned doc: distil → admit → embed, and write the admitted,
embedded Principles + Review candidates + **provenance** to a **staging store**,
then mark progress. No Canon read, no Canon write. Run it under a **bounded
parallel pool on Haiku, P ≈ 30** (the subscription `CLAUDE_CODE_OAUTH_TOKEN` is
Haiku-only over the API; the #25 spike found no 429 ceiling to P=32). The
existing normalized-text pre-pass (`seen_text`, issue #16) stays in the **serial
planning** step, ahead of the parallel fan-out, so its intra-batch `Set` is never
touched concurrently. Wall-clock: ~hours.

**Phase B — serial across Sources, parallel within a Source, Canon-dependent
(dedup → persist).**

In a **deterministic order**, for each staged Source: load its staged Principles
→ `dedup` (unchanged — vector prefilter + confirm pool per ADR-0013, still
parallel *within* the Source) against the Canon-so-far → `replacePrinciplesForSource`.
This is byte-identical to today's serial dedup: Phase B replays the exact same
inputs (distil output is frozen in staging; admit/embed are deterministic over
it) in the exact same order, deduping each Source against a stable Canon
snapshot. Wall-clock: ~2 days.

**A hard barrier between the phases.** Phase A completes for the whole corpus
before Phase B begins — two discrete CLI invocations, each independently
resumable. No in-memory producer/consumer: 690k × 1536-d vectors will not fit in
memory, and a crash mid-dedup must not lose the staged distil work.

Load-bearing details, each a guardrail:

- **Staging is Canon-invisible.** The staging store is a *separate* table the
  dedup query cannot see. If Phase A wrote un-deduped Principles into the live
  `principle` table, Phase B's `findSimilarPrinciplesExcludingSource` would
  return un-deduped siblings as candidates and first-Source-wins would break.
  Staging is keyed `(sourceId, provenance)`, mirroring the grain
  `replacePrinciplesForSource` already uses.
- **Phase-B order = the plan walk, not `sortBy(sourceId)`.** Today's
  first-Source-wins is fixed by `plan.jobs` order → `bulkIngest(plannedJobs)`
  (`ingest-dir.ts`), which is planJobs' sort and is not guaranteed identical to a
  raw sourceId sort. Phase B replays the plan walk (cheap, stat-only) to pin the
  same order, then loads each Source's staged rows. This is what earns ADR-0013's
  "provably equivalent" claim across the split.
- **Provenance travels in the staging payload.** IDs derive from
  `(sourceId, provenance)` (`admission.ts`). Phase B reconstructs
  `DistilProvenance` from the staged rows — not from a fresh provider config — so
  a Phase-B provider configured differently than Phase A cannot mint mismatched
  ID slots. `confirmModel` still comes from Phase B's provider, correctly, since
  it is deliberately *not* part of the provenance tuple (ADR-0013 lever 2).
- **Two-phase checkpointing needs no schema change.** `PostgresBulkProgressStore`
  already takes a `phase` constructor arg (the walker uses `'ingest:dir'`; the
  `bulk_progress` PK is `(phase, source_id)`, `schema.ts`). Phase A marks under
  `'ingest:dir:distil'`, Phase B under `'ingest:dir:dedup'`. Phase A writes the
  staging rows **and** its mark in one transaction, so no Source is ever
  half-staged; the mark — not the row count — distinguishes a distil *failure*
  (no mark, retry) from a legitimately **zero-Principle** doc (marked, empty
  payload). `replacePrinciplesForSource` idempotency (ADR-0008) makes a Phase-B
  crash between persist and mark safe to resume.

The exact staging **table shape** (a single `jsonb` payload row per Source vs. a
mirror of `principle`/`quote` with a real `vector` column) is an implementation
choice for the slice, not an architectural one. The ADR fixes only that a
separate, durable, Canon-invisible staging store exists and carries embeddings +
provenance.

## Considered Options

- **In-memory producer/consumer** (distil ahead in parallel, one ordered
  consumer dedups in plan order, no staging table) — rejected. Holding ~4GB of
  1536-d vectors ahead of a ~2-day consumer overflows memory, and a crash loses
  all staged distil (the whole corpus would re-distil). `bulkIngest` is designed
  around "possibly interrupted"; this option abandons that.
- **DB-pipelined** (Phase B starts deduping Source N the moment it is staged,
  Phase A races ahead) — rejected for this slice. The overlap it buys is distil
  (~hours) hidden inside dedup's (~2-day) window — a few percent — paid for with a
  stateful ordered consumer that polls staging for next-in-order. The clean
  barrier is simpler and the lost overlap is negligible for a one-time run.
- **Re-embed in Phase B instead of staging embeddings** — rejected. Staging is
  ~4GB of transient vectors either way in the "with embeddings" case, but
  re-embedding puts an API call and a failure mode inside the 2-day serial loop.
  Staging embeddings keeps Phase B a pure local-query + confirm loop. (embed is
  cheap and not the bottleneck; there is no throughput reason to move it into
  Phase B.)
- **JSONL-on-disk staging** — viable, lower-effort fallback, but machine-local
  and not resumable on a different host, and stores vectors as bulky JSON text.
  Preferred a Postgres staging store to compose with the existing durable stores
  (`seen_text`, `bulk_progress`).
- **Anthropic Message Batches API for Phase A** (50% cost, async ≤24h) — deferred.
  It fits 13k independent distil calls, but needs a paid API key; the subscription
  token reaches Haiku only over the API and batch support on it is unverified. A
  bounded Haiku pool at P≈30 clears Phase A in hours today. Revisit if a paid key
  is provisioned.
- **Decouple *dedup* into an offline batch pass** — remains rejected exactly as
  ADR-0013 rejected it (a second pipeline + a staleness window, no throughput
  win). This ADR decouples *distil*, which is Canon-independent and opens **no**
  staleness window because Phase A never reads the Canon. The distinction is the
  whole point: dedup stays inline and serial-across.

## Consequences

- Throughput: ~9-day serial distil → ~hours (Phase A, parallel) + ~2 days
  (Phase B, dedup) = **one unattended weekend**. Phase B's ~2.5–3.5M confirms
  @ 873/min is ~2–2.8 days at P=8; the seed should first spike Haiku's P_max
  (0 429s at 32, ceiling unknown) and raise `confirmConcurrency` — a knob, not new
  architecture. Early Sources dedup against a near-empty Canon (no confirm when
  `candidates.length === 0`), so 2.5M is a steady-state upper bound.
- One new durable staging store (Canon-invisible) and a two-mode driver
  (`--phase distil` / `--phase dedup`). `dedup.ts` is untouched; the #25
  confirm-prompt hardening (9ab121e) is called by Phase B verbatim.
- **No schema change for checkpointing** — the `(phase, source_id)` key and the
  parameterized `PostgresBulkProgressStore` already support two passes. A staging
  table is the only additive schema.
- The split is specific to the one-time bulk seed. The single-file ingest path
  (`ingestSource`) is unchanged — distil and dedup stay inline there, where
  seriality costs nothing.
- ADR-0008 (reproducibility; first-Source-wins via pinned plan order), ADR-0012
  (every merge LLM-confirmed — dedup logic unchanged), and ADR-0006 (no
  rubber-stamp) all hold. The Review queue and merge semantics are untouched.
