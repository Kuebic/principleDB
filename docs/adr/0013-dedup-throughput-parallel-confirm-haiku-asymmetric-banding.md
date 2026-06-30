# 13. Dedup throughput: parallel confirm, Haiku confirm model, asymmetric auto-keep banding

Date: 2026-06-30

## Status

Proposed — pending the validation spike in this ADR. Refines ADR-0012
(conservative dedup) on the operational axis only: it changes *how fast* and
*how cheaply* dedup runs, not *what merges*. The conservative-merge guarantee of
ADR-0012 and the no-rubber-stamp guarantee of ADR-0006 are preserved unchanged.

## Context

ADR-0012 landed conservative cross-Source dedup: for each newly-admitted
Principle, a vector prefilter (`DEFAULT_DEDUP_THRESHOLD = 0.4`, top-`K = 5`)
fetches candidates, then `IngestProvider.confirmSameClaim` (an LLM call) decides
each pair, first `same: true` wins and stops the walk. The validation run behind
issue #17 measured the cost: ~159 Principles from 3 canon files drove **~800
serial LLM round-trips**, ~10 min/doc, ~5 Principles/min. The ~13k-doc doctrinal
core (≈690k Principles at the measured ~53/doc) extrapolates to **~90 days**.
Distillation is cheap; **dedup is the wall.**

The handoff for this design session framed the enemy as `O(N)` scaling and asked
whether clustering or a decoupled offline pass could make dedup *not* `O(N)`.
Reading the code refutes that framing:

- The candidate loop **breaks on first confirmed merge** (`src/canon/dedup.ts`),
  and `topK = 5` hard-caps candidates per Principle. So confirm calls per
  Principle are bounded at **≤5 regardless of Canon size** — the ~800/159 ≈ 5
  ratio shows the cap is already saturated. Total confirms ≈ `5·N`: **linear in
  N, with a fat constant**, not super-linear.
- The expensive part is not asymptotic. It is three multiplicative constants:
  the confirm runs on **`claude-opus-4-8`** (the distil model;
  `confirmSameClaim` and `distil` share one model setting in
  `AnthropicIngestProvider`), every call is **serial** (`bulkIngest` loops
  sources serially; `dedup` loops Principles *and* candidates serially — zero
  concurrency anywhere), and the corpus is large.
- Candidate *finding* is already sublinear — `findSimilarPrinciplesExcludingSource`
  is a pgvector ANN query over real 1536-d OpenAI `text-embedding-3-small`
  vectors (ADR-0011). Clustering would attack the part that is already cheap.

So the cost is `~5 × Opus × serial × N`. Every factor is a constant or an
execution-shape knob; none is algorithmic complexity. The stored-cluster /
GraphRAG approach was already rejected by ADR-0012 (the stored-intermediate
invalidates on every insert) and offers no asymptotic gain here. We therefore
attack the constants and the seriality, not the complexity class.

A unifying asymmetry governs every quality-sensitive choice below: **an error in
the keep-separate direction is free** — a stray near-duplicate is exactly the
failure mode ADR-0012 *prefers* ("two principles that genuinely overlap over
collapsing a distinct framing"), and live relatedness stacks them at query time.
**An error in the merge direction is costly** — a false merge destroys a
distinct teaching. Every optimization below is allowed to be loose toward
keep-separate and is held strict toward merge.

## Decision

A layered, safe-first plan. Levers 1–2 carry the target with no quality risk;
lever 3 is an optional accelerator that only ever automates the *safe* direction.

**1. Parallelize confirms across Principles within a Source; keep Sources
serial.**

- *Within a Source: parallel.* The pipeline persists only *after* the whole
  dedup loop (`ingestDistilledItems`), so the Canon is never mutated mid-loop —
  every Principle queries the same stable Canon snapshot whether serial or
  parallel, and same-Source Principles are already excluded from each other's
  candidate set. Parallelizing across Principles is therefore *structurally
  equivalent* to the serial loop, not merely close. Use a bounded concurrency
  pool with exponential backoff on HTTP 429.
- *Across Sources: serial.* Each Source's dedup must see a stable Canon snapshot
  to preserve ADR-0008's "same provenance → same rows" reproducibility. Parallel
  Sources would read the Canon while a sibling Source writes it. `bulkIngest`
  stays a serial, checkpointed loop. Serial-across / parallel-within clears the
  target without spending the guarantee.
- *Within one Principle's candidate walk: no fan-out.* Keep the serial
  `break`-on-first-`same` short-circuit; it is cheaper than firing 5 confirms
  and discarding 4. Parallelism lives across Principles, where no call is wasted.

**Prerequisite (idempotency hazard).** Decision-row IDs are currently minted
from a shared `decisionIdx++` counter. Under parallel completion the completion
order varies, so the IDs would vary, so a re-ingest would write *different* rows
— breaking ADR-0008 idempotency. The fix is mechanical and is a hard
prerequisite of this lever: make decision IDs index-based
(`d${principleIdx}_${candidateIdx}`), mirroring the already-safe `aq${idx}`
attached-quote IDs.

**2. Decouple the confirm model from the distil model; default confirm to
Haiku.**

`confirmSameClaim` is a narrow binary judgment with a 512-token output cap —
Haiku's wheelhouse — while distil is generative and quality-critical. They
should not share one model setting.

- Add a separate `confirmModel`, default `claude-haiku-4-5`; distil stays on
  `claude-opus-4-8`. Both pinnable per instance (ADR-0008 BYO, ADR-0011
  provider-agnostic), with Opus as the config fallback.
- The confirm model is **not** part of the `(distilModel, …)` provenance tuple —
  it changes the merge decision, not what was said. Record `confirmModel` on the
  `dedup_decision` row for audit symmetry (small schema add).
- This also widens the rate-limit headroom that bounds lever 1 (Opus 429s were
  observed during seeding; Haiku has more TPM).

**3. (Optional) Asymmetric banding — auto-decide only the keep-separate
direction.**

If the spike shows a clean low-cosine floor, skip the LLM confirm for candidates
below it and auto-keep-separate. **Every actual merge still goes through an LLM
confirm.** Banding never auto-merges.

- This is *not* ADR-0012's rejected "threshold alone": that was rejected because
  cosine over/under-*merges*. Banding here never merges on cosine; it only
  declines to confirm obvious non-matches. The objection does not apply.
- It needs **no** human-review path, so ADR-0006's no-rubber-stamp guarantee is
  untouched. We do **not** route merges to the Review queue in this slice; the
  Review queue stays admission-only (ADR-0007).
- Ship it only if the spike finds a floor `c*` below which merge-rate ≈ 0 with
  meaningful confirm volume beneath it. If the tail is muddy, drop the lever —
  parallelism + Haiku already carry the target, and there is no quality cost to
  omitting it.

## Validation / acceptance gate

The Canon was wiped at the end of the prior session, so there is no labeled
data. One read-only spike over the clean `Moon-Books/Genesis` text corpus
produces throughput numbers *and* the `dedup_decision` rows that serve as the
labeled set for the model and band evaluations. **The full 690k run is gated on
this spike.**

Three empirical bets (acceptance criteria are merge-direction-strict):

1. **Haiku confirms safely (highest priority).** Re-confirm the spike's pairs
   with Opus as reference; human-adjudicate only the disagreements.
   *Pass: false-merge rate ≈ 0* (Haiku `same` where Opus/human says distinct).
   Overall agreement is secondary; Haiku erring toward keep-separate is
   tolerable. *Fail → keep Opus for confirm, or confirm only high-cosine pairs
   on Opus and let Haiku take the low-ambiguity rest.*

2. **Parallelism clears the target.** Measure Principles/min at pool size `P`
   with 429 backoff; find `P_max` before sustained 429s on the OAuth token.
   *Pass: extrapolated 690k time ≤ the agreed target (~one unattended weekend).*
   *Fail → banding (bet 3) stops being optional.*

3. **A clean band floor exists (conditional on bet 2).** Bin the rows by cosine;
   plot merge-rate per bin. *Pass: a `c*` exists below which merge-rate ≈ 0 with
   enough confirm volume beneath it to matter.* *Fail → do not ship banding.*

Two mechanical guarantees, locked by deterministic tests through
`FakeIngestProvider` + `InMemoryRepository` (no models, no corpus). These ship
with the parallelism change as its regression net:

- **Parallel ≡ serial, structurally.** Scripted verdicts → the parallel dedup's
  `{freshPrinciples, attachedQuotes, decisions}` is byte-identical to the serial
  output. This is the test that earns the word "equivalent."
- **Idempotency survives concurrency.** With index-based decision IDs, re-ingest
  the same Source twice → identical decision rows, IDs, and counts. The ADR-0008
  guard the `decisionIdx++` counter would have broken.
- **Backoff under 429.** A fake that throws 429 → bounded concurrency never
  exceeds the pool and the run still completes.

**Benchmark (the comparison harness):** confirms/doc · Principles/min · dedup
precision & recall vs the labeled sample · $/1k Principles. Seeded from the same
Genesis spike.

**Go gate for the 690k run:** Haiku false-merges ≈ 0 **and** measured throughput
≤ target.

## Considered Options

- **Stored clustering / GraphRAG over the Canon** — rejected by ADR-0012 (the
  stored intermediate invalidates on every insert) and offers no gain here:
  candidate finding is already sublinear via pgvector ANN.
- **Decouple dedup into an offline batch pass** — no asymptotic gain for the
  same reason; adds a second pipeline and a staleness window for no throughput
  win the hot-path levers don't already deliver.
- **Auto-merge banding (high-cosine band merges without an LLM confirm)** —
  rejected: a false auto-merge destroys a distinct teaching, violating the
  ADR-0012 conservative promise. Banding is restricted to the keep-separate
  direction only.
- **Route ambiguous merges to the Review queue** — rejected for this slice:
  ADR-0006 already rejected per-merge human approval as the rubber-stamp failure
  mode, and the safe-first levers hit the target without it. Reconsider only if
  post-banding confirm volume is still the wall.
- **Fan out a Principle's 5 candidate confirms in parallel** — rejected: wastes
  ~4 calls per merge versus the `break`-on-first-`same` short-circuit; cross-
  Principle parallelism captures the latency win without the waste.
- **Batch multiple candidate-pairs into one confirm call** — deferred: it
  changes the call shape and carries its own quality risk, and overlaps with
  banding (which removes most residual confirms). Not in this slice.

## Consequences

- Throughput: ~90 days → **~one unattended weekend** (levers 1–2, resumable via
  `bulkIngest` checkpointing) → **hours** if banding lands. Cost drops sharply as
  the bulk of confirms move from Opus to Haiku.
- `dedup` becomes concurrency-aware: a bounded pool, 429 backoff, and
  thread-safe accumulation of `{freshPrinciples, attachedQuotes, decisions}`.
  Decision IDs become index-based — a behavior change in the ID namespace, so a
  one-time re-ingest writes new IDs (counts unchanged).
- `IngestProvider` / `AnthropicIngestProvider` gain a `confirmModel` knob;
  `dedup_decision` gains a `confirmModel` column. The port stays
  provider-agnostic.
- The Review queue and the merge semantics are untouched. ADR-0012 (every merge
  LLM-confirmed) and ADR-0006 (no rubber-stamp gate) hold.
- Self-hosters inherit a cheaper default (Haiku confirm) and can pin Opus if
  their instance's false-merge rate warrants it. The `dedup_decision` audit trail
  now records which model made each call.
- If lever 3 ships, a thin slice of obvious non-matches never reaches the LLM;
  the only failure mode introduced is a near-duplicate that ADR-0012 already
  tolerates and live relatedness already surfaces.
