# 5. Self-hosted MCP server over a two-tier store with an AI-legible schema

Date: 2026-06-16

## Status

Accepted

## Context

principleDB must hold a large source archive (e.g. ~50 GB of PDFs, scanned book images,
and sermon text from a teachings archive) while still answering precise, grounded queries.
The owner is technical, already runs an MCP server (their "Open Brain") on Supabase, and
already uses Cloudflare R2 for blob storage. The whole project exists to beat the
unstructured-RAG ceiling, where embedding 500-word raw chunks produces blurry vectors that
miss quotes — so *structure*, not transport, is the differentiator.

The earlier inclination toward a full first-party app was reconsidered: the owner queries
from their own AI client, the secondary users only need to *view* shared Compositions, and
the interface turns out to be the most reversible decision in the system.

## Decision

**Interface — MCP server.** principleDB is a self-hosted MCP server exposing the store as
tools (search Principles, fetch quote-in-context, traverse Connections/Evolution links,
list drift candidates, confirm links). Conversation, ingest Review, and Composition-
building all happen in the owner's own AI client. Thin public **share pages** serve
read-only Compositions to members. Provider-agnostic: the owner brings their own model/key.

**Storage — two tiers.** A blob lake (Cloudflare R2) holds the raw Sources; a query store
(Supabase Postgres + pgvector) holds only the distillate — Principles, Quotes, Connections,
embeddings, and a pointer (R2 key + page) per Source. The multi-GB archive never enters
the query store, which stays small and fast. Embeddings live on atomic Principles, not on
raw chunks.

**Schema — one declarative, AI-legible file.** The data model is defined in a single
declarative, version-controlled schema file that is the source of truth: **Drizzle ORM**
`schema.ts` (chosen), which generates the SQL migrations (migrations are never hand-
written). The AI reads and edits that file; it never infers the schema from database
internals.

## Considered Options

- **Full first-party app** — richest UX, but the most to build, moves the conversation out
  of the AI client the owner already uses, and members only need read-only views. Rejected.
- **R2 (or any blob store) as the database** — cannot query or do vector search; a
  category error. R2 is for files only. Rejected.
- **Convex for the query store** — great AI-legible JSON schema and DX (the inspiration for
  the schema decision), but more proprietary than plain Postgres; migrating out is a
  re-export, not a `pg_dump`. Rejected for the core store in favour of portability; its
  schema-legibility virtue is preserved via the declarative-schema-file decision.
- **Blobs inside Postgres** — bloats and slows the query store. Rejected.

## Consequences

- The owner needs an MCP-capable AI client; non-technical members are served only through
  read-only share pages. This is acceptable given the user model (single technical Owner).
- Lock-in stays low: standard Postgres + pgvector means `pg_dump` → self-hosted Postgres
  any time, and the MCP layer is a thin adapter swappable for a REST API or app later with
  no data migration.
- To keep a future first-party app cheap, domain logic lives in a **shared core** (typed
  functions over Drizzle: search, quote-in-context, traverse connections, ingest). The MCP
  server is a thin adapter over that core; any later app is *another* adapter over the
  *same* core — no logic duplicated, no data reshaped.
- The declarative schema file is load-bearing, like `CONTEXT.md` and these ADRs — it must
  be kept in sync as the single source of truth.
- Free-tier Supabase comfortably holds the distillate (tens of thousands of Principles);
  R2 holds the archive for cents per month. Free-tier project pausing after inactivity is
  the main reason to move to a paid tier once members rely on the share pages.
- Setup (Supabase wiring + MCP connection) follows an AI-assisted setup guide of the kind
  used in the owner's Open Brain work, e.g.
  <https://github.com/NateBJones-Projects/OB1/blob/main/docs/04-ai-assisted-setup.md>.
