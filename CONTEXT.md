# CONTEXT — principleDB

This is the bedrock document. Every agent (interactive or Sandcastle-driven) reads it
first. Keep it current: when a decision lands, record the *why* here or in an ADR.

## Purpose

principleDB turns a body of teaching — a church's sermons and doctrine, alongside other
source material — into an AI-navigable base of atomic **Principles**. Instead of
hand-linking notes (the Zettelkasten approach, which stopped scaling past a few hundred
atomic files), a user *converses* with an AI that draws on a **connection engine** over
those principles: it surfaces ideas, gives clarity, and assembles grounded, coherent,
personally-tailored material — sermons, devotions, heart alignments — without inventing
or hallucinating beyond the corpus.

The point is not retrieval ("give me quotes about gratitude"). The point is the
connection engine *stacking* principles into something coherent, in dialogue with the
person, faithful to what was actually taught.

principleDB keeps **two layers** (ADR-0006). The **Canon** is the shared, faithful,
*descriptive* base — what was taught, by whom, when. The **Formation** layer is
*interpretive* and *per-user* — standing, how principles evolve, and consolidated beliefs
that solidify with use. v1 builds the Canon; Formation comes later.

## Users

- **Owner / teacher** (primary) — the pastor or teacher; the sole account on an instance.
  Thinks with the *whole* body of teaching at once and builds Compositions from it.
- **Seeker / member** (secondary) — consumes Compositions (or answers) the owner shares
  out via link. Does not log in or create, in v1.

principleDB is **self-hostable** and **provider-agnostic**: each owner runs their own
instance — an **MCP server** over a structured Postgres+pgvector store, with original
Sources in object storage — and queries it from **their own AI client**, where the
conversation, ingest Review, and Composition-building all happen. Read-only **share
pages** let members view finished Compositions without an account. "Their own AI" means
their own *model* and their own *client*.

## Domain language (glossary)

- **Principle** — A single distilled atomic **teaching claim**: a general/normative
  assertion about how things are or ought to be (e.g. "Grace precedes obedience"), in
  canonical wording. *Not* a particular narrative fact ("the prodigal son came home") —
  narrative is the **Quote** that backs a Principle, never a Principle itself. The linkable
  node of the system; what the connection engine relates and what a user navigates by.
  Granularity is faithful-descriptive, never ranked by importance (significance is Standing,
  a Formation judgment, not Canon). _Avoid_: note, card, zettel, insight, concept.
- **Quote** — A verbatim excerpt from a Source that backs a Principle, carrying a
  precise locator into that Source. "Verbatim" is **word-level**: the excerpt is matched
  and stored as a **located span in the Source** (char offsets into its continuous text; the
  human-readable label — page, section, or timestamp — is *derived* per Source type), never the
  AI's reproduction of it — so the displayed quote is always the Source's own words and a reader
  can jump to the exact spot. Typographic noise (curly vs straight quotes, whitespace,
  line-wrap hyphenation) is normalised away only to *locate*; a quote that won't locate is a
  Drift signal for Review. The evidence layer. _Avoid_: snippet, passage, citation.
- **Source** — An original teaching *as ingested* — the unit distillation runs over and
  the text a Quote locates into. Often a whole speech or article; a long book is split
  into per-chapter Sources, all belonging to one **Edition** of a **Work** (Cheon Seong
  Gyeong is 429 Sources). Its `author` may be an ingest-time slug (`SunMyungMoon-CSG`, a
  DP part name) and is *not* the citation shown to readers — the Work's title, Figure, and
  Edition are. Openable so a Quote can be seen in its surrounding context. _Avoid_:
  document, reference, material, file, chapter (a chapter is one Source, but so is a whole
  speech).
- **Edition** — A specific published **recension** of one Work (Cheon Seong Gyeong
  "2013 Revised" vs a future "2010 Original"; a Korean vs an English Divine Principle).
  Sits *between* Work and Source: a Work has one or more Editions, each made of Sources.
  Carries a `label`, a **Recension** tag, a `language`, and publication provenance. Editions
  are a **citation and provenance** concern, not a claim concern — Principles merge *across*
  Editions (the claim is edition-independent, in canonical wording), so the same teaching in
  two Editions is one Principle whose Quotes reveal which Editions witness it. A teaching that
  appears in only one Edition (added, removed, or altered by a recension) shows up as a
  single-Edition Principle — the warping signal. _Avoid_: version, printing, revision (that's
  the Recension), translation (that's the `language`).
- **Recension** — The editorial regime that produced an Edition — `ffwpu-post-2012`,
  `pre-ascension-original`, `external-discourse`, and so on. The **orthogonal** provenance
  axis: it cuts across Works and Figures, so "show every pre-ascension Edition across the whole
  corpus" is one query. The integrity signal that keeps the Canon from silently presenting one
  contested recension as neutral scripture. A small controlled vocabulary (a tag on Edition),
  not a per-Work concept. _Avoid_: edition (that's the artifact), source, version.
- **Work** — A teaching *as published*: a book or a single speech/sermon/article. The
  unit a reader chooses to search within or exclude (the search-filter checkbox). Made of
  one or more **Editions**, each made of one or more Sources — a speech is a 1-Source Work,
  a scriptural book a many-Source Work; a re-translated or revised book gains a second Edition.
  Carries the clean human title and the **Figure** it is attributed to; the underlying
  Sources' raw `author` slugs are an implementation detail beneath it. Each Work is
  **core** (searched by default — the founding corpus) or **extra** (in the Canon but
  opt-in per search — later additions like a single speech or a supplementary book); a
  member's default scope is "all core Works," and extras are pulled in only when named.
  _Avoid_: book (a speech isn't one), collection, volume, series, publication.
- **Figure** — The teacher a Work is *attributed to* — whose teaching it is, which is
  what a reader means by "search only Hak Ja Han." Distinct from an ingest `author`
  string (Unification Thought's author is Sang Hun Lee, but a reader may still file it
  under Moon; a future book *about* a person is attributed to that person, not its
  ghostwriter). A canonical identity, not a spelling — "Hak Ja Han Moon" and "Hakcha
  Han-Moon" are one Figure. Groups Works so selecting a Figure selects all their Works.
  _Avoid_: author (bibliographic, free-text), speaker (narrower than "attributed to"),
  person.
- **Corpus** — The whole body of Sources, and the Principles distilled from them, for a
  single instance. _Avoid_: library, dataset, knowledge base, vault.
- **Canon** — The descriptive, shared layer: Sources, Principles, and Quotes — *what was
  taught, by whom, when*. Faithful and interpretation-free; stores no connections, no
  standing, no evolution. The point of truth, and all that v1 builds. _Avoid_: index, base.
- **Formation** — The interpretive, *per-user* layer over the Canon: Standing, Evolution
  links, and consolidated beliefs that materialise lazily and strengthen with use. Where
  meaning and progression live (they vary person to person). A later phase — needs accounts.
  _Avoid_: cache, profile.
- **Connection engine** — Relates Principles so the AI can *stack* them into coherent
  material instead of returning isolated quotes. In the Canon, relatedness is computed
  **live** at query time (nothing stored); durable typed links (Evolution links)
  materialise lazily in **Formation**. What makes principleDB more than RAG. _Avoid_:
  graph, linker, index.
- **Connection** — A relationship between two Principles. Generic relatedness is computed
  live over the Canon; a typed Evolution link is stored, lazily and per-user, in Formation.
- **Standing** — A Principle's interpretive weight in the *living* teaching: `emphasized`,
  `historical`, or `contested`. A **Formation**-layer judgment (varies person to person) —
  *not* in the Canon. The factual timeline (Quote/Source dates) stays in the Canon.
  _Avoid_: status, state.
- **Evolution link** — A typed Connection recording how the teaching has changed:
  **tempers**, **refines**, or **supersedes** (e.g. grace *tempers* total-devotion). An
  interpretation of progression → a **Formation**-layer, per-user link, not Canon.
  _Avoid_: version, override.
- **Drift** — The Canon, or AI output, quietly diverging from what the Sources actually
  teach. The thing Review exists to catch. _Avoid_: hallucination (hallucination =
  inventing from nothing; drift = mis-weighting or distorting what is genuinely there).
- **Conflict** — Two Principles that appear to contradict. The **Canon** records both
  faithfully (the teaching genuinely said both at different times); adjudicating them
  (Drift vs a legitimate Evolution) is **Formation**'s job, per user. _Avoid_: collision,
  duplicate.
- **Review** — The human gate over ingestion into the Canon. Risk-triaged, not exhaustive,
  and scoped to one question: *is this a faithful atomic extraction?* (high-confidence
  flows through, sampled; low-confidence is surfaced). Doctrinal adjudication is *not* done
  here — that is Formation's. Conversational. _Avoid_: approval queue, moderation.
- **Composition** — A saved artifact built conversationally from Principles, holding
  live references back to them (and through them, to Quotes → Sources) so every claim
  traces to what was taught. Has an intended recipient/audience ("tailored to each
  person"). _Avoid_: output, artifact, document, work, piece.
- **Sermon / Devotion / Heart-alignment** — Subtypes of Composition, differing by
  audience and shape. _Sermon_: a full teaching for a congregation. _Devotion_: a piece
  for daily personal or small-group reflection. _Heart-alignment_: a very short teaching
  at the top of a service — a reading plus brief framing that aligns the congregation's
  hearts with the theme of the *upcoming worship songs*, so the singing lands (the
  Owner's term for a "mini-sermon").
- **Public Canon search** — The unlisted-public web face over the Canon: a visitor types
  a thought and gets connected Quotes with provenance, retrieved LLM-free (embedding +
  pgvector) with live related traversal (#40, #41). Deliberately the *shallow* face (see
  the "Not a quote-search engine" carve-out); distinct from the **Reader** (the
  quote-in-context viewer, #43). Working descriptor — the brand/display name is deferred
  to frontend design, not a code identifier. _Avoid_: search engine, RAG page.

## Non-goals

- **Not a quote-search engine.** principleDB does not answer "give me quotes about X"
  with a flat list of matching excerpts. It returns *stacked, connected* Principles with
  provenance. (This is the RAG ceiling it exists to break past.) **Carve-out (public
  site):** the **public Canon search** is a deliberately *shallow* face of the Canon — a
  thought returns connected Quotes via live relatedness (no LLM, no prose synthesis, no
  stacking). Depth — stacking Principles into a coherent argument — stays in the Owner's
  AI client (ADR-0005), which is what the "connect your AI" page exists to offer. The
  non-goal still holds for the *system's* ambition; the public face is an intentional
  slice, not the RAG ceiling being conceded (#40).
- **Not an autonomous sermon writer.** The AI assembles grounded raw material and drafts
  *in dialogue*; the Owner shapes, owns, and "feels" the result. The AI never just spits
  out a finished sermon.
- **Not a free-associating idea generator.** Every claim is grounded in the Corpus.
  Ungrounded invention is a failure mode (see Drift), not a feature.
- **Not a hand-linked note system.** No manual wiki-linking of atomic notes (the
  Zettelkasten failure mode). Relatedness is computed live; durable links form by use in
  Formation — never hand-wired.
- **Not multi-tenant SaaS, and not multi-user (v1).** Each Owner self-hosts one instance.
  v1 is single-Owner plus read-only sharing — no member accounts, roles, or permissions.
- **No full first-party app in v1 (deferred, not rejected).** The v1 surface is the MCP
  server; a richer app over the *same* shared core is a later option (see ADR-0005).
- **No Formation layer in v1 (deferred).** Standing, Evolution links, and per-user
  consolidated beliefs are the interpretive Formation layer — a later phase that needs user
  accounts (see ADR-0006). v1 ships the Canon only.
- **Not a general-purpose second brain.** Scoped to teachings → Principles, not arbitrary
  personal notes.

## Architecture

A self-hosted **MCP server over a two-tier store**, queried from the owner's own AI
client. High-level shape (detail + rationale in `docs/adr/`):

- **Blob lake** — original Sources (PDFs, scanned book images, sermon text) live in
  object storage (Cloudflare R2). Tens of GB; never enters the query store.
- **Query store** — Supabase Postgres + pgvector holds the **Canon** distillate: Sources,
  Principles, Quotes, embeddings, and a pointer (R2 key + page) per Source. No stored
  connections or standing in v1 — relatedness is computed live. The interpretive
  **Formation** layer (standing, Evolution links, consolidated beliefs, per-user) is a
  later phase (ADR-0006). Stays small and fast regardless of corpus size.
- **Interface** — an MCP server exposes the Canon as tools (search Principles,
  quote-in-context, live relatedness, list Review candidates). Conversation and ingest
  Review happen in the owner's AI client. (Compositions and member share pages are later
  phases.)
- **Provider-agnostic** — the owner brings their own model and key.
- **Ingest branches by Source type** — text (distil directly), digital PDF (extract →
  distil), scanned/image (OCR → distil); the file goes to R2, the locator is the page.

Stack specifics and migrations are recorded as ADRs.

## Conventions

- Plan before code: spec → grill → issues → build.
- Every architectural decision gets an ADR in `docs/adr/`.
- Work is sliced into independently-verifiable vertical slices (tracer bullets).
- Build is executed by Sandcastle; see [WORKFLOW.md](./WORKFLOW.md).
- The data model lives in **one declarative, version-controlled schema file** (the single
  source of truth). The AI reads it to know the shape of the data and edits it to change
  the model — it never infers schema from database internals.
