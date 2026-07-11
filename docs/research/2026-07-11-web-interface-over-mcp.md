# Web interface + public remote endpoint over the principleDB MCP server

Date: 2026-07-11. Researched against live primary sources (all URLs below were fetched
today unless flagged UNVERIFIED). Grounding: `CONTEXT.md`, ADR-0005.

## TL;DR recommendations

- **Website architecture: pattern (a)** — the web backend calls the shared core in
  `src/canon/` directly. This is literally the pattern ADR-0005 reserved ("any later app
  is *another* adapter over the *same* core"). The "type a thought → quotes" flow is one
  OpenAI embedding call (~$0.0000004 per query) + pgvector search — no LLM, no MCP hop,
  no per-visitor token cost. MCP stays the surface for *AI clients*, not for the site.
- **Hosting: least work is plain Node.** The existing code (node `pg` → Supabase session
  pooler, `aws4fetch` → R2) runs unchanged; adding Streamable HTTP is ~40 lines of
  Express + `StreamableHTTPServerTransport` (already in the pinned SDK `^1.29.0`).
  Cheapest credible homes: Hetzner CX22 (€3.79/mo, 2 vCPU/4 GB), Fly.io (~$2–4/mo), or
  the owner's own box + Cloudflare Tunnel (free). The Cloudflare Workers path is elegant
  ($5/mo, Hyperdrive + native R2) but is a real port, not a lift-and-shift.
- **Auth story: start anonymous + read-only + rate-limited.** The MCP spec makes auth
  OPTIONAL; every major client (claude.ai, Claude Code, ChatGPT dev mode, Cursor) can
  connect to a no-auth Streamable HTTP URL. Expose only the read tools
  (`search_principles`, `get_quote_in_context`, `related_principles`) on the public
  endpoint — keep review/ingest tools on stdio or behind a bearer token. Put Cloudflare
  in front for per-IP rate limiting. OAuth 2.1 can be added later without breaking
  clients (401 + RFC 9728 metadata is the upgrade path).
- **Timing caveat:** MCP spec 2026-07-28 (a breaking "stateless core" revision) finalizes
  in ~2.5 weeks; TS SDK v2 is in beta for it. Build on v1.29 **stateless** mode now —
  it's the closest shape to the new spec — and expect one migration later.

---

## 1. Remote MCP transport today

**Current stable spec: 2025-11-25.** It defines exactly two standard transports: stdio
and **Streamable HTTP** ([spec: transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)).
Streamable HTTP = a single endpoint (e.g. `/mcp`) accepting POST (client→server JSON-RPC;
response is either `application/json` or an SSE stream) and optionally GET (server-push
SSE). Sessions are optional: a server MAY issue `MCP-Session-Id` at initialize; if it
doesn't, every request is standalone. Servers MUST validate the `Origin` header (DNS
rebinding), and clients MUST send `MCP-Protocol-Version` on each request.

**SSE deprecation:** the old two-endpoint HTTP+SSE transport (protocol 2024-11-05) is
formally **deprecated**, replaced by Streamable HTTP since spec 2025-03-26. The spec has
a backwards-compat recipe (clients POST first, fall back to GET/`endpoint` event), but
new servers need only Streamable HTTP. Within Streamable HTTP, SSE is just an optional
response encoding — a pure request/response server never opens a stream.

**What's coming: spec 2026-07-28 (release candidate).** The largest revision since
launch: removes the `initialize` handshake and `Mcp-Session-Id` entirely (protocol
metadata moves to `_meta` on every request), adds required `Mcp-Method`/`Mcp-Name`
routing headers, response `ttlMs`/`cacheScope`, and a 12-month deprecate-before-remove
lifecycle policy. Final release July 28, 2026; existing servers face breaking transport
changes eventually ([RC announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/),
[2026 roadmap](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/)).

**TypeScript SDK.** This repo pins `@modelcontextprotocol/sdk ^1.29.0`; v1.29.0 is the
latest v1 release (Mar 2026). The SDK `main` is a **v2 beta** implementing the
2026-07-28 RC, split into `@modelcontextprotocol/node|express|hono` packages
([typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)). v1 ships
`StreamableHTTPServerTransport` with two modes
([v1.29.0 README](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/README.md)):

- **Stateful:** pass `sessionIdGenerator: () => randomUUID()`; keep a
  `Map<sessionId, transport>`; supports resumability and server-push.
- **Stateless:** `sessionIdGenerator: undefined`; create a fresh server + transport per
  POST request, call `server.connect(transport)` then `transport.handleRequest(req, res, req.body)`.
  No session store, horizontally scalable, GET/DELETE return 405. Right fit for
  principleDB's pure request/response tools, and the mode closest to the 2026-07-28 shape.

Options cover the spec's security notes: `enableDnsRebindingProtection`, `allowedHosts`,
`allowedOrigins`. `SSEServerTransport` still exists but is deprecated
("backwards-compatibility testing only").

**Converting this repo's stdio server:** `src/mcp/server.ts` already separates
`createPrincipleDbServer(deps): McpServer` from `runStdio`. Conversion is additive: a new
entry point (Express or Hono) with a `POST /mcp` route that instantiates
`createPrincipleDbServer(deps)` + a stateless transport per request. Tool registrations,
zod schemas, and the canon core are untouched. One design choice: the public entry can
register only the three read tools (or take a flag), leaving
`list_review_queue`/`resolve_review_item` off the anonymous surface.

## 2. Auth for a public read-only MCP endpoint

**Spec:** authorization is **OPTIONAL** ([spec: authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)).
When implemented it's OAuth 2.1: the MCP server is a resource server that MUST serve
Protected Resource Metadata (RFC 9728, via `WWW-Authenticate` on 401 or
`/.well-known/oauth-protected-resource`), pointing at an authorization server; clients
discover it, register via Client ID Metadata Documents (preferred) or Dynamic Client
Registration, do PKCE, and send `Authorization: Bearer …` on every request. Nothing in
the spec forbids an unauthenticated server — it just says servers "SHOULD implement
proper authentication" in the transport security notes. A static API key is *not* a
spec-defined mechanism; it rides on clients that allow custom headers.

**What real public servers do:** all three patterns exist.
- *Fully anonymous:* Cloudflare's official template is literally named
  `remote-mcp-authless` ([guide](https://developers.cloudflare.com/agents/guides/remote-mcp-server/));
  many public read-only servers (docs/search-style) run this way.
- *Static bearer/API key:* works in Claude Code (`--header "Authorization: Bearer …"`),
  Cursor (`headers` in mcp.json), and ChatGPT dev mode — but **not** claude.ai custom
  connectors, which offer only a URL + optional OAuth client ID/secret, no custom
  headers ([Claude help](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)).
  So an API-key-only endpoint excludes claude.ai/Claude Desktop users.
- *OAuth:* the maximal option; Cloudflare ships an OAuth provider + Access/GitHub/Auth0
  integrations. Overkill for a public read-only corpus in v1.

**Client auth support summary:** claude.ai/Desktop custom connectors: no-auth or OAuth.
Claude Code: no-auth, OAuth (`/mcp` login flow), or custom headers. ChatGPT dev mode:
"No Authentication", OAuth (CIMD, DCR), or mixed
([OpenAI dev mode guide](https://developers.openai.com/api/docs/guides/developer-mode)).
Cursor: headers, env interpolation, OAuth ([Cursor MCP docs](https://cursor.com/docs/context/mcp)).

**Rate-limiting / abuse patterns for anonymous endpoints.** The ecosystem consensus
(e.g. [Zuplo: "Never ship an MCP server without a rate limit"](https://zuplo.com/blog/never-ship-mcp-server-without-rate-limit),
[Fastio guide](https://fast.io/resources/mcp-server-rate-limiting/)): most public MCP
servers ship with no limit; agent retry loops are the failure mode (one reported runaway
did ~127k calls / ~$47k in 8 hours). Practical pattern for principleDB:
- Per-IP token bucket at the edge (Cloudflare's WAF/rate-limiting rules are free in
  front of any origin, incl. a Tunnel) plus an in-app limit per session/IP.
- Keep the surface read-only and bound the work: `limit` is already capped at 50 in the
  tool schema; cap quote-context window size too.
- The only per-call marginal cost is one OpenAI embedding (~$0.02/M tokens), so the
  budget blast radius is small; the DB is the thing to protect (statement timeouts,
  pooler).
- Log tool calls with IP/user-agent; add a bearer-token "owner mode" later for the
  write tools rather than gating reads.

## 3. How end users connect their own AI (the "connect your AI" page)

All of these need the server reachable on the public internet (claude.ai's calls
originate from Anthropic's servers, not the user's machine).

- **claude.ai (web) + Claude Desktop** — Settings → **Connectors** → "Add custom
  connector" → paste `https://principledb.example.com/mcp` → Add (OAuth client ID/secret
  only under Advanced, optional). Available on **Free, Pro, Max, Team, Enterprise**;
  Free is limited to one custom connector. Feature is labeled beta.
  ([Get started with custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)).
- **Claude Code** — `claude mcp add --transport http principledb https://principledb.example.com/mcp`
  (add `--header "Authorization: Bearer …"` if we ever require a token; `--scope user`
  to make it available in all projects; `/mcp` in-app handles OAuth logins). In
  `.mcp.json` the `type` field is `"http"` (alias `"streamable-http"` accepted)
  ([Claude Code MCP docs](https://code.claude.com/docs/en/mcp)).
- **Claude Desktop (local alternative)** — the existing stdio wrapper keeps working via
  `claude_desktop_config.json`; that's a separate mechanism from remote connectors.
- **ChatGPT** — Settings → toggle **Developer mode** (Plus, Pro, Business, Enterprise,
  Edu; web only) → add an app with the server URL; SSE and Streamable HTTP both
  supported; auth may be "None"; **dev mode does not require `search`/`fetch` tools**
  and write tools prompt for confirmation
  ([dev mode guide](https://developers.openai.com/api/docs/guides/developer-mode),
  [help article](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)).
  For non-dev surfaces (connectors-now-"apps" for everyone, deep research, company
  knowledge) the server must expose `search(query) → {results:[{id,title,url}]}` and
  `fetch(id) → {id,title,text,url,metadata?}` per OpenAI's compatibility schema
  ([Building MCP servers for ChatGPT](https://developers.openai.com/api/docs/mcp)).
  Worth adding thin `search`/`fetch` aliases over the canon core — cheap, and it makes
  principleDB citable inside ChatGPT deep research.
- **Cursor** — `~/.cursor/mcp.json`:
  `{"mcpServers":{"principledb":{"url":"https://principledb.example.com/mcp"}}}`;
  optional `headers`; also one-click "Add to Cursor" deeplinks
  ([Cursor MCP docs](https://cursor.com/docs/context/mcp)).
- **Anything stdio-only** — the community `mcp-remote` npm shim proxies a remote URL to
  stdio. UNVERIFIED today (widely referenced; I did not fetch its docs this session).
- **Programmatic (no client at all)** — Anthropic Messages API MCP connector, see §5c.

## 4. Hosting options

### A. Cloudflare Workers

- **Server shape:** three options — `createMcpHandler()` (stateless, no Durable
  Objects), `McpAgent` (stateful, requires Durable Objects), or raw transport
  ([CF remote MCP guide](https://developers.cloudflare.com/agents/guides/remote-mcp-server/)).
  Streamable HTTP at `/mcp`, legacy `/sse` also supported. `remote-mcp-authless`
  template exists; OAuth addable via Cloudflare's providers (GitHub, Auth0, WorkOS…).
- **Postgres:** node-postgres (`pg` ≥ 8.16.3 — repo has ^8.22.0) works on Workers with
  the `nodejs_compat` flag; Cloudflare recommends **Hyperdrive** for Supabase using the
  *direct* connection string ("Hyperdrive will perform pooling"), i.e. it replaces the
  session pooler ([Hyperdrive + Supabase](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/)).
  Hyperdrive is included in Workers Free and Paid at no extra charge
  ([Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/)).
- **R2:** native bindings replace `aws4fetch`+S3-API (though aws4fetch itself was built
  for Workers and would keep working — smaller diff if kept).
- **Rewriting needed:** new Worker entry (fetch handler, env bindings instead of
  process.env), Hyperdrive binding threaded into the Drizzle/pg client, drop any
  Node-only APIs, wrangler config, separate build. The canon core is plain TS and mostly
  ports over; but it's a port with new failure modes (CPU-time limits on long
  ingest paths — those should stay off-Workers anyway).
- **Cost:** Workers Paid $5/mo (10M req, 30M CPU-ms) — free tier may even suffice for
  reads ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)).

### B. Plain Node (recommended for least work)

Effectively zero code change: same process serves Streamable HTTP (Express/Hono +
`StreamableHTTPServerTransport`) and the website backend, `pg` keeps talking to the
Supabase session pooler, `aws4fetch` keeps signing R2.

- **Hetzner VPS:** CX22 €3.79/mo, 2 vCPU / 4 GB / 20 TB traffic
  ([hetzner.com/cloud](https://www.hetzner.com/cloud)) — most headroom per euro; you own
  the ops (updates, systemd, TLS via Caddy or a fronting Cloudflare proxy).
- **Fly.io:** shared-cpu-1x 256 MB ≈ $2/mo always-on (512 MB is safer for Node, ~$3–4)
  ([Fly pricing](https://fly.io/docs/about/pricing/)); managed TLS/anycast, deploy from
  Dockerfile; no meaningful free tier anymore.
- **Railway:** Hobby $5/mo including $5 usage; per-second usage billing beyond that
  ([Railway plans](https://docs.railway.com/pricing/plans)); nicest DX, least
  predictable bill.
- **Owner's own box + Cloudflare Tunnel:** `cloudflared` makes an outbound-only
  connection; public hostname + TLS + DDoS/WAF at the edge, tunnels free/unmetered
  ([Tunnel docs](https://developers.cloudflare.com/tunnel/)). $0/mo; availability tied
  to the home box — fine for a beta, weak for "anyone, anytime".

**Ops tradeoff summary:** Workers = no servers, per-request scale, but a code port + two
runtimes to maintain (stdio ingest CLI still needs Node). Plain Node = one runtime, one
deployable, boring ops; pick Hetzner for headroom, Fly for lowest-touch, Tunnel for $0.

## 5. Web frontend patterns over an MCP server

- **(a) Backend → shared core directly. Recommended.** ADR-0005 explicitly planned
  this: "domain logic lives in a shared core… any later app is *another* adapter over
  the *same* core — no logic duplicated." The site's search route calls the same
  functions as `search-principles-tool.ts`; quote-in-context view calls
  `quote-in-context.ts`. Deterministic, no tokens per visitor beyond one embedding, no
  MCP client complexity, and it can run in the same process as the HTTP MCP endpoint.
- **(b) Backend as MCP client of the public endpoint.** Dogfooding value only. Adds a
  serialization hop, loses TypeScript types (tool results come back as JSON text),
  and rate-limits your own site alongside anonymous agents. Worth doing as a *smoke
  test* in CI (SDK `Client` + `StreamableHTTPClientTransport`), not as the site's data
  path.
- **(c) LLM-in-the-loop.** The Anthropic Messages API **MCP connector** lets a backend
  attach `mcp_servers: [{type:"url", url, authorization_token?}]` + an `mcp_toolset` to
  a Messages call (beta header `mcp-client-2025-11-20`; Streamable HTTP and SSE; only
  tool calls supported; server must be public HTTPS)
  ([MCP connector docs](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector)).
  This is the right shape for a future *conversational* page (the connection-engine
  experience), but for an anonymous public site every visitor query costs model tokens
  (even a small model = ~$0.001–0.01+/query at 2026 prices) and creates a prompt-injection
  /abuse surface — needs CAPTCHA/Turnstile + strict per-IP budgets. Not for v1 public.
- **Key simplification:** "type a thought → relevant quotes with sources" needs **no
  LLM at all** — embed the thought with `text-embedding-3-small` (**$0.02 per 1M
  tokens**, i.e. ~$0.0000004 for a 20-token thought; batch $0.01/M)
  ([model page](https://developers.openai.com/api/docs/models/text-embedding-3-small))
  and run the existing pgvector search. 50k visitor queries ≈ $0.02 of embeddings.

## 6. Quote-in-context viewing

- **Custom viewer over the stored text (recommended).** Sources are already stored as
  continuous text with char-offset locators — the server knows the *exact* span, so a
  route like `/quote/:id` can render the surrounding window with
  `<mark id="quote">…</mark>` + `scrollIntoView`, styled via CSS. 100% reliable (no
  fuzzy re-matching), works for every Source type, and reuses
  `src/canon/quote-in-context.ts` + `derive-label.ts` for the page/timestamp label.
  This is the same product surface as the planned read-only share pages.
- **Text fragments (`#:~:text=`)** are the standard for open-in-new-tab deep links:
  `https://site/page#:~:text=prefix-,start,end,-suffix`, case-insensitive, highlights
  via the browser (stylable with `::target-text`)
  ([MDN](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment/Text_fragments)).
  Limitations: silent no-op if the text doesn't match, user-initiated navigations only,
  components can't cross block-element boundaries, sites can opt out
  (`Document-Policy: force-load-at-top`). Useful as a *bonus* on the custom viewer
  (shareable links that highlight even without JS) and for linking out to external HTML
  copies of a Source; not reliable enough to be the primary mechanism. MDN's page does
  not list exact 2026 browser versions — "all modern engines support it" is UNVERIFIED
  beyond MDN's compat table existing.
- **PDF.js** viewer supports `#page=N`, `#zoom=`, `#nameddest=` for deep links into the
  original R2 PDFs; it does **not** document a span-highlight URL param
  ([Viewer options wiki](https://github.com/mozilla/pdf.js/wiki/Viewer-options)) —
  `#search=` phrase highlighting exists in some builds but is undocumented/UNVERIFIED.
  So: "view original PDF at page N" is a good secondary link (locator already stores
  R2 key + page); the highlighted reading experience stays in the custom text viewer.

## Not verified this session

- `mcp-remote` shim details (§3) and PDF.js `#search=` behavior (§6).
- Exact free-plan viability of Workers for this workload (pricing page fetched via
  search summary, not exhaustively read).
- Claude Desktop's exact remote-connector menu path (help article covers claude.ai;
  Desktop is listed as supported but steps weren't shown).
