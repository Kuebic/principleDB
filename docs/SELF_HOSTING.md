# Self-hosting principleDB

This is the HITL provisioning runbook for slice 1 (issue #2). An Owner follows it
once to stand up a fresh instance — Supabase + R2 + secrets — then connects the
MCP server to their AI client.

The agent loop can't do any of these steps. They all require a human with
provider accounts and console access.

## What you'll have at the end

- A Postgres database (Supabase) with the pgvector extension and the principleDB
  schema applied.
- A Cloudflare R2 bucket holding original Sources (PDFs etc.) — empty until
  slice 3 lands the ingest pipeline that writes to it.
- An `.sandcastle/.env` file holding the provider secrets (Postgres, Anthropic, OpenAI, R2).
- An MCP server (`npm run mcp` or `principledb-mcp`) reachable over stdio JSON-RPC
  from your AI client.

## Steps

### 1. Supabase (Postgres + pgvector)

1. Create a project at <https://supabase.com>. Pick a region close to where you
   run your AI client.
2. In the Supabase dashboard → **Database → Extensions** — enable `vector` (the
   pgvector extension). The Drizzle migration creates the schema's vector columns
   against it.
3. **Database → Connection string → URI** — copy the *pooler* connection string
   (port `6543`). That's `DATABASE_URL` for the app.
4. Apply the migration. From a clone of this repo with `DATABASE_URL` set:

   ```bash
   npm install
   psql "$DATABASE_URL" -f drizzle/0000_sweet_master_mold.sql
   ```

   The migration's first statement is `CREATE EXTENSION IF NOT EXISTS vector` —
   harmless if you already enabled it via the UI.

5. (Optional) Verify: `psql "$DATABASE_URL" -c '\dt'` should list `source`,
   `principle`, `quote`, `review_candidate`.

### 2. Cloudflare R2 (blob lake)

The query store keeps only the Canon distillate. Original PDFs/audio stay in
R2 (ADR-0010). Slice 3 is the first to write to it, but the bucket and
credentials are provisioned now so that slice stays AFK.

1. Create an R2 bucket: Cloudflare dashboard → **R2 → Create bucket** (any name;
   `principledb` is the default in the env template).
2. **R2 → Manage API tokens** — create a token with **Object Read & Write** on
   that bucket. Save the Access Key ID + Secret Access Key.
3. From the same panel, note the **account ID** and the **S3 API endpoint**
   (`https://<account_id>.r2.cloudflarestorage.com`).

### 3. Provider API keys

The ingest pipeline splits across two vendors (ADR-0011):

- **Anthropic** (`ANTHROPIC_API_KEY`) — distil model. Default `claude-opus-4-8`.
  Get a key from <https://console.anthropic.com>.
- **OpenAI** (`OPENAI_API_KEY`) — embeddings. Default `text-embedding-3-small`
  at 1536 dim, pinned to match the schema. Get a key from
  <https://platform.openai.com/api-keys>.

To use different models, set `PRINCIPLEDB_DISTIL_MODEL` (any Claude model ID) or
`PRINCIPLEDB_EMBED_MODEL` (note: changing the embed model means a schema
migration to repin `EMBEDDING_DIM`; don't change casually).

### 4. Wire the env

Copy the template and fill in:

```bash
cp .sandcastle/.env.example .sandcastle/.env
$EDITOR .sandcastle/.env
```

Required for the MCP server to start:

- `DATABASE_URL`
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`

Required once slice 3 lands (set them now so re-runs don't break):

- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT`

If any of the three required vars are missing, the MCP server exits with a
single error listing every missing one.

### 5. Connect to your AI client

The server binds to stdio (JSON-RPC). Configure your AI client with a command
that runs it. From the repo root:

```bash
npm install
npm run mcp
```

For a Claude Desktop-style config (`claude_desktop_config.json`):

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

Once connected, the client advertises one tool — `search_principles` — which
returns atomic Principles with the Source's own words at the snapped span and a
derived label (page / timecode / position).

## Verify the wiring

A quick smoke test that doesn't require any seeded data:

```bash
npm run typecheck && npm test
```

That runs the in-memory wire-level tests (`src/mcp/server.test.ts`), the
schema-shape assertions, the relocation core, and — if `DATABASE_URL` is set —
the Postgres integration tests against an isolated schema in your dev DB.

## Portability

Core data lives in standard Postgres — `pg_dump` is the exit ramp. The R2
archive is independent (S3-API compatible — `rclone` or `mc` will copy it
elsewhere). Nothing about the data model is Supabase-specific beyond the
managed-Postgres convenience.
