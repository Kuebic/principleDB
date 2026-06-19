# 6. Two-layer memory: Canon (descriptive) and Formation (interpretive, per-user)

Date: 2026-06-17

## Status

Accepted. Supersedes the placement decision in ADR-0004 (Evolution links and Standing move
out of the core/Canon into the Formation layer).

## Context

ADR-0004 modelled teaching evolution (typed `tempers`/`refines`/`supersedes` links) and
`standing` (`emphasized`/`historical`/`contested`) as part of the core data model. A later
grilling pass exposed a sharper cut: those are **interpretations**, and interpretations of
how a teaching has progressed — or what to lean on now — vary person to person and shift
over time within one person. Baking them into the single faithful base would freeze one
reading as if it were fact.

Separately, recomputing generic relatedness on every query is wasteful, but eagerly
materialising a full connection graph is the stale-graph / O(n²) trap rejected for the
connection engine.

The resolution (largely designed by the corpus owner) is a two-layer memory, mirroring
descriptive vs. consolidated memory: a shared factual base plus a personal layer that
consolidates with use. Prior art for the pattern: GraphRAG materialises corpus-level
clusters; agent-memory systems (Mem0, Zep, Letta) maintain per-user memory that consolidates
from repeated interaction.

## Decision

Split the corpus into two layers.

**Canon — descriptive, shared, the point of truth.** Sources, atomic Principles, Quotes
(with dates and locators), and conservative dedup (merge only near-identical duplicates).
It records *what was taught, by whom, when* — nothing interpretive. It stores **no**
connections, **no** standing, and performs **no** conflict adjudication: two contradictory
teachings are both recorded faithfully (the teaching genuinely said both). Generic
relatedness is computed **live** at query time, not stored.

**Formation — interpretive, per-user, grows with use.** Holds everything interpretive:
`standing`, typed Evolution links, and consolidated belief clusters. Connections here are
**lazily materialised by usage** — a connection is cached only once it has actually been
traversed and proven useful, and is reinforced on reuse (so unused links never form and the
stale-graph trap is avoided). Formation is a read-through layer over the Canon: a query
checks Formation first (fast, personal), falls back to live Canon retrieval on a miss, and
promotes newly-useful connections up into Formation.

**Sequencing.** v1 builds the **Canon only**. Formation is a later layer — additive, no
rework — and it reactivates the multi-user scope deliberately deferred in ADR-0005 (it needs
per-user state).

## Considered Options

- **Single layer with evolution + standing in the core (ADR-0004 as written)** — simpler to
  describe, but freezes one interpretation as fact and cannot vary per person. Rejected.
- **Eagerly materialise all connections** — kills query-time recompute cost, but is the
  stale, O(n²), bloating graph already rejected. Rejected in favour of lazy usage-driven
  materialisation.
- **Three tiers: Canon → shared "house" interpretation → personal adjustments** — a shared
  interpretive layer (the teacher's reading, "smoothing the rough edges") between the Canon
  and each user's personal layer. Rejected: there is no single definitive interpretation to
  enshrine — enshrining one is the very thing the Canon/Formation split exists to avoid — and
  a distinct third layer is more to build for a benefit the read-through model already gives.
  The **owner's Formation can serve as the shared default** a member's Formation reads through
  to (Canon ← owner's Formation ← member's adjustments), delivering "general reading before
  personal adjustment" without a third system.

## Consequences

- v1 (the Canon engine) is materially simpler: no stored connections, no standing, no
  evolution links, no conflict adjudication. Ingest Review collapses to a single question —
  *"is this a faithful atomic extraction?"* — not doctrinal arbitration.
- The merge question is dissolved: the **Canon** uses conservative dedup (Option ①, stays
  faithful and un-collapsed); the **Formation** layer is where Option-②-style consolidation
  happens — non-destructively, per-user, reversibly. Merge never corrupts the truth layer.
- Formation requires user accounts → it lands with (and motivates) the deferred multi-user
  work. The v1 PRD must be trimmed to Canon-only.
- ADR-0004's mechanism (the `tempers`/`refines`/`supersedes` vocabulary, quote-dated
  timelines) still stands; only its *layer* changes.
- The "house reading" need (not making every member re-smooth the same rough edges) is met
  without a third layer: when multi-user lands, a member's Formation read-through-defaults to
  the **owner's** Formation before the Canon. One extra fallback hop, same lazy mechanism.
