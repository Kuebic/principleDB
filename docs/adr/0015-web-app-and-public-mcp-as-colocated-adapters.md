# 15. Web app and public MCP endpoint are co-located adapters over the shared core

Date: 2026-07-13

## Status

Accepted

Extends [ADR-0005](0005-mcp-server-over-two-tier-store.md) (which reserved the
"any later app is *another* adapter over the *same* core" shape but left the app's
concrete path and topology open).

## Context

The wayfinder map (issue #37) plans a public website over the Canon: type a thought
→ get grounded Quotes, a quote-in-context reader, and a "connect your own AI" page
backed by a public remote MCP endpoint. ADR-0005 said the app is another adapter over
the shared core in `src/canon/`, but not *how* the browser app reaches the Canon:
directly through the core, or as a client of the same public MCP endpoint that
external AI clients use (issue #41). The 2026-07-11 research doc
(`docs/research/2026-07-11-web-interface-over-mcp.md`) found that a "thought → quotes"
query is one embedding + a pgvector search (no LLM, no MCP hop needed), that adding a
Streamable HTTP MCP transport is a ~40-line additive change to the existing stdio
server, and that the same Node process can serve both surfaces.

## Decision

**Serving path — core-direct.** The website backend imports the shared core
(`searchPrinciplesTool`, `quote-in-context`, `related`) from `src/canon/` and calls it
in-process. MCP is *not* on the site's data path. This is the pattern ADR-0005
reserved; the MCP tool wrappers add only JSON-RPC framing, so serving through them
would cost a serialization hop, lose the TypeScript return types, and rate-limit the
site against the anonymous-abuse bucket.

**Topology — one process, two adapters.** A single Node/HTTP server (Express or Hono)
mounts both the website routes and `POST /mcp`, both over the same core. One deployable,
one origin, one rate-limit config. The concrete host (Hetzner / Fly / Tunnel / Workers)
is decided separately in issue #44; this ADR only fixes that it is a single co-located
process, not two services.

**Public MCP surface — read-only, the three existing read tools.** The anonymous
endpoint registers exactly `search_principles`, `get_quote_in_context`, and
`related_principles`. The write tools (`list_review_queue`, `resolve_review_item`) stay
off the public surface (a tool-registration flag on the MCP adapter), remaining on
stdio or behind a bearer token. Adding OpenAI-compatible `search`/`fetch` alias tools
for ChatGPT citability is a deliberate future extension tracked with the "connect your
AI" page, not part of this decision.

**Dogfooding — smoke-test client, never the data path.** A CI/deployed smoke test uses
the SDK `Client` + `StreamableHTTPClientTransport` against the running endpoint to
assert the public contract works in a real client. This is the only place an MCP
*client* appears; it never serves the site.

## Considered Options

- **Web backend as an MCP client of the public endpoint** — dogfooding value, but a
  serialization hop, lost types, and self-inflicted rate-limiting on the site's own
  data path. Rejected as the serving path; kept only as the smoke test.
- **Two separate deployables (site service + MCP service)** — buys nothing at v1
  (single Owner, unlisted-public, one origin) and costs a second deploy, cert, and
  rate-limit config. Rejected.
- **Deciding the `search`/`fetch` aliases and the host here** — out of scope; they are
  a different axis (external citability / ops) tracked in #37 and #44.

## Consequences

- The site process must be able to import `src/canon/`, i.e. a Node/TS backend sharing
  the package boundary with the core. Already true.
- Issue #44 (hosting) inherits a fixed constraint: it is choosing a home for **one
  co-located Node process** serving both adapters, not for a split deployment.
- The public read-only surface is exactly three tools *as of this decision*; adding
  alias tools later is an explicit, tracked extension rather than an accident.
- The smoke test is written against SDK v1.29 **stateless** mode (the shape closest to
  the coming spec); the MCP spec 2026-07-28 revision is breaking, so expect one
  migration to touch both the transport and this test.
