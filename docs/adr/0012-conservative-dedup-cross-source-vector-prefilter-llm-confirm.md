# 12. Conservative dedup is cross-Source: vector prefilter + LLM confirm, no human gate

Date: 2026-06-23

## Status

Accepted. Implements the "conservative dedup" promise in ADR-0006 and the
issue #5 acceptance criteria.

## Context

ADR-0006 (two-layer memory) commits the Canon to **conservative dedup**: merge
near-identical Principles so the Canon does not sprawl with literal duplicates,
but leave distinct framings alone — relatedness will stack them live at query
time (slice 7), and the interpretive Formation layer is where consolidation
properly belongs. The PRD AC #5 nails the requirement down to one sentence:
*"a repeated idea across Sources attaches a Quote to the existing Principle
rather than duplicating it; a genuinely distinct framing stays a separate
Principle."*

Implementing that needs three decisions: **what to compare against**, **how to
decide**, and **where the audit trail lives**. The book-ingest spike already
flagged that a single vector threshold has poor recall — paraphrases that
ought to merge sit below any threshold that doesn't also collapse genuinely
distinct claims. So a one-shot cosine cutoff is out.

## Decision

**Scope: cross-Source only.** The vector prefilter excludes principles whose
`sourceId` matches the source being ingested. A re-ingest of the *same* Source
under a *different* provenance (ADR-0008's model-mixed Canon) must not collapse
into itself, and intra-batch duplicates from one distillation pass are out of
scope for v1 — Marker's section-chunk distil (ADR-0010) keeps the noise floor
low enough that intra-source dedup is not the load-bearing case.

**Decision: vector prefilter + LLM confirm.** For each newly-admitted Principle:

1. Fetch the top-K cross-source candidates above a low cosine threshold
   (`DEFAULT_DEDUP_THRESHOLD = 0.4`, K = 5). The threshold is intentionally
   loose — it filters out the unrelated 90% so the LLM only sees plausible
   pairs, not "are these the same teaching" for every Principle in the Canon.
2. Walk candidates in similarity order. For each, ask `IngestProvider.confirmSameClaim(newClaim, candidateClaim)`. The LLM returns `{same, rationale}`.
3. First `same: true` wins: attach this Source's Quote (with `principleId`
   redirected to the candidate's id, and an `aq` ID prefix to distinguish it
   from own-principle quotes for the cleanup query) to the existing Principle.
   Stop walking.
4. If no candidate confirms, the Principle is admitted as fresh.

The LLM is the authority because the spike measurement showed cosine alone
either over-merges or under-merges. The conservative-default prompt instructs
the model to return `same: false` when in doubt; live relatedness covers the
ambiguous case at query time.

**Audit trail: a `dedup_decision` row per LLM consultation.** Every consultation
records `{candidateClaim, existingPrincipleId, verdict, rationale, similarityScore}`
plus provenance. The Owner can inspect why a candidate merged (or stayed
separate) without re-running the model. No-candidate cases (nothing crossed
the prefilter) are not logged — there is nothing to inspect.

**Idempotency: dedup state is scoped to (sourceId, provenance).** Attached
quotes are uniquely ID-prefixed (`${sourceId}#${tag}#aq${idx}`) and dedup
decisions carry the full provenance. `replacePrinciplesForSource` wipes both
inside the same transaction that wipes the slot's own principles. Re-ingesting
a Source under the same provenance produces the same merges deterministically
(LLM call notwithstanding) and writes the same row count.

**No human merge gate.** ADR-0006 already rejected per-merge approval as the
rubber-stamp failure mode; this slice does not surface dedup decisions in
Review. The Review queue is for *unlocatable* extractions (ADR-0007) only.

## Considered Options

- **Vector threshold alone, no LLM confirm.** Cheap; the spike showed it
  either over-merges (low threshold) or misses paraphrases (high threshold).
  Rejected — the LLM call is the recall-recovery the spike found necessary.
- **LLM call for every cross-Source pair (no prefilter).** O(n) LLM calls per
  new Principle. Wasteful by ~95% — most pairs are obviously unrelated.
  Rejected.
- **Embed-the-whole-canon-into-clusters-once, look up cluster on ingest.**
  GraphRAG-shaped. Adds a stored intermediate that has to invalidate on every
  new Principle, and re-creates the stored-graph problem ADR-0006 explicitly
  rejected for relatedness. Rejected.
- **Merge across all slots including same-source (intra-batch + cross-provenance).**
  Would break ADR-0008's model-mixed Canon (a re-ingest under a new model would
  collapse into the prior model's slot) and is unnecessary for the v1
  failure mode. Rejected — same-source is excluded explicitly in the
  repository query.
- **Human-in-the-loop merge approval.** Already rejected in ADR-0006.

## Consequences

- One LLM call per Principle that crosses the prefilter — usually zero on a
  fresh Canon, climbing as the corpus saturates. The conservative threshold
  keeps the call rate bounded.
- `IngestProvider` gains a third method (`confirmSameClaim`). The
  `AnthropicIngestProvider` uses tool-use for a typed `{same, rationale}`
  shape, mirroring the distil call. `FakeIngestProvider` takes a scripted
  verdict for tests.
- `CanonRepository` gains `findSimilarPrinciplesExcludingSource` and an
  options bag on `replacePrinciplesForSource` for attached quotes and
  decisions. The port stays one transaction-shaped call so the Postgres
  implementation can write everything atomically.
- A `dedup_decision` table joins the four existing Canon tables. FK to
  `principle` is `ON DELETE SET NULL` so dropping a host Principle does not
  silently drop the historical record of why something merged into it.
- Self-hosters who swap distil providers inherit the conservative default
  prompt; the prompt is intentionally short and unsigned-by-doctrine because
  the Canon does not adjudicate doctrine (ADR-0006). A self-hoster whose model
  over-merges or under-merges can tune the threshold per instance.
- Live relatedness (slice 7) becomes more load-bearing — the "ambiguous"
  cases that this slice deliberately keeps separate are exactly what live
  relatedness needs to surface.
