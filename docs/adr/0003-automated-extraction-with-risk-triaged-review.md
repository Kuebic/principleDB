# 3. Automated extraction with risk-triaged review

Date: 2026-06-16

## Status

Accepted. Refined by ADR-0007 (the confidence signal is **quote locatability**, not the
candidate *self-assessment* described below) and by ADR-0006 (v1 Review is scoped to the
single question "is this a faithful atomic extraction?" — **Conflict** adjudication moved to
the per-user Formation layer and is not a v1 Review trigger).

## Context

principleDB exists because hand-authoring and hand-linking atomic notes (the Zettelkasten
approach) stopped scaling past a few hundred files. The Corpus must grow to thousands of
Principles drawn from many Sources, so Principles and Quotes have to be produced by AI at
ingest time, not by hand. But the teaching must stay faithful to the Sources — ungrounded
distortion (Drift) is the core failure mode.

A prior attempt (the owner's "Zettel" app) used auto-extraction plus a *flat* review
queue. In practice the queue grew so large that review degraded into rubber-stamping:
every item skimmed and approved, so the gate added effort without catching much.

## Decision

Ingest is: Source → AI distills candidate Principles, pulls backing Quotes with locators,
and **merges** each candidate against existing Principles (a repeated point attaches a new
Quote to an existing Principle rather than duplicating). Each candidate carries a
confidence/risk self-assessment.

Review is **risk-triaged, not exhaustive**. High-confidence clean merges flow into the
Corpus (sampled, not individually approved). Human attention is spent only on the items
that can cause Drift: low-confidence extractions and **Conflicts** (a candidate
contradicting an existing Principle). Review is conversational, with progressive
disclosure — high-level by default, drill into detail on demand.

## Considered Options

- **Fully automated, no gate** — maximum scale, but Drift enters silently. Rejected:
  fidelity to the Sources is non-negotiable.
- **AI-assisted manual authoring** — highest fidelity, but reproduces the Zettelkasten
  scaling problem we are fleeing. Rejected.
- **Flat review queue** — what the prior app did; degrades to rubber-stamping at scale.
  Rejected in favour of triage.

## Consequences

- The pipeline must produce a calibrated confidence/risk signal and a merge/dedupe step —
  these are load-bearing, not nice-to-haves.
- Some low-risk Drift will pass unreviewed; an accepted trade for scale, mitigated by
  sampling and by Conflict-detection surfacing the high-stakes cases.
- "Review" is a first-class, ongoing surface in the app — heaviest during initial bulk
  import, when the Owner cannot adhere to every item and explicitly extends some trust.
