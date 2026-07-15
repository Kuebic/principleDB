# 17. A Work/Figure grouping layer over per-chapter Sources drives source filtering

Date: 2026-07-14

## Status

Accepted

Builds on [ADR-0006](0006-two-layer-canon-formation.md) (Canon shape) and
[ADR-0015](0015-web-app-and-public-mcp-as-colocated-adapters.md) (both surfaces are
adapters over the same core, so a filter added to the core reaches web and MCP at once).

## Context

Members want to choose what the search looks through — "search only Cham Bumo Gyeong,"
or "did Hak Ja Han ever say anything about this." Two things blocked that.

**The unit people select does not exist in the schema.** A `source` row is a per-chapter
ingest unit (distil windows split books into chapters), not the book. The Canon holds 615
sources but only ~7 books: Cheon Seong Gyeong is 429 sources, Divine Principle 59, UT 70,
WOGW 25, Cham Bumo Gyeong 15, Pyeong Hwa Gyeong 13, TM Anthology 4. `CONTEXT.md` had
*defined* Source as the whole book ("a sermon, transcript, book, article"); the pipeline
quietly made the `source` row a chapter and the glossary drifted. There is no field tying
the 15 Cham Bumo Gyeong chapters together.

**`author` cannot recover the books.** Inspecting the live Canon, `author` is not a clean
person facet: `SunMyungMoon-CSG` (429, a slug), `Sang Hun Lee` (70), `Sun Myung Moon` (53
— which is *three different books*: CBG + PHG + WOGW mashed together), `Hak Ja Han Moon`
(4), and Divine Principle **shattered across ~16 part-slug values** (`01-the-principle-of-
creation`, …) with no book name anywhere. `GROUP BY author` yields ~20 nonsense groups, not
7 books. The same slugs leak to users today: the search page renders `hit.source.author`,
so DP results cite "05-the-parallels-between-the-two-ages…" and CSG cites
"SunMyungMoon-CSG".

The filter also has to mean the same thing in two places: the web page (server-rendered,
LLM-free, GET form) and the public MCP `search_principles` tool an external AI client calls.

## Decision

**Introduce two stored concepts above Source: Work and Figure.**

- **Work** — a teaching as published (a book, or a single speech). The unit a member
  selects. Every Source belongs to exactly one Work; most future Works (a speech, an
  article) are 1-Source, the scriptures are many-Source. A Work carries a clean human
  title, a Figure, and a `core`/`extra` tier.
- **Figure** — the teacher a Work is *attributed to*. Stored as its own small table
  (id/slug + display name), **not** a string on Work, because the domain defines a Figure
  as a canonical identity, not a spelling ("Hak Ja Han Moon" and "Hakcha Han-Moon" are one
  Figure). Work references `figure_id`.
- **`core` vs `extra`** — `core` Works are searched by default (the founding corpus);
  `extra` Works are in the Canon but opt-in per search. The default scope, on every
  surface, is "all core Works."

**Filter semantics are include-only and identical across surfaces.** A scope is an
explicit set of Works/Figures; **omitting it means "all core Works"** (dynamic — a future
core Work auto-joins, and a shared URL that named nothing keeps meaning "core"). Naming a
Figure expands, server-side, to its Works; naming an `extra` Work pulls it in. There is no
exclude-list — "search only X" is what people say.

- **MCP** gains a discovery tool `list_works` (Works grouped by Figure, with the
  core/extra flag) and two optional params on `search_principles`:
  `{ query, limit, works?: string[], figures?: string[] }`, union'd, include-only.
- **Web** carries the same scope in **URL query params** (`&work=…`, `&figure=…`); absence
  = core. State lives purely in the URL — no cookie, no account (v1 members do not log in;
  share pages are stateless). The picker is a collapsible panel (default closed) grouped by
  Figure, core pre-checked, `extra` listed unchecked; submitting re-runs the GET.

**The existing 615 Sources are backfilled once, deterministically** — a hand-authored
mapping, no re-ingest, no re-distillation. Seven Works, all `core`, verified to partition
all 615 rows with zero leftovers: CSG (`author='SunMyungMoon-CSG'`), UT (`author='Sang Hun
Lee'`), TM Anthology (`author='Hak Ja Han Moon'`), and the `Sun Myung Moon` bucket split by
title signature into WOGW / CBG / PHG (25 + 15 + 13, 0 leftover); Divine Principle is the
complement (the 59 part-slug rows). Attribution ratified with the owner: UT → **Sang Hun
Lee** (attribute to who wrote it; "Moon's systematized thought" is a Formation-era concern,
not a v1 filter), DP → **Sun Myung Moon**, the rest as their author implies.

**The retrieval filter is a SQL pre-filter, before top-K.** `searchByEmbedding` takes an
optional scoped Source-id set (Works → their Sources; Figures → their Works → Sources) and
constrains the vector search *before* ranking, not after. Post-filtering the global top-K
would under-return on tight scopes; a 4-Source scope (TM Anthology) needs pgvector
iterative-scan, or an exact scan when the scoped set is small.

## Considered Options

- **Derived `GROUP BY author`, no new concept** — cheapest, no migration. Rejected: the
  live `author` values do not encode the books (three books share one string, DP has none),
  so it cannot produce the 7 groups the owner asked for, and it keeps leaking slugs to
  readers.
- **Filter on Source directly (flat checklist)** — no grouping concept. Rejected: a
  615-row checklist, ~430 of them CSG chapters, is the exact thing that makes "select all
  of one person" impossible — the motivating use case.
- **Collapse chapters back into one book-Source** — matches the old glossary, but the whole
  ingest/dedup/quote-locating pipeline is per-chapter; re-unifying is a rewrite for no gain.
  Rejected. Work sits *above* Source instead.
- **Figure as a string column on Work** — simpler, 3 values today. Rejected: the domain
  needs one identity for many spellings, and a table centralizes display name and future
  merges; the cost is one tiny table.
- **New Works default-on (all-in)** vs **default-off (opt-in)** — the owner chose
  `extra`/opt-in: later additions are "extra," the current 7 are the core. A `draft` state
  for risky material is deferred until a real case exists.
- **Exclude-list filter semantics** — rejected in favor of include-only; naming a scope
  restricts to it, which is how the request is phrased and makes pulling in an `extra` Work
  just "name it."

## Consequences

- Additive migration: a `figure` table, a `work` table (`figure_id`, `tier`), and a nullable
  `work_id` on `source`. No existing column changes; the backfill populates all three.
- `searchByEmbedding` (and the tools over it) grow an optional scope argument; the unscoped
  call path is unchanged, so existing callers keep working with "all core" semantics once the
  default is wired.
- The public MCP read surface grows from three tools to four (`list_works` added) — an
  explicit, tracked extension of the ADR-0015 surface, not an accident.
- Search-result citations switch from the raw `source.author` slug to the Work title +
  Figure, fixing the leaked `SunMyungMoon-CSG` / DP-part-slug citations as a side effect.
- Every future ingest must assign its Source(s) to a Work and a Figure (and a tier) — a new
  required step in the ingest path. The DP backfill rule is "the complement," which is frozen
  to today's 615 rows; a *new* slug-authored book must declare its Work explicitly rather
  than fall into DP's bucket.
- `CONTEXT.md` gains **Work** and **Figure**, and **Source** is re-sharpened as the ingest
  unit (a chapter) beneath a Work — repairing the drift where the glossary called Source the
  book.
