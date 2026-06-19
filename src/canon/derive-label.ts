// ADR-0009: the locator's IDENTITY is the offset span; the human-readable LABEL is
// derived from the Source's structureMap on read. PDF → page N / pages N–M (a span
// crossing a break falls out as a range, no special case). Transcript → timecode at
// span start. Text-headings → enclosing heading. Otherwise → "~NN% in" position
// fraction.

import type { Span, StructureMap } from './types';

// Entries in a structureMap are assumed to be sorted by offset ascending — so the
// last entry with offset ≤ target is the one that covers the target.
function lastAtOrBefore<T extends { offset: number }>(
  entries: ReadonlyArray<T>,
  offset: number,
): T | undefined {
  let result: T | undefined;
  for (const e of entries) {
    if (e.offset > offset) break;
    result = e;
  }
  return result;
}

export function deriveLabel(structureMap: StructureMap, span: Span, textLength: number): string {
  if (structureMap.kind === 'pdf-pages') {
    const start = lastAtOrBefore(structureMap.pages, span.start);
    const end = lastAtOrBefore(structureMap.pages, Math.max(span.start, span.end - 1));
    if (!start || !end) return '';
    if (start.page === end.page) return `page ${start.page}`;
    return `pages ${start.page}–${end.page}`;
  }

  if (structureMap.kind === 'transcript-timecodes') {
    return lastAtOrBefore(structureMap.codes, span.start)?.timecode ?? '';
  }

  if (structureMap.kind === 'text-headings') {
    return lastAtOrBefore(structureMap.headings, span.start)?.heading ?? '';
  }

  if (textLength <= 0) return '';
  const pct = Math.round((span.start / textLength) * 100);
  return `~${pct}% in`;
}
