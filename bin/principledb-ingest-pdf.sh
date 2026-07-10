#!/usr/bin/env bash
# principleDB PDF ingest launcher. Loads secrets from .sandcastle/.env so they
# stay OUT of shell history, then execs the `ingest:pdf` CLI forwarding all
# args. Mirrors bin/principledb-ingest-dir.sh.
#
# In addition to the dir-walk env (DATABASE_URL + OPENAI_API_KEY +
# CLAUDE_CODE_OAUTH_TOKEN/ANTHROPIC_API_KEY), PDF ingest needs:
#   - R2_* (blob lake) unless you pass --no-archive
#   - MARKER_CPU_SCRIPT (or MARKER_REMOTE_SCRIPT with --target remote-gpu):
#     path to the zettle Marker wrapper that prints page-anchored markdown for
#     one PDF on stdout (ADR-0010). Put these in .sandcastle/.env too.
#
# Usage:
#   bin/principledb-ingest-pdf.sh <file.pdf|dir> --author "Sun Myung Moon" \
#       [--title "Cham Bumo Gyeong"] [--kind book] [--target cpu|remote-gpu] \
#       [--dry-run] [--no-archive]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

if [[ ! -f ./.sandcastle/.env ]]; then
  echo "principledb-ingest-pdf: missing ./.sandcastle/.env (need DATABASE_URL, OPENAI_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, R2_*, MARKER_CPU_SCRIPT)" >&2
  exit 1
fi

set -a; . ./.sandcastle/.env; set +a

exec ./node_modules/.bin/tsx bin/principledb-ingest-pdf.ts "$@"
