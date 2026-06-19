// ADR-0009: the locator's IDENTITY is the offset span; the human-readable LABEL is
// derived from the Source's structureMap on read. PDF → page N / pages N–M (a span
// crossing a break falls out as a range, no special case). Transcript → timecode at
// span start. Text-headings → enclosing heading. Otherwise → "~NN% in" position
// fraction.

import type { Span, StructureMap } from './types';

export function deriveLabel(structureMap: StructureMap, span: Span, textLength: number): string {
  if (structureMap.kind === 'pdf-pages') {
    const pageOf = (offset: number): number | null => {
      let page: number | null = null;
      for (const p of structureMap.pages) {
        if (p.offset <= offset) page = p.page;
        else break;
      }
      return page;
    };
    const startPage = pageOf(span.start);
    const lastOffset = Math.max(span.start, span.end - 1);
    const endPage = pageOf(lastOffset);
    if (startPage === null || endPage === null) return '';
    if (startPage === endPage) return `page ${startPage}`;
    return `pages ${startPage}–${endPage}`;
  }

  if (structureMap.kind === 'transcript-timecodes') {
    let timecode: string | null = null;
    for (const t of structureMap.codes) {
      if (t.offset <= span.start) timecode = t.timecode;
      else break;
    }
    return timecode ?? '';
  }

  if (structureMap.kind === 'text-headings') {
    let heading: string | null = null;
    for (const h of structureMap.headings) {
      if (h.offset <= span.start) heading = h.heading;
      else break;
    }
    return heading ?? '';
  }

  if (textLength <= 0) return '';
  const pct = Math.round((span.start / textLength) * 100);
  return `~${pct}% in`;
}
