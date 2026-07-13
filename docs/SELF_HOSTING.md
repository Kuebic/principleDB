# Self-hosting principleDB

A one-time provisioning guide for any new Owner standing up their own instance —
own Postgres, own R2 bucket, own model keys. The end state is an MCP server
running over stdio that your AI client (Claude Desktop, etc.) can talk to.

The agent loop can't do the provisioning for you: every step needs human
console access at a provider. But every step is also small and reversible —
budget about 30 minutes for a fresh setup.

## What you'll have at the end

- A Postgres database (Supabase, or self-hosted) with `pgvector` enabled and
  the principleDB schema applied.
- A Cloudflare R2 bucket holding original Sources (PDFs etc.).
- An `.sandcastle/.env` file holding your Postgres connection, model keys, and
  R2 credentials.
- An MCP server (`npm run mcp`) reachable over stdio JSON-RPC from your AI
  client.

## Quick start

If you already have the prerequisites (Supabase project, R2 bucket, Anthropic
+ OpenAI keys), the short path is:

```bash
cp .sandcastle/.env.example .sandcastle/.env
$EDITOR .sandcastle/.env          # fill in DATABASE_URL + the keys + R2 vars
npm install
npm run db:migrate                # apply the schema
npm run doctor                    # verify env + DB + pgvector
npm run mcp                       # start the server
```

The rest of this file walks the prerequisites in detail.

## 1. Postgres + pgvector

You can use any Postgres ≥ 14 with the `pgvector` extension; the maintained
reference is Supabase.

**Supabase (recommended)**

1. Create a project at <https://supabase.com>. Pick a region close to where
   you run your AI client (round-trip latency dominates ingest cost).
2. Dashboard → **Database → Extensions** → enable `vector`.
3. **Database → Connection string → URI** — copy the *pooler* URL (port
   `6543`). That's `DATABASE_URL`. (The direct URL on port 5432 is only
   needed when applying migrations or running the integration tests against
   an isolated schema.)

**Self-hosted Postgres**

1. Install pgvector: `apt install postgresql-14-pgvector` (or build from
   <https://github.com/pgvector/pgvector>).
2. Create a database and a role. Enable the extension with
   `CREATE EXTENSION vector;` (requires superuser).
3. Set `DATABASE_URL` to the connection string for the new role.

## 2. Cloudflare R2 (blob lake)

The query store holds only the Canon distillate (Sources metadata, Principles,
Quotes, embeddings). Original PDFs/audio go to R2 (ADR-0010). Even tens of GB
of source material costs cents per month at rest.

1. Cloudflare dashboard → **R2 → Create bucket**. Any name; `principledb` is
   the default in the env template.
2. **R2 → Manage API tokens** → create a token with **Object Read & Write**
   on that bucket. Save the Access Key ID + Secret Access Key.
3. From the same panel, note the **account ID** and the **S3 API endpoint**
   (`https://<account_id>.r2.cloudflarestorage.com`).

R2 is the only piece of the stack that doesn't have an obvious open-source
swap. If you'd rather use S3 or MinIO, the blob-store port in
`src/canon/blob-store.ts` is small — implementing it against another backend
is a future hook, not a fork.

## 3. Provider API keys

Ingest is split between two vendors so each port can use the best-in-class
model for its job (ADR-0011):

- **Anthropic** (`ANTHROPIC_API_KEY`) — distillation. The default model is
  **`claude-opus-4-8`**. Override with `PRINCIPLEDB_DISTIL_MODEL=<any Claude
  model id>` to trade fidelity for cost. Key from
  <https://console.anthropic.com>. A Claude Code subscription token
  (`CLAUDE_CODE_OAUTH_TOKEN`) also works in place of the API key, **but only
  reaches Haiku over the API**: direct API calls to `claude-opus-4-8` /
  `claude-sonnet-4-6` on a subscription token return an immediate
  `rate_limit_error` — an entitlement gate, not real throttling (the 429 carries
  no `retry-after` / `anthropic-ratelimit-*` headers), so `PRINCIPLEDB_MAX_RETRIES`
  cannot ride it out. On a subscription token, set
  `PRINCIPLEDB_DISTIL_MODEL=claude-haiku-4-5` (the confirm model already defaults
  to Haiku). For Opus/Sonnet-quality ingest over the API, use a pay-as-you-go
  `ANTHROPIC_API_KEY` (it takes priority when both are set); a genuine transient
  `429` under load is still rideable via `PRINCIPLEDB_MAX_RETRIES=<n>` (SDK
  default 2). Opus/Sonnet *are* reachable on the subscription through the Claude
  Code agent runtime, but that is a separate path from this direct-API ingest.
  - **Dedup confirm model.** The dedup "same claim?" judgment runs on a
    separate, cheaper model by default: **`claude-haiku-4-5`**. It is a
    narrow binary judgment with a 512-token cap, so the Opus premium is not
    worth the rate-limit cost. Override with
    `PRINCIPLEDB_CONFIRM_MODEL=claude-opus-4-8` (or any Claude model id) to
    pin the confirm back to Opus if your instance's false-merge rate is too
    high on Haiku — trades cost for caution. The confirm model is stamped on
    every `dedup_decision` row so the audit trail remains honest across
    model changes; it is **not** part of the distil provenance tuple, so
    flipping it does not invalidate previously-distilled Principles.
- **OpenAI** (`OPENAI_API_KEY`) — embeddings. The default is
  **`text-embedding-3-small`** at 1536 dim, pinned to match the schema's
  `EMBEDDING_DIM`. Key from <https://platform.openai.com/api-keys>.

> Changing the embed model requires a schema migration to repin
> `EMBEDDING_DIM`. Don't do it casually — you'll re-embed every Principle.

## 4. Wire the env

```bash
cp .sandcastle/.env.example .sandcastle/.env
$EDITOR .sandcastle/.env
```

Required for the MCP server to start:

- `DATABASE_URL`
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`

Required for PDF ingest (so set them now even if you're starting with
text-only Sources):

- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`,
  `R2_ENDPOINT`

If any of the three required vars are missing, the MCP server exits with a
single error listing every missing one.

## 5. Apply the schema

```bash
npm install
npm run db:migrate
```

This runs every Drizzle migration in `drizzle/` in order. The migrator records
applied migrations in `__drizzle_migrations`, so re-running is a no-op.

If pgvector isn't enabled yet, the first migration's `CREATE EXTENSION` will
fail with `permission denied`. Fix that in your Postgres console (Supabase →
Database → Extensions, or `CREATE EXTENSION vector;` as superuser) and re-run
`npm run db:migrate`.

## 6. Verify

```bash
npm run doctor
```

The doctor prints a green/red checklist:

- `DATABASE_URL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` — present?
- `R2 …` — warn if unset (server boots without it; PDF ingest needs it).
- `model configuration` — which distil + embed models will be used.
- `postgres connectivity` — can we open a connection?
- `pgvector extension` — is the extension enabled in the target database?
- `schema tables` — are all five required tables present?

Exit code is `0` if everything green or warn, `1` if anything is `fail`. Wire
it into a deploy or container healthcheck if you want failed setups to crash
loud instead of silent.

## 7. Connect to your AI client

The server binds to stdio (JSON-RPC). Configure your client with a command
that runs it. For Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "principledb": {
      "command": "npx",
      "args": ["tsx", "/abs/path/to/principledb/bin/principledb-mcp.ts"],
      "env": {
        "DATABASE_URL": "...",
        "ANTHROPIC_API_KEY": "...",
        "OPENAI_API_KEY": "..."
      }
    }
  }
}
```

Once connected, the client advertises a set of Canon tools:

- `search_principles` — atomic Principle search with snapped Quotes + derived
  labels (page / timecode / heading).
- `get_quote_in_context` — open a Quote with surrounding context for jump-to.
- `related_principles` — live relatedness over the embedding space (issue #7).
- `list_review_queue`, `resolve_review_item` — the human-in-the-loop Review
  surface (issue #6).

To smoke-test the wiring without a client: ask Claude Desktop "what tools do
you have available?" and confirm the above appear.

## 8. (Planned) Run the public web + remote MCP surface

> **Status: planned, not yet shipped** (ADR-0016, map #37). The stdio MCP server
> above is the baseline every Owner runs today. The public surface below is an
> *optional* additional adapter over the same core — documented here so you know
> what's coming; the steps land when the web slices are built.

Everything above binds the Canon to **stdio** for your own AI client. The optional
public surface adds a second entry point on the *same* one-process Node server
(ADR-0015): a website where anyone with the link can type a thought and get
connected Quotes (LLM-free — one embedding + pgvector, #40), plus a public remote
MCP endpoint at `POST /mcp` (read-only tools) that others can connect their own AI
to. It is opt-in: run it only if you want a public face.

- **Same runtime, same env.** Plain Node (ADR-0016) — no Cloudflare account or
  rewrite required. The planned `npm run serve` boots the Hono server that mounts
  both the site routes and `/mcp`; `npm run mcp` (stdio) keeps working unchanged.
- **Hosting.** Any always-on box: Fly.io (recommended, ~$3-4/mo, managed TLS),
  a VPS (Hetzner), or your own box behind a Cloudflare Tunnel ($0, uptime tied to
  the box). Put Cloudflare in front for per-IP rate limiting.
- **Exposure.** The public MCP endpoint exposes only the read tools; the write
  tools (`list_review_queue`, `resolve_review_item`) stay off the anonymous
  surface. See the map (#37) for the exposure/copyright stance.

## Portability

Core data is standard Postgres — `pg_dump` is your exit ramp:

```bash
pg_dump "$DATABASE_URL" --no-owner --no-acl > principledb.sql
```

The dump restores cleanly into any Postgres ≥ 14 with `pgvector` enabled.
Nothing about the data model is Supabase-specific.

R2 is S3 API-compatible, so `rclone` or `mc` can mirror the bucket to S3,
MinIO, or any other S3-API store:

```bash
rclone copy r2-source:principledb s3-target:principledb
```

## Troubleshooting

| Symptom                                                  | Likely cause                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `principleDB needs DATABASE_URL + …`                     | Env var missing. Re-check `.sandcastle/.env`.                                         |
| `npm run db:migrate` → `extension "vector" does not exist` | pgvector not installed. Enable in Supabase UI or `CREATE EXTENSION vector;`.           |
| `doctor` → `missing source, principle, …`                | Migrations not applied. Run `npm run db:migrate`.                                     |
| `doctor` → `pgvector extension: missing`                 | Extension exists in another schema. Set the role's `search_path` to include it.       |
| PDF ingest → `R2 endpoint refused`                       | R2 endpoint URL mistyped. It is `https://<account_id>.r2.cloudflarestorage.com`, no `/`. |
| AI client doesn't see the tools                          | Restart the client. Check the command path in `claude_desktop_config.json` is absolute. |
