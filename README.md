# principleDB

A self-hostable MCP server that turns a body of teaching (books, sermons, speeches) into
atomic **Principles**, each backed by verbatim **Quotes** located to the character in their
**Source**. You query it from your own AI client; it answers with the source's own words and
a link to the exact spot, never a paraphrase.

The reference instance holds one church's teaching corpus. The code is corpus-agnostic:
anything you can ingest as text, HTML or PDF.

## What it is, technically

- **Runtime:** TypeScript on Node, Hono for HTTP, Drizzle over Postgres 14+ with `pgvector`.
  One process serves three surfaces: an MCP server over stdio for the owner's AI client, a
  read-only remote MCP endpoint at `POST /mcp` (Streamable HTTP), and a small website where
  anyone with the link types a thought and gets connected Quotes.
- **Serving is LLM-free:** a query is one embedding plus a pgvector search. The web host is
  CPU-light and needs no GPU or model key at request time.
- **Ingest pipeline:** PDF to text via Marker, page-at-a-time distillation into Principles
  with an LLM, then conservative cross-source dedup (vector prefilter, LLM confirm, run in
  parallel on a cheap model). Every Quote is relocated as a span in the Source; a quote that
  will not locate goes to a human Review queue instead of into the Canon.
- **Public surface is deliberately read-only.** The anonymous `/mcp` exposes three read
  tools and nothing that writes; the Review tools exist only on the owner's stdio server.
  Per-IP token-bucket rate limiting and an embedding cache are in-app.
- **Deploy:** Docker Compose behind an existing Caddy reverse proxy (no host ports
  published), push-to-main GitHub Actions job that SSHes to the box and rebuilds. Secrets
  live in `.env` and the Actions secret store; nothing in the repo.
- **Tests:** vitest, 69 test files alongside the code.

## How it was built

Spec first, then an agent loop. `CONTEXT.md` holds the domain model and glossary; 18
architecture decision records in `docs/adr/` record every design choice with the options
rejected. About a third of the commits came from an issue-driven coding-agent loop
([Sandcastle](https://github.com/mattpocock/sandcastle)) working against those documents;
the rest are hand-written or pair-written with Claude Code. If you want to see how a
decision was reasoned through, start with:

- [ADR-0005](docs/adr/0005-mcp-server-over-two-tier-store.md): why an MCP server over a
  two-tier store, and why no app of its own.
- [ADR-0007](docs/adr/0007-quotes-are-relocated-source-spans.md): why quotes are located
  spans and not model output.
- [ADR-0012](docs/adr/0012-conservative-dedup-cross-source-vector-prefilter-llm-confirm.md)
  and [ADR-0013](docs/adr/0013-dedup-throughput-parallel-confirm-haiku-asymmetric-banding.md):
  dedup correctness, then dedup cost and throughput.
- [ADR-0015](docs/adr/0015-web-app-and-public-mcp-as-colocated-adapters.md) and
  [ADR-0016](docs/adr/0016-host-web-and-mcp-on-plain-node-with-hono.md): the public
  surface and where it runs.

## Run it

See [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md). Short version:

```bash
cp .sandcastle/.env.example .sandcastle/.env   # Postgres URL, model keys, R2 vars
npm install
npm run db:migrate
npm run doctor        # checks env, DB, pgvector
npm run mcp           # stdio MCP server for your AI client
npm run serve         # optional: website + read-only /mcp on :3000
```

## Layout

- `src/canon/` the shared core: ingest, distil, dedup, search, quote location
- `bin/` entry points: `principledb-mcp`, `principledb-serve`, ingest and migrate commands
- `docs/adr/` decisions; `docs/SELF_HOSTING.md` provisioning; `CONTEXT.md` domain model
- `.sandcastle/` the agent-loop configuration and prompts
