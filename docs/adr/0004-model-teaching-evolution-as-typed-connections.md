# 4. Model teaching evolution as typed connections between Principles

Date: 2026-06-16

## Status

Accepted, but amended by ADR-0006: the mechanism below stands, but Evolution links and
`standing` live in the per-user **Formation** layer, not the core/Canon.

## Context

The Corpus is not a flat, timeless authority. Emphasis shifts over time — e.g. an older
emphasis on "total devotion" is now intentionally tempered toward "grace." principleDB
must let the AI present a Principle through its *current* lens rather than as an era-blind
claim, and must distinguish a legitimate evolution from Drift when a new Source appears to
contradict an old one.

## Decision

Model evolution in three layers:

1. Every Quote carries the **date** of its Source, so each Principle has a timeline.
2. Each Principle carries a **standing** flag — `emphasized` / `historical` / `contested`.
3. The connection engine carries **typed Evolution links** between Principles —
   `tempers`, `refines`, `supersedes` (e.g. grace *tempers* total-devotion). The AI
   traverses these when stacking Principles, so output reflects how the teaching now holds
   an idea.

Conflicts surfaced during ingest Review are resolved as either Drift (reject) or a
proposed Evolution link (record) — so one mechanism serves both fidelity and evolution.

## Considered Options

- **Standing flag only** — simple, but the AI knows a Principle is `historical` without
  knowing *what* re-framed it; loses the "we hold devotion *through* grace" reasoning.
  Rejected.
- **Dates only, infer at query time** — least structure, but recency ≠ emphasis and the
  evolution is re-guessed every query instead of recorded once. Rejected.

## Consequences

- Evolution links are authored by AI but confirmed by a human at Review — they encode
  intent, not similarity, and cannot be recomputed from embeddings.
- This is a deliberate bet under uncertainty. **Escape hatch:** if typed links prove too
  heavy to maintain, the system can fall back to `standing` + dates without discarding the
  rest of the data model.
- The `tempers / refines / supersedes` vocabulary is small and fixed for now; widening it
  later is itself an ADR-worthy change.
