# 11. Ingest splits into distill (Anthropic) + embed (OpenAI), composed behind one IngestProvider

Date: 2026-06-23

## Status

Accepted. Refines ADR-0008 (BYO ingest model + recommended default) with the operational fact
that no single vendor today serves both halves of the Canon ingest pipeline well.

## Context

ADR-0008 picked `claude-opus-4-8` as the recommended distillation model and put distil + embed
behind one `IngestProvider` port (ADR-0005). When the time came to land a real provider, that
"one provider" framing ran into a vendor reality: **Anthropic does not currently offer an
embeddings endpoint**. The spike measured retrieval quality against OpenAI's
`text-embedding-3-small` (1536 dim), and the Drizzle schema pins `principle.embedding` to that
dimension (ADR-0005). So a "real Anthropic-backed IngestProvider" can't be Anthropic-only.

A few shapes were possible:

- **Wrap both halves in one class with hardcoded providers.** Simplest, but couples the embed
  choice to the distil choice — a self-hoster who wants Voyage embeddings would have to
  fork the class.
- **Split the port into `Distiller` + `Embedder`.** Cleaner conceptually, but breaks every
  existing test and the `FakeIngestProvider` for no real gain — the ingest pipeline is the only
  caller, and it always needs both halves.
- **Keep one port; inject the embed function as a dependency.** Lets each half evolve
  independently (swap Anthropic for OpenAI, swap OpenAI for Voyage) without changing the port or
  the pipeline. Provenance still belongs to the distiller (the model+prompt is what produced the
  claim; the embedder doesn't change what was said, only how it's indexed for retrieval).

## Decision

**Distill and embed are different vendor concerns served by separate code, composed at the
port boundary.**

- **Distil** — `AnthropicIngestProvider` calls Claude via the official `@anthropic-ai/sdk`,
  using tool-use for a typed `{principles: [{claim, quote}]}` shape rather than free-form JSON
  parsing. Default model is `claude-opus-4-8` per ADR-0008; pinnable per instance.
- **Embed** — `createOpenAIEmbedder` posts to OpenAI's `/v1/embeddings` endpoint. Default model
  is `text-embedding-3-small` at 1536 dim, matching the schema's `EMBEDDING_DIM` pinning so a
  fresh ingest writes vectors the repository accepts without coercion. Returned vectors are
  L2-normalized so cosine search degrades to dot-product (the pgvector + bag-of-words paths
  already assume this).
- **Composition** — `AnthropicIngestProvider` takes the embed function as a constructor
  dependency. This keeps one port (`IngestProvider` in `src/canon/ports.ts`), one place the
  ingest pipeline plugs in, and one place provenance is stamped.
- **Provenance owns the distiller, not the embedder.** Re-embedding a Source under the same
  distil model+prompt is not a new ingest — the Principles and their quotes are unchanged; only
  the embedding vectors are replaced. Provenance stamps `(distilModel, distilModelVersion,
  distilPromptVersion)` only.
- **Self-hosters swap halves independently.** A self-hoster who wants Voyage or local
  embeddings provides their own `embed` function; the distil half (and provenance) is unaffected.
  A self-hoster who wants a different distiller writes their own `IngestProvider` implementation,
  reusing the same embed function.

A small ADR rather than an inline comment because (i) the schema's embedding-dim pinning is now
a load-bearing dependency on OpenAI specifically, and (ii) the "one provider for everything"
framing in ADR-0008 read like a constraint future RALPH iterations were honoring. Spelling out
that the split is intentional saves the next iteration from re-litigating it.

## Considered Options

- **One Anthropic-only IngestProvider** (rejected — Anthropic has no embeddings endpoint, and
  pinning to a non-existent endpoint would either hardcode OpenAI silently or force a manual
  embed step in the pipeline).
- **Split the port into Distiller + Embedder** (rejected — adds two parameters to every
  ingest call site for no caller-visible benefit; the pipeline always needs both).
- **Inject `embed` as a constructor dependency on a composite provider** (chosen — keeps the
  port stable, makes each half independently swappable, and keeps provenance with the half that
  actually owns it).

## Consequences

- A self-hosted instance needs **two** keys when running the recommended defaults: an Anthropic
  key for distil and an OpenAI key for embed. The `.sandcastle/.env` template documents both.
- Changing the embedding model requires both a code change (new `createOpenAIEmbedder` config
  or new embedder) and a schema migration (new `EMBEDDING_DIM`). The schema test asserts the
  current dim so a model swap can't drift silently.
- An instance can ingest different Sources under different distil providers (model-mixed Canon
  per ADR-0008) without touching the embed side — embeddings stay consistent across the Canon
  regardless of which distiller wrote the claim.
- The fake provider (`FakeIngestProvider`) stays unchanged — it implements the whole port with
  a deterministic bag-of-words embed, which is what tests need.
