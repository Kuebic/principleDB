#!/usr/bin/env bash
# principleDB corpus ingest launcher (directory walk). Loads secrets from
# .sandcastle/.env so they stay OUT of shell history / client config, then execs
# the `ingest:dir` CLI forwarding all args. Mirrors bin/principledb-mcp-stdio.sh.
#
# The dir walker needs DATABASE_URL + OPENAI_API_KEY (embeddings) +
# CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY (distil). Distil defaults to Haiku
# — the OAuth subscription token is Haiku-entitled over the API, so do NOT pass
# `--model opus` unless a real API key with Opus entitlement is in the env.
#
# Portable: repo root is derived from this script's own location.
#
# Usage:
#   bin/principledb-ingest-dir.sh <corpus-path> [--kind book] [--dry-run] \
#       [--model haiku|opus] [--phase distil|dedup] [--limit N]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

if [[ ! -f ./.sandcastle/.env ]]; then
  echo "principledb-ingest: missing ./.sandcastle/.env (need DATABASE_URL, OPENAI_API_KEY, CLAUDE_CODE_OAUTH_TOKEN)" >&2
  exit 1
fi

set -a; . ./.sandcastle/.env; set +a

exec ./node_modules/.bin/tsx bin/principledb-ingest-dir.ts "$@"
