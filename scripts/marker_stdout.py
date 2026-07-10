#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = [
#   "marker-pdf[full]>=1.2",
# ]
# ///
# torch is left unpinned so uv pulls a stock PyPI wheel — it runs on CPU fine
# (TORCH_DEVICE=cpu below), which sidesteps the ROCm index/triton pinning the
# zettle laptop needs for *local GPU* accel. For speed, extract on the remote
# CUDA box (MARKER_DEVICE=gpu there) rather than tuning local AMD ROCm here.
"""marker_stdout.py — extract ONE pdf to page-anchored markdown on STDOUT.

The bridge principleDB's `MarkerCliExtractor` (src/canon/marker-cli.ts) expects:
`MARKER_CPU_SCRIPT` points here, the extractor runs `<script> <pdf>` and captures
stdout as the Marker artifact. This is the zettle `run_marker()` (scripts/
ingest_pdf.py) with two changes for that contract:
  1. `paginate_output=True` — so Marker emits `{N}------` page separators that
     `parseMarkerOutput` turns into the pdf-pages structureMap (→ "page N"
     citations, ADR-0009/0010).
  2. output goes to stdout, all diagnostics to stderr — so the captured stream
     is pure markdown.

Runs the whole PDF as one chunk (no bookmark splitting): the tparents scriptures
are already split into per-chapter PDFs, so each invocation is one small book
section — safe on CPU, no OOM risk that forces the sectioned large-book path.

Device: MARKER_DEVICE=cpu (default, safe on the 8 GB local card) or =gpu.

Self-test: MARKER_SELFTEST=1 emits a canned 2-page paginated fixture and exits
WITHOUT importing marker — so the end-to-end wiring (env → wrapper → stdout →
parseMarkerOutput → distil) can be validated before the multi-GB model download.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Canned page-anchored markdown matching Marker's `paginate_output` format
# (`{N}` + a dash run on its own line, per src/canon/marker.ts PAGE_ANCHOR_RE).
_SELFTEST = (
    "{0}------------------------------------------------\n\n"
    "Selftest page one. Grace precedes obedience.\n\n"
    "{1}------------------------------------------------\n\n"
    "Selftest page two. Service follows from love.\n"
)


def main(argv: list[str]) -> int:
    if os.environ.get("MARKER_SELFTEST"):
        sys.stdout.write(_SELFTEST)
        return 0

    if len(argv) < 1:
        print("usage: marker_stdout.py <pdf>", file=sys.stderr)
        return 2
    pdf_path = Path(argv[0]).resolve()
    if not pdf_path.is_file():
        print(f"error: {pdf_path} not found", file=sys.stderr)
        return 2

    # CPU is the safe default (any stock torch runs on it). Anything else leaves
    # torch to auto-detect the accelerator — CUDA on the remote GPU box.
    if os.environ.get("MARKER_DEVICE", "cpu").lower() == "cpu":
        os.environ["CUDA_VISIBLE_DEVICES"] = ""
        os.environ["TORCH_DEVICE"] = "cpu"

    print("marker_stdout: loading models...", file=sys.stderr)
    from marker.config.parser import ConfigParser
    from marker.converters.pdf import PdfConverter
    from marker.models import create_model_dict
    from marker.output import text_from_rendered

    cfg = ConfigParser({"output_format": "markdown", "paginate_output": True})
    converter = PdfConverter(
        config=cfg.generate_config_dict(),
        artifact_dict=create_model_dict(),
        processor_list=cfg.get_processors(),
        renderer=cfg.get_renderer(),
    )

    print(f"marker_stdout: extracting {pdf_path.name}...", file=sys.stderr)
    rendered = converter(str(pdf_path))
    text, _, _ = text_from_rendered(rendered)
    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
