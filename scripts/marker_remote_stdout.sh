#!/usr/bin/env bash
# Extract ONE pdf to page-anchored markdown on STDOUT by running Marker on the
# remote CUDA GPU box. The stdout-emitting counterpart to zettle's
# ingest_remote.sh (which rsyncs extracted FILES back): ships marker_stdout.py +
# the PDF to $ZETTLE_GPU_HOST via rsync, runs it there on the GPU, and streams
# the markdown back on our stdout. All ssh/rsync chatter goes to stderr so the
# captured stream stays pure markdown.
#
# principleDB's MarkerCliExtractor points MARKER_REMOTE_SCRIPT here and invokes
# it under `--target remote-gpu`. First run per box downloads the marker+torch
# CUDA stack remotely (slow once, cached after).
set -euo pipefail

PDF="${1:?usage: marker_remote_stdout.sh <pdf>}"
HOST="${ZETTLE_GPU_HOST:-zettle-gpu}"
SCRATCH="${ZETTLE_GPU_SCRATCH:-zettle-scratch}"
UV="${ZETTLE_GPU_UV:-uv}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="$(basename "$PDF")"

# Stage the script + PDF (all to stderr — stdout is reserved for markdown).
{
  ssh "$HOST" "mkdir -p '$SCRATCH'"
  rsync -a "$REPO/scripts/marker_stdout.py" "$HOST:$SCRATCH/marker_stdout.py"
  rsync -a "$PDF" "$HOST:$SCRATCH/$BASE"
} 1>&2

# Extract on the GPU. marker_stdout.py prints markdown to stdout (which ssh
# forwards to ours) and its own logs to stderr (which ssh forwards to ours).
exec ssh "$HOST" "cd '$SCRATCH' && MARKER_DEVICE=gpu $UV run --script marker_stdout.py '$BASE'"
