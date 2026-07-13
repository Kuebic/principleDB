# Coding Standards

Loaded by the reviewer agent during code review (`@.sandcastle/CODING_STANDARDS.md`).
Enforced at review time so it costs no implementation tokens. Grounded in the existing
`src/canon/` + `src/mcp/` code and the ADRs — match what's already there.

## Style

- **Named exports only** — no default exports (matches every module in `src/canon/`, `src/mcp/`).
- ESM throughout (`"type": "module"`); relative imports without file extensions, as the repo does.
- `camelCase` values/functions, `PascalCase` types/interfaces. Types live next to the code that owns them (`types.ts`, or inline in the module).
- Keep adapters thin: input validation in the schema (Zod for tools), the real work in a plain typed function. No business logic in a route handler or tool wrapper.
- Comment the *why*, not the *what*. The house style opens a module with a short header comment stating its job and the ADR it implements — keep that.
- No commented-out code, no `TODO` comments in committed code (RALPH rule).

## Testing

- **TDD / Red-Green-Refactor** — a failing test first, then the implementation (RALPH workflow).
- Tests are colocated as `*.test.ts` next to the source; ports get a `*.contract.ts` contract test exercised by every implementation (see `seen-text-store.contract.ts`, `staging-store.contract.ts`).
- Every public function has at least one test; test names describe the expected behavior.
- Prefer the in-memory repository / fake provider for unit tests; reserve the real Postgres for the integration/contract layer. Never require live network in a unit test.
- `npm run typecheck` and `npm run test` MUST be green before an issue is closed.

## Architecture

- **Shared core is the single home for domain logic** (ADR-0005). `src/canon/` holds the typed functions; the MCP server and the web app are *thin adapters over the same core* — no logic duplicated, no data reshaped in an adapter.
- **Ports + dependency injection.** Side-effecting collaborators (repository, provider, blob store) are passed in via a `deps` object and defined as ports in `ports.ts`. Don't reach for a global client or `process.env` deep in the core.
- **The Drizzle `schema.ts` is the single source of truth** for the data model; migrations are generated (`db:generate`), never hand-written (ADR-0005). Never infer the schema from DB internals.
- **Provenance integrity** (ADR-0007): a displayed Quote is always the Source's own words at the stored span (`source.text.slice(span.start, span.end)`), never the model's reproduced string. A Principle never persists with zero relocating Quotes.

## Web surface (slices W1–W6 — the new adapter)

Review-gate invariants for the public site + remote MCP endpoint (ADR-0015, ADR-0016, #39/#40/#42):

- **Core-direct serving.** Web route handlers call `src/canon/` functions **directly** (e.g. `searchPrinciplesTool`, `quote-in-context`, `related`). The site is **never** an MCP *client* of its own endpoint — that path is for the CI smoke test only.
- **LLM-free public path.** The public search/serve path MUST NOT call an LLM. "Thought → quotes" is one embedding + pgvector; **no prose generation** on the public site (map Out-of-scope). Reject any model call added to a request handler in review.
- **Read-only public MCP surface.** The public `/mcp` registers only `search_principles`, `get_quote_in_context`, `related_principles`. The write tools (`list_review_queue`, `resolve_review_item`) MUST NOT be reachable on the anonymous endpoint.
- **Reuse `SearchHitResponse` verbatim** for the site — no bespoke public response shape in the core (#40, #41).
- **Bound every request** (#42): search `limit` ≤ 50; cap the `get_quote_in_context` window; `statement_timeout` on the serving role; an in-app per-IP rate-limit backstop; a short-TTL query-embedding cache; log IP + user-agent. No unbounded work reachable anonymously.
- **Plain Node + Hono, one co-located process** (ADR-0016). No Workers-only APIs — keep the core portable (Workers is a documented future option). `npm run mcp` (stdio) must keep working; the web surface is additive.
- **Public pages carry `noindex`**, no accounts/login (#39), and the attribution + "shared for study…" + removal-contact **footer** on every public page.
