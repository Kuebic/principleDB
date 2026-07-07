#!/usr/bin/env bash
# principleDB MCP server launcher for stdio MCP clients (Claude Code / Claude
# Desktop). Loads secrets from .sandcastle/.env so they stay OUT of the client's
# MCP config JSON, then execs the stdio JSON-RPC server.
#
# CRITICAL: the stdout of this process IS the JSON-RPC channel — nothing may
# print to it except the server. Env loading is redirected to stderr and the
# server binary is invoked directly (no npm/npx wrapper noise). Diagnostics from
# the server already go to stderr (see bin/principledb-mcp.ts).
#
# Portable: the repo root is derived from this script's own location, so the
# same file works regardless of where the client launches it from.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

if [[ ! -f ./.sandcastle/.env ]]; then
  echo "principledb-mcp: missing ./.sandcastle/.env (need DATABASE_URL, OPENAI_API_KEY)" >&2
  exit 1
fi

# Load env with any stray stdout redirected to stderr so it can't corrupt the
# JSON-RPC stream. Query-time the server needs DATABASE_URL + OPENAI_API_KEY;
# ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN only matter for resolve_review_item.
{ set -a; . ./.sandcastle/.env; set +a; } 1>&2

exec ./node_modules/.bin/tsx bin/principledb-mcp.ts
