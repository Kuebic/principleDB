# 18. Editions layer between Work and Source; Recension is the orthogonal provenance axis

Date: 2026-07-15

## Status

Accepted. Builds on [ADR-0017](0017-work-figure-grouping-layer-over-per-chapter-sources.md)
(Work/Figure grouping) and [ADR-0008](0008-ingest-model-byo-with-recommended-default.md) /
[ADR-0012](0012-conservative-dedup-cross-source-vector-prefilter-llm-confirm.md) /
[ADR-0013](0013-dedup-throughput-parallel-confirm-haiku-asymmetric-banding.md) (first-source-wins
dedup), whose mechanics this ADR deliberately leaves untouched.

## Context

A Work in the Canon can exist in more than one **published recension**, and the differences
between them are doctrinally load-bearing here, not cosmetic. Cheon Seong Gyeong exists as a
pre-ascension edition and a 2013-revised edition; the revision is publicly contested — both of
Rev. Moon's sons condemned it, and specific passages are alleged to have been added or removed
to favour a later stance. The 2014 Gateway/PHG/CBG translations came out of the same post-2012
FFWPU standardization wave.

Two problems follow.

**The recension is currently smuggled into an ingest slug that is explicitly not citation-grade.**
Today edition lives only inside `source.author`/`source.title` slugs — `PHG14-01` encodes "Pyeong
Hwa Gyeong 2014", `SunMyungMoon-CSG` encodes nothing. ADR-0017 established that these slugs are an
implementation detail *beneath* the Work and are never shown to readers. So the Canon renders CSG
citations with **no indication of which recension** they came from — it silently presents the
post-2012 FFWPU text as neutral scripture. The Canon has, in effect, already committed to one side
of a schism without recording that it did.

**"Which edition" and "which editorial regime" are two different questions.** A member citing a
passage wants the precise artifact ("CSG 2013 Revised, Book 16"). An owner auditing the corpus
wants the cross-cutting one — "is *all* my scripture the post-2012 recension?", "show me every
pre-ascension edition across every Work." The first is per-Work; the second cuts across Works and
is the actual integrity signal.

There is also a near-term multilingual case that must not force a different model: uploading, say,
a Korean Divine Principle alongside the English one. Distillation emits the claim in canonical
English regardless of source language, so a Korean-sourced Principle produces the *same* English
claim and should merge with the English one — while readers still choose to view the Korean source
text or the English source text.

## Decision

**Introduce an `edition` table between Work and Source, and treat recension as a tag on it — not
a level of the hierarchy.**

- **Edition** — a specific published recension of *one* Work (CSG 2013-Revised; a future CSG
  2010-Original). A **child of Work**, mirroring the ADR-0017 argument that a canonical identity
  shared by many rows earns its own small table rather than being duplicated as columns on each
  Source. Every Source belongs to exactly one Edition; every Edition to one Work.
- **Recension** — the editorial regime that produced an edition (`ffwpu-post-2012`,
  `pre-ascension-original`, `external-discourse`, …). This is the **orthogonal** axis — it cuts
  across Works and Figures. Modeled as a **text tag column on Edition**, a documented controlled
  vocabulary, exactly as `tier` (core/extra) is a text column on Work rather than its own table.
  Promoted to a table only if a recension ever needs its own metadata or relationships.

**Source reaches Work through Edition — a single path.** `source.work_id` is replaced by
`source.edition_id`; Work is resolved `Work → Editions → Sources`. Keeping both a `work_id` and an
`edition_id` on Source would re-create the exact second-drifting-path-to-identity failure ADR-0017
was written to remove (`author` disagreeing with the real book).

**Principles stay edition-agnostic; edition is a property of the Quote/Source, never of the claim.**
A Principle is "a single distilled atomic teaching claim, in canonical wording"
(CONTEXT.md) — edition-independent by definition; wording variance lives in Quotes, which are
edition-stamped through their Source. So first-source-wins (ADR-0008) and the dedup loop
(ADR-0012/0013) are **unchanged** — another edition is just more Sources. This still powers
warping analysis: a teaching in both editions becomes one Principle with quotes from both; a
teaching **added** in the revision is a Principle with revision-only quote coverage; one **removed**
is a Principle from the older edition that never finds a merge partner. **Warping = Principles whose
quote coverage is single-edition.**

**Language lives on Edition (non-null, default `en`) and derives down to the Quote.** A merged
Principle can carry an English quote and a Korean quote; "view the Korean vs the English source" is
a filter of a Principle's quotes by `edition.language` — no per-Quote language column, matching the
schema's derive-on-read discipline. Cross-language merge leans harder on the confirm model (it must
judge a Korean-sourced English claim equal to the English one) than same-language merge does; the
`dedup_decision` audit log records every such merge for inspection, the same safety net as any
cross-edition merge.

**`edition` columns:** `id`, `work_id`, `label` ("2013 Revised", "2010 Original", "2014
Translation"), `recension`, `language` (non-null, default `en`), and nullable `published_date`,
`publisher`, `notes`.

**The existing 7 Works are backfilled once**, additively and deterministically (the ADR-0017
playbook — no re-ingest, no re-distillation): one Edition per Work, its `label`/`recension` read
from the ingest slug and **verified against `source.date`** at migration time. Recommended seeds:
CSG → 2013 Revised / `ffwpu-post-2012`; PHG → 2014 / `ffwpu-post-2012`; CBG → 2015 /
`ffwpu-post-2012`; Divine Principle → Exposition / `pre-ascension-original`; WOGW → 1980 /
`pre-ascension-original`; Unification Thought → `pre-ascension-original`; TM Anthology → 2017 /
`ffwpu-post-2012`; the two Dunkley discourses → `external-discourse`.

## Considered Options

- **Edition as columns on Source** — cheapest, no new table. Rejected: an edition is one identity
  shared by up to 429 Sources; columns-on-Source duplicate it per row and leave no home for
  edition-level metadata — the same anti-pattern ADR-0017 rejected for `author`/Figure.
- **Edition as a separate Work** (make "CSG 2013" and "CSG 2010" two Works) — Rejected: they are
  the same teaching; splitting them breaks "search all of CSG", pollutes `list_works`, and
  re-duplicates Figure attribution and the Work-as-selection-unit semantics ADR-0017 established.
- **Recension as its own table** — Rejected *for now*: the value set is tiny, stable, and
  relationship-free; a text tag matches `tier`. Deferred, not refused.
- **Edition-scoped Principles** (never merge across editions, so 2010 and 2013 keep parallel
  Principle sets) — Rejected: duplicates every shared teaching, bloats the Canon, and breaks
  first-source-wins. Warping is still detectable under the merged model via single-edition quote
  coverage, so the duplication buys nothing. (Revisit only if a side-by-side diff *viewer* becomes
  a first-class product surface.)
- **A `canonical`/default-edition flag now** — Deferred: with Principles merged, a search hit is
  one Principle regardless of how many editions witness it, and every live Work is single-edition,
  so nothing forces the choice yet. Add `edition.is_canonical` when a second edition of one Work is
  actually ingested (ADR-0017 deferred its `draft` state the same way).

## Consequences

- Additive migration: an `edition` table and `source.edition_id`, replacing the ADR-0017
  `source.work_id`; the `scope.ts` filter resolves `Work → Editions → Sources` (one extra join).
  The backfill populates one Edition per existing Work.
- Citations gain the Edition label, so the Canon stops presenting `ffwpu-post-2012` as neutral
  scripture; "the recension split across the whole corpus" becomes a query.
- Dedup, distil, and staging are untouched — editions enter the existing pipeline as ordinary
  Sources.
- Every future ingest declares its Source's Edition (and through it the Work/Figure), just as
  ADR-0017 made Work/Figure a required ingest step.
- Members still select Works, not Editions (`list_works` and the picker are unchanged); an
  edition-grain filter and the Reader's source-language toggle are deferred with the
  canonical-edition flag.
- `CONTEXT.md` gains **Edition** and **Recension**, and **Source** is re-sharpened as a
  chapter-sized text unit of *one Edition*.
