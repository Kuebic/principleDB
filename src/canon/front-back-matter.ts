// Front/back-matter routing (issue #9).
//
// Real books have a structure: title-page / TOC / preface / foreword / ... → chapters →
// appendix / notes / index / bibliography. Distillation should treat each region
// differently — front matter is mostly editorial scaffolding (rarely contains atomic
// teaching claims), back matter is references and tooling around the text. The Canon
// keeps all three but tags each chunk's region so reading order is recoverable and a
// downstream caller can choose to skip non-body for distil if needed.
//
// Each chunk is routed by a combination of label pattern and ordinal position:
//   1. Label match: well-known front/back labels (case-insensitive, prefix-tolerant).
//   2. Ordinal carry-over: unrecognized chunks preceding the first body-labelled
//      chunk default to front; unrecognized chunks at-or-after the first back-labelled
//      chunk default to back.
//   3. Anything still unresolved is body.
//
// This is deliberately heuristic — the zettle vault has analogous behaviour for the same
// corpus. A future revision can lean on the bookmark tree directly when those signals
// are available.

import type { MarkerChunk } from './marker-sections';

export type SectionPosition = 'front' | 'body' | 'back';

export type PositionedChunk = MarkerChunk & { position: SectionPosition };

const FRONT_PATTERNS: ReadonlyArray<RegExp> = [
  /^title page$/,
  /^half[- ]?title$/,
  /^copyright$/,
  /^dedication$/,
  /^epigraph$/,
  /^table of contents$/,
  /^contents$/,
  /^toc$/,
  /^foreword$/,
  /^preface$/,
  /^acknowledgements?$/,
  /^acknowledgments?$/,
  /^introduction$/,
  /^prologue$/,
  /^front ?matter$/,
  /^colophon$/, // colophons sometimes appear in front, more often back; default front, label-wins below
];

const BACK_PATTERNS: ReadonlyArray<RegExp> = [
  /^afterword$/,
  /^epilogue$/,
  /^appendix(\b|[ :]|$)/,
  /^appendices$/,
  /^notes?$/,
  /^endnotes?$/,
  /^footnotes?$/,
  /^bibliography$/,
  /^references$/,
  /^glossary$/,
  /^index$/,
  /^indices$/,
  /^about the author$/,
  /^back ?matter$/,
];

// Strip leading chapter/section numbering and common prefixes so a label like
// "Chapter 1: The Wakening" or "2. Renewal" falls through to a body classification
// (no match against either pattern set).
function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/^chapter\s+[\divxlcdm]+[.:]?\s*/i, '')
    .replace(/^part\s+[\divxlcdm]+[.:]?\s*/i, '')
    .replace(/^[\divxlcdm]+\.\s*/i, '')
    .trim();
}

function matches(patterns: ReadonlyArray<RegExp>, label: string): boolean {
  return patterns.some((re) => re.test(label));
}

function classifyByLabel(label: string): SectionPosition | null {
  const norm = normalizeLabel(label);
  if (matches(FRONT_PATTERNS, norm)) return 'front';
  if (matches(BACK_PATTERNS, norm)) return 'back';
  // Also try the raw lowercase label (before chapter-prefix stripping) — a section
  // titled "Chapter 1" should still classify as body, but "appendix" itself remains
  // back even if `normalizeLabel` strips a numeric prefix off "1. Appendix".
  const lower = label.toLowerCase().trim();
  if (matches(FRONT_PATTERNS, lower)) return 'front';
  if (matches(BACK_PATTERNS, lower)) return 'back';
  return null;
}

export function routeSectionPositions(chunks: MarkerChunk[]): PositionedChunk[] {
  const labelTags = chunks.map((c) => classifyByLabel(c.sectionLabel));

  // Ordinal carry-over anchors:
  //   - everything at or before the last front-labelled chunk is in the front zone
  //   - everything at or after the first back-labelled chunk is in the back zone
  //   - everything else (and the whole list, if neither zone is anchored) is body
  let lastFrontIndex = -1;
  let firstBackIndex = -1;
  for (let i = 0; i < labelTags.length; i++) {
    if (labelTags[i] === 'front') lastFrontIndex = i;
    if (labelTags[i] === 'back' && firstBackIndex === -1) firstBackIndex = i;
  }

  return chunks.map((c, i) => {
    const tag = labelTags[i];
    if (tag) return { ...c, position: tag };
    if (lastFrontIndex !== -1 && i <= lastFrontIndex) return { ...c, position: 'front' };
    if (firstBackIndex !== -1 && i >= firstBackIndex) return { ...c, position: 'back' };
    return { ...c, position: 'body' };
  });
}
