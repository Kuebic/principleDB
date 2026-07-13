# 16. Host the web app and remote MCP endpoint on plain Node with Hono

Date: 2026-07-13

## Status

Accepted

Builds on [ADR-0005](0005-mcp-server-over-two-tier-store.md) (shared core; app is
another adapter) and [ADR-0015](0015-web-app-and-public-mcp-as-colocated-adapters.md)
(one co-located process serves both adapters; serving is core-direct and, per #40,
LLM-free). This ADR fixes the runtime, web framework, and deployment shape (issue #44).

## Context

The map (#37) adds a public website + a public remote MCP endpoint over the Canon.
ADR-0015 fixed that both are one co-located process over `src/canon/`; #40 fixed that
serving is LLM-free (embedding + pgvector), so the web host is CPU-light and needs no
GPU. The remaining question is *where and on what* that process runs. Two forces the
research doc (`docs/research/2026-07-11-web-interface-over-mcp.md`) weighed lightly:
the **ingest path stays Node** (Marker/PDF, long-CPU distil+dedup — off the web host,
but it means Node doesn't go away), and `SELF_HOSTING.md` promises **any Owner can run
their own instance on any box in ~30 minutes**. Both push against a runtime that only
some Owners can operate.

## Decision

**Runtime — plain Node.** The existing process (Node ESM via tsx, `pg` → Supabase
session pooler, `aws4fetch` → R2) runs unchanged; adding Streamable HTTP + the site
routes is additive. One runtime for serving, ingest, and CLIs.

**Web framework — Hono.** A single Hono app mounts the site routes and `POST /mcp`
(stateless `StreamableHTTPServerTransport`, read-only tool surface per ADR-0015). Hono
is native ESM, runs on Node today via `@hono/node-server`, keeps a future Cloudflare
Workers move cheap (Hono runs on Workers unchanged), and aligns with the MCP SDK v2
migration (which ships a `@modelcontextprotocol/hono` package for the 2026-07-28 spec).

**Deployment — Fly.io recommended, reversible.** The Owner's public instance runs
always-on on Fly.io (shared-cpu, managed TLS/anycast, Dockerfile deploy, ~$3-4/mo),
with **Cloudflare in front** for per-IP rate limiting (the #42 abuse control). The host
is a deploy target, not code — this ADR *recommends* Fly but does not bind it; Hetzner
(more headroom, self-owned ops) or own-box + Cloudflare Tunnel ($0, weaker uptime) are
swappable without code change.

**Self-hosting — optional serve mode.** The web/MCP-HTTP surface ships as an optional
`npm run serve` alongside the existing `npm run mcp` (stdio), same one-process Node
server over the same core. stdio MCP stays the baseline every Owner gets; the public
web surface is opt-in and documented in `SELF_HOSTING.md`.

## Considered Options

- **Cloudflare Workers.** Elegant ($5/mo, Hyperdrive pooling, native R2 bindings), but
  a real port (fetch-handler entry, env bindings, wrangler, separate build) that
  *adds* a second runtime — ingest must stay Node regardless — and raises the
  self-hoster barrier to a Cloudflare account + wrangler + Hyperdrive. Solves a
  per-request-scale problem an unlisted-public single-Owner beta does not have.
  Rejected for v1; kept as a documented future option.
- **Express.** Works, but heavier, not ESM-first, and not on the SDK v2 package path.
  Rejected in favour of Hono.
- **Own-box + Cloudflare Tunnel as the primary host.** $0, but availability tied to a
  home box contradicts #39's "anyone, anytime." Fine as a fallback, not the default.

## Consequences

- One runtime, one deployable, boring ops; the same artifact serves site + MCP + can be
  run by any self-hoster.
- A future Workers move is a reframed entry point (Hono → Workers) + Hyperdrive wiring,
  not a rewrite — the framework choice preserves that exit.
- `SELF_HOSTING.md` gains an optional "run the public web + remote MCP surface" section;
  the stdio quick-start is unchanged.
- Rate limiting lives at the Cloudflare edge in front of the origin (per #42), so the
  app stays free of a bespoke limiter for v1; the origin protects the DB (statement
  timeouts, pooler).
- The MCP HTTP transport is built on SDK v1.29 stateless mode; the 2026-07-28 spec is
  breaking, and the Hono choice is partly to smooth that migration (ADR-0015 flags it).
